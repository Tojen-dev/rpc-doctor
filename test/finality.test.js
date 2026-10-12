import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { finalityHeader, FinalityProbeError } from '../src/finality.js';
import { benchmark } from '../src/benchmark.js';
import { evaluateHealthPolicy } from '../src/health-policy.js';
import { serve, reply } from './helpers.js';

const hash = `0x${'AB'.repeat(32)}`;
const header = (number = '0x0') => ({ number, hash, transactions: ['SYNTHETIC_SECRET'], extra: 'SYNTHETIC_SECRET' });
const rpcError = code => ({ error: { code, message: 'SYNTHETIC_SECRET unsupported tag method not found', data: 'SYNTHETIC_SECRET' } });
const address = `0x${'ab'.repeat(20)}`;

const invalidHeaders = [null, [], 0, '', 'SYNTHETIC_SECRET', {}, { number: '0x0' }, { hash },
  ...[null, 0, '0X0', '0x', '0x00', '-0x1', '1', '0x1\n', '0xz', `0x1${'0'.repeat(64)}`, '0xf'.repeat(1000)].map(number => ({ ...header(), number })),
  ...[null, 0, '', '0x', '0x0', `0x${'00'.repeat(31)}`, `0x${'ab'.repeat(33)}`, hash + '\n', `0X${'ab'.repeat(32)}`, `0x${'gg'.repeat(32)}`].map(hash => ({ number: '0x0', hash }))];
test('finality header projection validates exact uint256 number and nonempty hash, discarding other fields', () => {
  for (const n of [0n, 9007199254740993n, 2n ** 256n - 1n]) {
    assert.deepEqual(finalityHeader(header(`0x${n.toString(16).toUpperCase()}`)), { number: n.toString(), hash: hash.toLowerCase() });
  }
  for (const value of invalidHeaders) assert.throws(() => finalityHeader(value), e => e.code === 'INVALID_RESULT' && !/SYNTHETIC_SECRET/.test(e.message));
});

test('programmatic finality option is boolean and rejected before RPC', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  for (const value of [null, 1, 0, 'true', 'false', [], {}]) await assert.rejects(benchmark(['http://127.0.0.1'], { finality: value }), FinalityProbeError);
});

