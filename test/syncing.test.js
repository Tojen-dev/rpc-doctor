import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { syncingProgress, SyncingProbeError } from '../src/syncing.js';
import { benchmark } from '../src/benchmark.js';
import { evaluateHealthPolicy } from '../src/health-policy.js';
import { serve, reply } from './helpers.js';

const fields = ['startingBlock', 'currentBlock', 'highestBlock'];
const progress = (a = '0x0', b = '0x1', c = '0x2') => ({ startingBlock: a, currentBlock: b, highestBlock: c });
const rpcError = code => ({ error: { code, message: 'SYNTHETIC_SECRET unsupported method', data: 'SYNTHETIC_SECRET' } });
const address = `0x${'ab'.repeat(20)}`;

test('syncing progress retains exact bounded counters and describes order without rejecting unusual estimates', () => {
  for (const [a, b, c, order] of [[0n, 0n, 0n, 'nondecreasing'], [0n, 9007199254740993n, 2n ** 256n - 1n, 'nondecreasing'],
    [5n, 3n, 2n, 'out_of_order'], [2n, 1n, 3n, 'out_of_order'], [0n, 3n, 2n, 'out_of_order'], [2n, 2n, 2n, 'nondecreasing']]) {
    const value = { ...progress(...[a, b, c].map(n => `0x${n.toString(16).toUpperCase()}`)), knownStates: 'SYNTHETIC_SECRET', client: { secret: 'SYNTHETIC_SECRET' } };
    assert.deepEqual(syncingProgress(value), { startingBlock: a.toString(), currentBlock: b.toString(), highestBlock: c.toString(), heightOrder: order });
  }
  for (const value of [true, false, null, [], 'false', 0, 1, {}, Object.create(progress())]) assert.throws(() => syncingProgress(value), e => e.code === 'INVALID_RESULT');
  for (const key of fields) {
    const missing = progress(); delete missing[key]; assert.throws(() => syncingProgress(missing), e => e.code === 'INVALID_RESULT');
    for (const value of [undefined, null, true, 0, 1n, [], {}, '', '0x', '0X0', '0x00', '0x01', '0x1\n', ' 0x1', '-0x1', '0xg', '1', '1e2', 'latest', `0x1${'0'.repeat(64)}`, 'f'.repeat(10000)]) {
      assert.throws(() => syncingProgress({ ...progress(), [key]: value }), e => e.code === 'INVALID_RESULT' && !/SYNTHETIC_SECRET/.test(e.message));
    }
  }
});

test('programmatic syncing option rejects non-booleans before RPC', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  for (const value of [null, 0, 1, 'true', 'false', [], {}]) await assert.rejects(benchmark(['http://127.0.0.1'], { syncing: value }), SyncingProbeError);
});