test('GC during unfinished response bodies cannot defeat timeouts or suppress the second tag', () => {
  // A separate runtime makes forced GC available on both supported Node versions.
  // Before explicit reader cancellation, Node 22 can lose fetch's abort linkage
  // here and hang indefinitely after the first tag's headers have arrived.
  const script = `
    import assert from 'node:assert/strict';
    import { benchmark } from './src/benchmark.js';
    import { serve, reply } from './test/helpers.js';
    const tags = []; let collected = 0;
    const server = await serve((req, res) => {
      if (req.method !== 'eth_getBlockByNumber') return reply(res, '0x1');
      tags.push(req.params);
      res.writeHead(200); res.write('{"jsonrpc":"2.0",');
      setTimeout(() => { global.gc(); collected++; }, 30);
    });
    try {
      const report = await benchmark([server.url], { samples: 1, timeoutMs: 200, finality: true });
      assert.deepEqual(tags, [['safe', false], ['finalized', false]]);
      assert.equal(collected, 2);
      for (const f of Object.values(report.results[0].finality)) {
        assert.equal(f.error, 'TIMEOUT'); assert.equal(f.attempts, 1);
        assert.ok(f.durationMs >= 150);
      }
      assert.equal(report.results[0].status, 'healthy');
    } finally { await server.close(); }
  `;
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, response, status, error, kind, number] of [
  ['zero header', { result: header() }, 'found', null, null, '0'],
  ['large header', { result: header('0x20000000000001') }, 'found', null, null, '9007199254740993'],
  ['max header', { result: header(`0x${'f'.repeat(64)}`) }, 'found', null, null, (2n ** 256n - 1n).toString()],
  ['null', { result: null }, 'null', null, null, null],
  ['unavailable method', rpcError(-32601), 'unsupported', 'RPC_ERROR', 'method_unavailable', null],
  ['ambiguous invalid params', rpcError(-32602), 'error', 'RPC_ERROR', 'invalid_params', null],
  ...[-32000, -32005, -32603, 4444, 12345].map(code => [`other code ${code}`, rpcError(code), 'error', 'RPC_ERROR', 'other', null]),
  ['wrong ID', { id: 999, ...rpcError(-32601) }, 'error', 'INVALID_RESPONSE', null, null],
  ['string ID', { id: '3', result: header() }, 'error', 'INVALID_RESPONSE', null, null],
  ['wrong version', { jsonrpc: '1.0', ...rpcError(-32601) }, 'error', 'INVALID_RESPONSE', null, null],
  ['string code', rpcError('-32601'), 'error', 'INVALID_RESPONSE', null, null],
  ['missing message', { error: { code: -32601 } }, 'error', 'INVALID_RESPONSE', null, null],
  ['both result and error', { result: null, ...rpcError(-32601) }, 'error', 'INVALID_RESPONSE', null, null],
  ['neither result nor error', {}, 'error', 'INVALID_RESPONSE', null, null],
  ['malformed block', { result: header('0x01') }, 'error', 'INVALID_RESULT', null, null],
  ['invalid hash', { result: { number: '0x0', hash: null } }, 'error', 'INVALID_RESULT', null, null],
]) test(`loopback finality outcome: ${name}; finalized still runs`, async t => {
  const trace = [];
  const server = await serve((req, res) => {
    trace.push(req);
    if (req.method !== 'eth_getBlockByNumber') return reply(res, '0x1');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...(req.params[0] === 'safe' ? response : { result: header('0x2') }) }));
  }); t.after(server.close);
  const report = await benchmark([server.url + '/?SYNTHETIC_SECRET'], { samples: 1, finality: true });
  assert.deepEqual(trace, [
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
    { jsonrpc: '2.0', id: 3, method: 'eth_getBlockByNumber', params: ['safe', false] },
    { jsonrpc: '2.0', id: 4, method: 'eth_getBlockByNumber', params: ['finalized', false] },
  ]);
  const r = report.results[0]; const f = r.finality.safe;
  assert.deepEqual([f.status, f.error, f.rpcErrorKind, f.number, f.hash, f.attempts, f.skipReason],
    [status, error, kind, number, status === 'found' ? hash.toLowerCase() : null, 1, null]);
  assert.deepEqual([r.finality.finalized.status, r.finality.finalized.number], ['found', '2']); // Never compare tags or measured head.
  assert.equal(report.settings.finality, true); assert.equal(r.status, 'healthy'); assert.deepEqual(r.errors, {});
  assert.equal(evaluateHealthPolicy(report, { maxFailures: 0 }).passed, true);
  assert.ok(f.startedMs >= report.rounds[0].finishedMs); assert.ok(r.finality.finalized.startedMs >= f.finishedMs);
  assert.ok(report.durationMs >= report.finalityPhase.finishedMs);
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_SECRET|transactions|127\.0\.0\.1|rpcCode|message/);
});

for (const [name, send, expected] of [
  ['HTTP', (req, res) => res.writeHead(503).end('SYNTHETIC_SECRET'), 'HTTP_ERROR'],
  ['429', (req, res) => res.writeHead(429).end('SYNTHETIC_SECRET'), 'RATE_LIMITED'],
  ['malformed JSON', (req, res) => res.end('SYNTHETIC_SECRET'), 'INVALID_RESPONSE'],
  ['body limit', (req, res) => res.end(' '.repeat(1024 * 1024 + 1)), 'RESPONSE_TOO_LARGE'],
  ['whole-body timeout', (req, res) => { res.writeHead(200); res.write('{"jsonrpc":"2.0",'); }, 'TIMEOUT'],
  ['network', (req, res) => res.destroy(), 'NETWORK_ERROR'],
]) test(`finality transport failure: ${name}; both requests attempted separately`, async t => {
  const trace = [];
  const server = await serve((req, res) => {
    trace.push(req); return req.method === 'eth_getBlockByNumber' ? send(req, res) : reply(res, '0x1');
  }); t.after(server.close);
  const report = await benchmark([server.url], { samples: 1, timeoutMs: 200, finality: true });
  for (const f of Object.values(report.results[0].finality)) {
    assert.deepEqual([f.status, f.error, f.rpcErrorKind, f.number, f.hash, f.attempts], ['error', expected, null, null, null, 1]);
    if (expected === 'TIMEOUT') assert.ok(f.durationMs >= 150);
  }
  assert.deepEqual(trace.slice(-2).map(r => r.params), [['safe', false], ['finalized', false]]);
  assert.equal(report.results[0].status, 'healthy'); assert.deepEqual(report.results[0].errors, {});
  assert.equal(evaluateHealthPolicy(report, { maxFailures: 0 }).passed, true);
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_SECRET/);
});

test('fixed clocks prove all finality outcomes preserve earlier requests, metrics, strict policy and time boundaries across all H/C/L combinations', async t => {
  let now = 0; let trace; let blocks; let outcome;
  const RealDate = Date; const epoch = Date.parse('2026-10-12T00:00:00.000Z');
  t.mock.method(globalThis, 'Date', class extends RealDate { constructor(...args) { super(...(args.length ? args : [epoch + now])); } });
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const req = JSON.parse(init.body); const i = Number(new URL(url).pathname.slice(1)); trace.push({ i, ...req });
    const tag = req.method === 'eth_getBlockByNumber' && ['safe', 'finalized'].includes(req.params[0]);
    now += tag ? 50 : 10;
    const body = tag ? outcome : req.method === 'eth_getLogs' ? { result: [] }
      : req.method === 'eth_call' ? { result: '0x' } : req.method === 'eth_getBlockByNumber' ? rpcError(-32601)
        : req.method === 'eth_chainId' ? { result: '0x1' }
          : ++blocks[i] === (i === 0 ? 1 : 2) ? rpcError(-32000) : { result: i === 0 ? '0x100' : '0xfa' };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
  });
  for (let mask = 0; mask < 8; mask++) {
    let baseline; let baseTrace;
    for (const value of [undefined, { result: header() }, { result: null }, { result: [] }, rpcError(-32601), rpcError(-32602), rpcError(-32000)]) {
      now = 0; trace = []; blocks = [0, 0]; outcome = value;
      const report = await benchmark(['http://127.0.0.1/0', 'http://127.0.0.1/1'], {
        samples: 2, warmup: 1, concurrency: 1, intervalMs: 1, reference: 1, expectedChain: '1',
        ...(mask & 1 ? { historicalBlock: '0' } : {}), ...(mask & 2 ? { callTo: address, callData: '0x', callBlock: '0' } : {}),
        ...(mask & 4 ? { logsFrom: '0', logsTo: '0' } : {}), finality: value !== undefined,
      });
      report.healthPolicy = evaluateHealthPolicy(report, { maxFailures: 0 });
      if (value === undefined) { baseline = report; baseTrace = trace; continue; }
      const n = baseTrace.length;
      assert.equal(trace.length, n + 4); assert.deepEqual(trace.slice(0, n), baseTrace);
      assert.deepEqual(trace.slice(n).map(r => [r.i, r.id, r.params]), [[0, n + 1, ['safe', false]], [0, n + 2, ['finalized', false]], [1, n + 3, ['safe', false]], [1, n + 4, ['finalized', false]]]);
      assert.equal(report.durationMs, baseline.durationMs + 200);
      assert.equal(Date.parse(report.generatedAt), Date.parse(baseline.generatedAt) + 200); assert.equal(report.startedAt, baseline.startedAt);
      assert.deepEqual(report.finalityPhase, { startedMs: n * 10, finishedMs: n * 10 + 200, durationMs: 200 });
      assert.deepEqual(report.results.flatMap(r => Object.values(r.finality).map(f => f.durationMs)), [50, 50, 50, 50]);
      delete report.finalityPhase; delete report.settings.finality; report.results.forEach(r => delete r.finality);
      report.durationMs = baseline.durationMs; report.generatedAt = baseline.generatedAt; assert.deepEqual(report, baseline);
    }
  }
});