for (const [name, response, status, error, state, heights, order] of [
  ['false', { result: false }, 'not_syncing', null, false, [null, null, null], null],
  ['progress with extras', { result: { ...progress(), unknown: 'SYNTHETIC_SECRET', knownStates: 'SYNTHETIC_SECRET' }, extra: 'SYNTHETIC_SECRET' }, 'syncing', null, true, ['0', '1', '2'], 'nondecreasing'],
  ['zero counters', { result: progress('0x0', '0x0', '0x0') }, 'syncing', null, true, ['0', '0', '0'], 'nondecreasing'],
  ['large counters', { result: progress('0x0', '0x20000000000001', `0x${'F'.repeat(64)}`) }, 'syncing', null, true, ['0', '9007199254740993', (2n ** 256n - 1n).toString()], 'nondecreasing'],
  ['unusual order', { result: progress('0x3', '0x1', '0x0') }, 'syncing', null, true, ['3', '1', '0'], 'out_of_order'],
  ...[true, null, [], 'false', 0, {}, { startingBlock: '0x0' }, progress('0x00'), progress('0x0', '0x1', `0x1${'0'.repeat(64)}`)].map((value, i) => [`invalid result ${i}`, { result: value }, 'error', 'INVALID_RESULT', null, [null, null, null], null]),
  ['unsupported', rpcError(-32601), 'unsupported', 'RPC_ERROR', null, [null, null, null], null],
  ...[-32602, -32603, -32000, -32005, 4444].map(code => [`RPC ${code}`, rpcError(code), 'error', 'RPC_ERROR', null, [null, null, null], null]),
  ...[
    { id: 999, ...rpcError(-32601) }, { id: '3', result: false }, { jsonrpc: '1.0', result: false },
    rpcError('-32601'), { error: { code: -32601 } }, { result: false, ...rpcError(-32601) }, {},
  ].map((value, i) => [`malformed envelope ${i}`, value, 'error', 'INVALID_RESPONSE', null, [null, null, null], null]),
]) test(`loopback syncing: ${name}`, async t => {
  const trace = [];
  const server = await serve((req, res) => {
    trace.push(req); if (req.method !== 'eth_syncing') return reply(res, '0x1');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...response }));
  }); t.after(server.close);
  const report = await benchmark([server.url + '/?SYNTHETIC_SECRET'], { samples: 1, syncing: true });
  assert.deepEqual(trace, [
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
    { jsonrpc: '2.0', id: 3, method: 'eth_syncing', params: [] },
  ]);
  const r = report.results[0]; const s = r.syncing;
  assert.deepEqual([s.status, s.error, s.isSyncing, fields.map(k => s[k]), s.heightOrder, s.attempts, s.skipReason], [status, error, state, heights, order, 1, null]);
  assert.equal(report.settings.syncing, true); assert.equal(r.status, 'healthy'); assert.deepEqual(r.errors, {}); assert.equal(r.successes, 1);
  assert.equal(evaluateHealthPolicy(report, { maxFailures: 0 }).passed, true);
  assert.ok(s.startedMs >= report.rounds[0].finishedMs); assert.ok(s.finishedMs <= report.syncingPhase.finishedMs); assert.ok(report.durationMs >= report.syncingPhase.finishedMs);
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_SECRET|knownStates|unknown|127\.0\.0\.1|rpcCode|message/);
});

for (const [name, send, expected] of [
  ['HTTP 503', (req, res) => res.writeHead(503).end('SYNTHETIC_SECRET'), 'HTTP_ERROR'],
  ['429', (req, res) => res.writeHead(429).end('SYNTHETIC_SECRET'), 'RATE_LIMITED'],
  ['malformed JSON', (req, res) => res.end('SYNTHETIC_SECRET'), 'INVALID_RESPONSE'],
  ['body limit', (req, res) => res.end(' '.repeat(1024 * 1024 + 1)), 'RESPONSE_TOO_LARGE'],
  ['headers timeout', () => {}, 'TIMEOUT'],
  ['body timeout', (req, res) => { res.writeHead(200); res.write('{"jsonrpc":"2.0",'); }, 'TIMEOUT'],
  ['network', (req, res) => res.destroy(), 'NETWORK_ERROR'],
]) test(`syncing transport: ${name}`, async t => {
  let count = 0;
  const server = await serve((req, res) => { if (req.method !== 'eth_syncing') return reply(res, '0x1'); count++; send(req, res); }); t.after(server.close);
  const report = await benchmark([server.url], { samples: 1, timeoutMs: 200, syncing: true });
  const s = report.results[0].syncing;
  assert.deepEqual([s.status, s.error, s.isSyncing, ...fields.map(k => s[k]), s.heightOrder, s.attempts], ['error', expected, null, null, null, null, null, 1]);
  assert.equal(count, 1); assert.equal(report.results[0].status, 'healthy'); assert.deepEqual(report.results[0].errors, {});
  assert.equal(evaluateHealthPolicy(report, { maxFailures: 0 }).passed, true);
  if (expected === 'TIMEOUT') assert.ok(s.durationMs >= 150);
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_SECRET/);
});