test('failed and mismatched handshakes skip both tags while all-sample-failed accepted endpoints attempt both', async t => {
  const trace = [];
  const servers = await Promise.all([0, 1, 2].map(i => serve((req, res) => {
    trace.push({ i, ...req });
    const body = i === 0 || req.method === 'eth_blockNumber' ? rpcError(-32601)
      : req.method === 'eth_chainId' ? { result: i === 1 ? '0x2' : '0x1' } : { result: null };
    res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
  })));
  t.after(() => Promise.all(servers.map(s => s.close())));
  const report = await benchmark(servers.map(s => s.url), { samples: 2, expectedChain: '1', finality: true });
  assert.deepEqual(report.results.map(r => r.status), ['unreachable', 'mismatch', 'unreachable']);
  for (const [i, reason] of ['handshake_failed', 'network_mismatch'].entries()) for (const tag of ['safe', 'finalized']) {
    assert.deepEqual(report.results[i].finality[tag], { status: 'skipped', attempts: 0, number: null, hash: null, error: null,
      rpcErrorKind: null, skipReason: reason, startedMs: null, finishedMs: null, durationMs: null });
  }
  assert.deepEqual(trace.filter(r => r.method === 'eth_getBlockByNumber').map(r => [r.i, r.params]), [[2, ['safe', false]], [2, ['finalized', false]]]);
  assert.equal(trace.length, 7); assert.equal(evaluateHealthPolicy(report, { maxFailures: 0 }).passed, false);
});

test('shared pool waits for complete bodies through every phase; tags sequential per endpoint with globally unique IDs', async t => {
  let active = 0; let maximum = 0; let samples = 0; let historical = 0; let calls = 0; let logs = 0;
  const safeDone = new Set(); const perEndpoint = new Set(); const trace = [];
  const servers = await Promise.all([0, 1, 2, 3].map(i => serve(async (req, res) => {
    assert.equal(perEndpoint.has(i), false); perEndpoint.add(i);
    active++; maximum = Math.max(maximum, active); trace.push({ i, ...req });
    const tag = req.method === 'eth_getBlockByNumber' && ['safe', 'finalized'].includes(req.params[0]);
    if (['eth_getBlockByNumber', 'eth_call', 'eth_getLogs'].includes(req.method)) assert.equal(samples, 8);
    if (['eth_call', 'eth_getLogs'].includes(req.method) || tag) assert.equal(historical, 4);
    if (req.method === 'eth_getLogs' || tag) assert.equal(calls, 4);
    if (tag) { assert.equal(logs, 4); assert.equal(req.params[1], false); }
    if (req.params[0] === 'finalized') assert.equal(safeDone.has(i), true);
    res.writeHead(200); res.write(`{"jsonrpc":"2.0","id":${req.id},"result":`);
    await new Promise(resolve => setTimeout(resolve, i === 0 ? 15 : 3)); active--; perEndpoint.delete(i);
    if (req.method === 'eth_blockNumber') samples++;
    if (req.method === 'eth_getBlockByNumber' && !tag) historical++;
    if (req.method === 'eth_call') calls++;
    if (req.method === 'eth_getLogs') logs++;
    if (req.params[0] === 'safe') safeDone.add(i);
    res.end(JSON.stringify(req.method === 'eth_getLogs' ? [] : req.method === 'eth_call' ? '0x' : req.method === 'eth_getBlockByNumber' ? null : '0x1') + '}');
  })));
  t.after(() => Promise.all(servers.map(s => s.close())));
  const report = await benchmark(servers.map(s => s.url), { samples: 2, concurrency: 2, historicalBlock: '0', callTo: address, callData: '0x', callBlock: '0', logsFrom: '0', logsTo: '0', finality: true });
  assert.equal(maximum, 2); assert.equal(trace.length, 32);
  assert.deepEqual(trace.map(r => r.id).sort((a, b) => a - b), Array.from({ length: 32 }, (_, i) => i + 1));
  for (let i = 0; i < 4; i++) assert.deepEqual(trace.slice(-8).filter(r => r.i === i).map(r => r.params), [['safe', false], ['finalized', false]]);
  assert.ok(report.finalityPhase.startedMs >= report.logsPhase.finishedMs);
  assert.ok(report.results.every(r => r.finality.safe.startedMs >= report.logsPhase.finishedMs && r.finality.finalized.startedMs >= r.finality.safe.finishedMs));
  assert.ok(report.results.every(r => r.finality.finalized.finishedMs <= report.finalityPhase.finishedMs));
  // Two individually rounded durations may exceed the rounded phase by 1 ms.
  assert.ok(report.finalityPhase.durationMs + 1 >= Math.max(...report.results.map(r => r.finality.safe.durationMs + r.finality.finalized.durationMs)));
});