test('syncing body timeout still settles after forced GC', () => {
  const script = `
    import assert from 'node:assert/strict'; import { benchmark } from './src/benchmark.js'; import { serve, reply } from './test/helpers.js';
    let collected = false; const server = await serve((req, res) => {
      if (req.method !== 'eth_syncing') return reply(res, '0x1');
      res.writeHead(200); res.write('{"jsonrpc":"2.0",'); setTimeout(() => { global.gc(); collected = true; }, 30);
    });
    try {
      const report = await benchmark([server.url], { samples: 1, timeoutMs: 200, syncing: true });
      assert.equal(collected, true); assert.equal(report.results[0].syncing.error, 'TIMEOUT'); assert.equal(report.results[0].syncing.isSyncing, null);
      assert.equal(report.results[0].status, 'healthy');
    } finally { await server.close(); }
  `;
  const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5000 });
  assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stderr);
});

test('fixed clocks preserve all prior H/C/L/F combinations, requests, metrics, strict decisions and timestamps', async t => {
  let now = 0; let trace; let blocks; let outcome;
  const RealDate = Date; const epoch = Date.parse('2026-10-13T00:00:00.000Z');
  t.mock.method(globalThis, 'Date', class extends RealDate { constructor(...args) { super(...(args.length ? args : [epoch + now])); } });
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const req = JSON.parse(init.body); const i = Number(new URL(url).pathname.slice(1)); trace.push({ i, ...req }); now += req.method === 'eth_syncing' ? 50 : 10;
    const body = req.method === 'eth_syncing' ? outcome : req.method === 'eth_getLogs' ? { result: [] }
      : req.method === 'eth_call' ? { result: '0x' } : req.method === 'eth_getBlockByNumber' ? rpcError(-32601)
        : req.method === 'eth_chainId' ? { result: '0x1' }
          : ++blocks[i] === (i === 0 ? 1 : 2) ? rpcError(-32000) : { result: i === 0 ? '0x100' : '0xfa' };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
  });
  for (let mask = 0; mask < 16; mask++) {
    let baseline; let baseTrace;
    for (const value of [undefined, { result: false }, { result: progress() }, { result: progress('0x2', '0x1', '0x0') }, { result: null }, rpcError(-32601), rpcError(-32602), rpcError(-32000)]) {
      now = 0; trace = []; blocks = [0, 0]; outcome = value;
      const report = await benchmark(['http://127.0.0.1/0', 'http://127.0.0.1/1'], {
        samples: 2, warmup: 1, concurrency: 1, intervalMs: 1, reference: 1, expectedChain: '1',
        ...(mask & 1 ? { historicalBlock: '0' } : {}), ...(mask & 2 ? { callTo: address, callData: '0x', callBlock: '0' } : {}),
        ...(mask & 4 ? { logsFrom: '0', logsTo: '0' } : {}), ...(mask & 8 ? { finality: true } : {}),
        ...(value === undefined ? {} : { syncing: true }),
      });
      report.healthPolicy = evaluateHealthPolicy(report, { maxFailures: 0 });
      if (value === undefined) { baseline = report; baseTrace = trace; continue; }
      const n = baseTrace.length;
      assert.equal(trace.length, n + 2); assert.deepEqual(trace.slice(0, n), baseTrace);
      assert.deepEqual(trace.slice(n), [0, 1].map(i => ({ i, jsonrpc: '2.0', id: n + i + 1, method: 'eth_syncing', params: [] })));
      assert.equal(report.durationMs, baseline.durationMs + 100); assert.equal(Date.parse(report.generatedAt), Date.parse(baseline.generatedAt) + 100); assert.equal(report.startedAt, baseline.startedAt);
      assert.deepEqual(report.syncingPhase, { startedMs: n * 10, finishedMs: n * 10 + 100, durationMs: 100 });
      assert.deepEqual(report.results.map(r => r.syncing.durationMs), [50, 50]);
      delete report.syncingPhase; delete report.settings.syncing; report.results.forEach(r => delete r.syncing);
      report.durationMs = baseline.durationMs; report.generatedAt = baseline.generatedAt; assert.deepEqual(report, baseline);
    }
  }
});

test('failed/mismatched handshake skips; accepted all-sample-failed endpoints still attempt syncing once', async t => {
  const trace = [];
  const servers = await Promise.all([0, 1, 2].map(i => serve((req, res) => {
    trace.push({ i, ...req }); const body = i === 0 || req.method === 'eth_blockNumber' ? rpcError(-32601)
      : req.method === 'eth_chainId' ? { result: i === 1 ? '0x2' : '0x1' } : { result: false };
    res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
  })));
  t.after(() => Promise.all(servers.map(s => s.close())));
  const report = await benchmark(servers.map(s => s.url), { samples: 2, expectedChain: '1', syncing: true });
  assert.deepEqual(report.results.map(r => r.status), ['unreachable', 'mismatch', 'unreachable']);
  for (const [i, reason] of ['handshake_failed', 'network_mismatch'].entries()) assert.deepEqual(report.results[i].syncing, {
    status: 'skipped', attempts: 0, isSyncing: null, startingBlock: null, currentBlock: null, highestBlock: null, heightOrder: null,
    error: null, skipReason: reason, startedMs: null, finishedMs: null, durationMs: null,
  });
  assert.deepEqual(trace.filter(r => r.method === 'eth_syncing').map(r => [r.i, r.params]), [[2, []]]);
  assert.equal(trace.length, 6); assert.equal(report.results[2].syncing.isSyncing, false); assert.equal(evaluateHealthPolicy(report, { maxFailures: 0 }).passed, false);
});

test('shared pool enforces complete-body barriers after all earlier phases, unique IDs and one syncing request per endpoint', async t => {
  const counts = { eth_chainId: 0, eth_blockNumber: 0, historical: 0, eth_call: 0, eth_getLogs: 0, finality: 0, eth_syncing: 0 };
  let active = 0; let maximum = 0; const activeEndpoints = new Set(); const trace = [];
  const servers = await Promise.all([0, 1, 2, 3].map(i => serve(async (req, res) => {
    assert.equal(activeEndpoints.has(i), false); activeEndpoints.add(i); active++; maximum = Math.max(maximum, active); trace.push({ i, ...req });
    const kind = req.method === 'eth_getBlockByNumber' ? ['safe', 'finalized'].includes(req.params[0]) ? 'finality' : 'historical' : req.method;
    if (req.method === 'eth_syncing') assert.deepEqual(counts, { eth_chainId: 4, eth_blockNumber: 8, historical: 4, eth_call: 4, eth_getLogs: 4, finality: 8, eth_syncing: counts.eth_syncing });
    res.writeHead(200); res.write(`{"jsonrpc":"2.0","id":${req.id},"result":`);
    await new Promise(resolve => setTimeout(resolve, i === 0 ? 15 : 3)); active--; activeEndpoints.delete(i); counts[kind]++;
    res.end(JSON.stringify(req.method === 'eth_syncing' ? false : req.method === 'eth_getLogs' ? [] : req.method === 'eth_call' ? '0x' : req.method === 'eth_getBlockByNumber' ? null : '0x1') + '}');
  })));
  t.after(() => Promise.all(servers.map(s => s.close())));
  const report = await benchmark(servers.map(s => s.url), { samples: 2, concurrency: 2, historicalBlock: '0', callTo: address, callData: '0x', callBlock: '0', logsFrom: '0', logsTo: '0', finality: true, syncing: true });
  assert.equal(maximum, 2); assert.equal(trace.length, 36); assert.equal(counts.eth_syncing, 4);
  assert.deepEqual(trace.map(r => r.id).sort((a, b) => a - b), Array.from({ length: 36 }, (_, i) => i + 1));
  assert.deepEqual(trace.slice(-4).map(r => [r.i, r.method, r.params]), [0, 1, 2, 3].map(i => [i, 'eth_syncing', []]));
  assert.ok(report.syncingPhase.startedMs >= report.finalityPhase.finishedMs);
  assert.ok(report.results.every(r => r.syncing.startedMs >= report.finalityPhase.finishedMs && r.syncing.finishedMs <= report.syncingPhase.finishedMs));
});
