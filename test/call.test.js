import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCallOptions, callReturnBytes } from '../src/call.js';
import { benchmark } from '../src/benchmark.js';
import { evaluateHealthPolicy } from '../src/health-policy.js';
import { serve, reply } from './helpers.js';

const to = `0x${'ab'.repeat(20)}`;
const options = { callTo: to, callData: '0xDEadBeEF', callBlock: '9007199254740993' };
const params = [{ to, input: '0xdeadbeef', gas: '0x186a0', value: '0x0' }, '0x20000000000001'];
const rpcError = code => ({ error: { code, message: 'SYNTHETIC_SECRET method not found execution reverted', data: '0xfeedbeef' } });
const hash = `0x${'ab'.repeat(32)}`;

test('call input requires the full bounded triplet and exact unsigned block grammar', () => {
  assert.equal(parseCallOptions(), undefined);
  assert.deepEqual(parseCallOptions({ ...options, callTo: `0x${'AB'.repeat(20)}` }), { to, input: '0xdeadbeef', block: 9007199254740993n });
  for (const value of ['0', '0x0', '0xF', '15', options.callBlock, '0x20000000000001', (2n ** 256n - 1n).toString(), `0x${'F'.repeat(64)}`]) {
    assert.equal(parseCallOptions({ ...options, callBlock: value }).block, BigInt(value));
  }
  for (const data of ['0x', '0x00', `0x${'FF'.repeat(4096)}`]) {
    assert.equal(parseCallOptions({ ...options, callData: data }).input, data.toLowerCase());
    assert.equal(callReturnBytes(data), (data.length - 2) / 2);
  }
  for (const key of Object.keys(options)) {
    const missing = { ...options }; delete missing[key];
    assert.throws(() => parseCallOptions(missing), /together/);
    assert.throws(() => parseCallOptions({ [key]: options[key] }), /together/);
  }
  for (const [key, values] of [
    ['callTo', [null, 1, '', '0x', `0x${'ab'.repeat(19)}`, `0x${'ab'.repeat(21)}`, to + '\n', to.replace('0x', '0X'), 'SYNTHETIC_SECRET']],
    ['callData', [null, 1, '', '0X', '0x0', '0xgg', '0x00\n', ' 0x', `0x${'ff'.repeat(4097)}`, 'SYNTHETIC_SECRET']],
    ['callBlock', [null, 0, 1n, '', ' ', '0\n', '+1', '-1', '01', '0x01', '0x', '0X1', '1.0', '1e3', 'latest', 'earliest', 'pending', 'safe', 'finalized', '9'.repeat(79), (2n ** 256n).toString(), `0x1${'0'.repeat(64)}`, 'SYNTHETIC_SECRET']],
  ]) for (const value of values) {
    assert.throws(() => parseCallOptions({ ...options, [key]: value }), error => error.name === 'Error' && !/SYNTHETIC_SECRET/.test(error.message));
  }
  for (const data of [null, {}, [], 0, true, '', '0X00', '0x0', '0xgg', '0x00\n', ' 0x', `0x${'ff'.repeat(4097)}`]) {
    assert.throws(() => callReturnBytes(data), error => error.code === 'INVALID_RESULT');
  }
});

for (const [name, response, status, error, bytes] of [
  ['empty success', { result: '0x' }, 'success', null, 0],
  ['normal success with unknown envelope fields', { result: '0xABcd', unknown: 'SYNTHETIC_SECRET' }, 'success', null, 2],
  ['exact return boundary', { result: `0x${'ff'.repeat(4096)}` }, 'success', null, 4096],
  ['oversize return', { result: `0x${'ff'.repeat(4097)}` }, 'error', 'INVALID_RESULT', null],
  ['null', { result: null }, 'error', 'INVALID_RESULT', null],
  ['odd return', { result: '0x0' }, 'error', 'INVALID_RESULT', null],
  ['nonhex return', { result: 'SYNTHETIC_SECRET' }, 'error', 'INVALID_RESULT', null],
  ['object return', { result: { data: '0x', secret: 'SYNTHETIC_SECRET' } }, 'error', 'INVALID_RESULT', null],
  ['method missing', rpcError(-32601), 'unsupported', 'RPC_ERROR', null],
  ['revert code', rpcError(3), 'error', 'RPC_ERROR', null],
  ['invalid params', rpcError(-32602), 'error', 'RPC_ERROR', null],
  ['generic RPC error', rpcError(-32000), 'error', 'RPC_ERROR', null],
  ['pruned state', rpcError(4444), 'error', 'RPC_ERROR', null],
  ['string error code', rpcError('-32601'), 'error', 'INVALID_RESPONSE', null],
  ['missing message', { error: { code: -32601 } }, 'error', 'INVALID_RESPONSE', null],
  ['wrong ID', { id: 999, ...rpcError(-32601) }, 'error', 'INVALID_RESPONSE', null],
  ['wrong version', { jsonrpc: '1.0', result: '0x' }, 'error', 'INVALID_RESPONSE', null],
  ['both result and error', { result: '0x', ...rpcError(-32601) }, 'error', 'INVALID_RESPONSE', null],
  ['neither result nor error', {}, 'error', 'INVALID_RESPONSE', null],
]) test(`loopback call outcome: ${name}`, async t => {
  const trace = [];
  const server = await serve((req, res) => {
    trace.push(req);
    if (req.method !== 'eth_call') return reply(res, '0x1');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...response }));
  }); t.after(server.close);
  const report = await benchmark([server.url + '/?SYNTHETIC_SECRET'], { samples: 1, ...options });
  assert.deepEqual(trace, [
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
    { jsonrpc: '2.0', id: 3, method: 'eth_call', params },
  ]);
  assert.deepEqual(report.settings.call, { to, block: options.callBlock, gas: 100000, value: '0', inputBytes: 4 });
  const r = report.results[0];
  assert.deepEqual([r.call.status, r.call.error, r.call.returnBytes, r.call.attempts, r.call.skipReason], [status, error, bytes, 1, null]);
  assert.equal(r.status, 'healthy'); assert.equal(r.successes, 1); assert.deepEqual(r.errors, {});
  assert.equal(evaluateHealthPolicy(report, { maxFailures: 0 }).passed, true);
  assert.ok(r.call.startedMs >= report.rounds[0].finishedMs);
  assert.ok(report.durationMs >= report.callPhase.finishedMs);
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_SECRET|deadbeef|feedbeef|unknown|127\.0\.0\.1/);
});

for (const [name, send, expected] of [
  ['HTTP', (req, res) => res.writeHead(500).end('SYNTHETIC_SECRET'), 'HTTP_ERROR'],
  ['429', (req, res) => res.writeHead(429).end('SYNTHETIC_SECRET'), 'RATE_LIMITED'],
  ['malformed JSON', (req, res) => res.end('SYNTHETIC_SECRET'), 'INVALID_RESPONSE'],
  ['1 MiB body cap', (req, res) => res.end(' '.repeat(1024 * 1024 + 1)), 'RESPONSE_TOO_LARGE'],
  ['body timeout', (req, res) => { res.writeHead(200); res.write('{"jsonrpc":"2.0",'); }, 'TIMEOUT'],
  ['network', (req, res) => res.destroy(), 'NETWORK_ERROR'],
]) test(`call transport failure stays separate: ${name}`, async t => {
  const server = await serve((req, res) => req.method === 'eth_call' ? send(req, res) : reply(res, '0x1'));
  t.after(server.close);
  const report = await benchmark([server.url], { ...options, samples: 1, timeoutMs: 200 });
  const r = report.results[0];
  assert.equal(r.call.status, 'error'); assert.equal(r.call.error, expected); assert.equal(r.call.returnBytes, null);
  assert.equal(r.call.attempts, 1); assert.equal(r.status, 'healthy'); assert.deepEqual(r.errors, {});
  assert.equal(evaluateHealthPolicy(report, { maxFailures: 0 }).passed, true);
  if (expected === 'TIMEOUT') assert.ok(r.call.durationMs >= 150);
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_SECRET/);
});

test('all call outcomes preserve baseline and historical metrics, strict policy and requests under fixed time', async t => {
  let now = 0; let trace; let blocks; let outcome;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const req = JSON.parse(init.body); const i = Number(new URL(url).pathname.slice(1)); trace.push({ i, ...req });
    now += req.method === 'eth_call' ? 50 : 10;
    const body = req.method === 'eth_call' ? outcome
      : req.method === 'eth_getBlockByNumber' ? (i === 0 ? { result: { number: '0x0', hash } } : rpcError(-32601))
        : req.method === 'eth_chainId' ? { result: '0x1' }
          : ++blocks[i] === (i === 0 ? 1 : 2) ? rpcError(-32000) : { result: i === 0 ? '0x100' : '0xfa' };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
  });
  for (const historical of [false, true]) {
    let baseline; let baseTrace;
    for (const value of [undefined, { result: '0x' }, { result: '0xff' }, { result: null }, rpcError(-32601), rpcError(3)]) {
      now = 0; trace = []; blocks = [0, 0]; outcome = value;
      const report = await benchmark(['http://127.0.0.1/0', 'http://127.0.0.1/1'], {
        samples: 2, warmup: 1, concurrency: 1, intervalMs: 1, reference: 1, expectedChain: '1',
        ...(historical ? { historicalBlock: '0' } : {}), ...(value === undefined ? {} : options),
      });
      report.healthPolicy = evaluateHealthPolicy(report, { maxFailures: 0 });
      delete report.startedAt; delete report.generatedAt;
      if (value === undefined) { baseline = report; baseTrace = trace; continue; }
      const n = historical ? 10 : 8;
      assert.equal(trace.length, n + 2); assert.deepEqual(trace.slice(0, n), baseTrace);
      assert.deepEqual(trace.slice(n), [0, 1].map(i => ({ i, jsonrpc: '2.0', id: n + i + 1, method: 'eth_call', params })));
      assert.equal(report.durationMs, baseline.durationMs + 100);
      assert.deepEqual(report.callPhase, { startedMs: n * 10, finishedMs: n * 10 + 100, durationMs: 100 });
      assert.deepEqual(report.results.map(r => r.call.durationMs), [50, 50]);
      delete report.callPhase; delete report.settings.call; report.results.forEach(r => delete r.call);
      report.durationMs = baseline.durationMs; assert.deepEqual(report, baseline);
    }
  }
});

test('failed handshake and mismatch skip calls; accepted all-sample-failed endpoint still gets exactly one call', async t => {
  const trace = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const req = JSON.parse(init.body); const i = Number(new URL(url).pathname.slice(1)); trace.push({ i, ...req });
    const body = i === 0 || req.method === 'eth_blockNumber' ? rpcError(-32601)
      : req.method === 'eth_chainId' ? { result: i === 1 ? '0x2' : '0x1' } : { result: '0x' };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
  });
  const report = await benchmark([0, 1, 2].map(i => `http://127.0.0.1/${i}`), { samples: 2, expectedChain: '1', ...options });
  assert.deepEqual(report.results.map(r => [r.status, r.call.status, r.call.skipReason]),
    [['unreachable', 'skipped', 'handshake_failed'], ['mismatch', 'skipped', 'network_mismatch'], ['unreachable', 'success', null]]);
  for (const r of report.results.slice(0, 2)) assert.deepEqual(r.call, {
    status: 'skipped', attempts: 0, returnBytes: null, error: null, skipReason: r.call.skipReason, startedMs: null, finishedMs: null, durationMs: null,
  });
  assert.equal(trace.length, 6); assert.equal(trace.at(-1).i, 2); assert.deepEqual(trace.at(-1).params, params);
  assert.equal(evaluateHealthPolicy(report, { maxFailures: 0 }).passed, false);
});

test('shared pool respects complete-body barriers for measured, historical and call phases with unique IDs', async t => {
  let active = 0; let maximum = 0; let samples = 0; let historical = 0;
  const trace = [];
  const servers = await Promise.all([0, 1, 2, 3].map(i => serve(async (req, res) => {
    active++; maximum = Math.max(maximum, active); trace.push({ i, ...req });
    if (req.method === 'eth_getBlockByNumber' || req.method === 'eth_call') assert.equal(samples, 8);
    if (req.method === 'eth_call') assert.equal(historical, 4);
    res.writeHead(200); res.write(`{"jsonrpc":"2.0","id":${req.id},"result":`);
    await new Promise(resolve => setTimeout(resolve, i === 0 ? 15 : 3));
    active--;
    if (req.method === 'eth_blockNumber') samples++;
    if (req.method === 'eth_getBlockByNumber') historical++;
    res.end(JSON.stringify(req.method === 'eth_call' ? '0x' : req.method === 'eth_getBlockByNumber' ? { number: '0x0', hash } : '0x1') + '}');
  })));
  t.after(() => Promise.all(servers.map(s => s.close())));
  const report = await benchmark(servers.map(s => s.url), { samples: 2, concurrency: 2, historicalBlock: '0', ...options });
  assert.equal(maximum, 2); assert.equal(trace.length, 20);
  assert.deepEqual(trace.map(r => r.id).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(trace.slice(-4).map(r => r.method), Array(4).fill('eth_call'));
  assert.ok(report.callPhase.startedMs >= report.historicalPhase.finishedMs);
  assert.ok(report.results.every(r => r.call.startedMs >= report.historicalPhase.finishedMs));
  assert.ok(report.callPhase.durationMs >= Math.max(...report.results.map(r => r.call.durationMs)));
});

test('zero and maximum uint256 blocks and input DATA reach the wire exactly within bounds', async t => {
  const calls = [];
  const server = await serve((req, res) => { calls.push(req); reply(res, req.method === 'eth_call' ? '0x' : '0x1'); });
  t.after(server.close);
  for (const [block, data] of [['0', '0x'], [(2n ** 256n - 1n).toString(), `0x${'FF'.repeat(4096)}`]]) {
    const report = await benchmark([server.url], { samples: 1, callTo: `0x${'AB'.repeat(20)}`, callData: data, callBlock: block });
    assert.deepEqual(calls.at(-1).params, [{ to, input: data.toLowerCase(), gas: '0x186a0', value: '0x0' }, `0x${BigInt(block).toString(16)}`]);
    assert.equal(report.settings.call.block, block);
    assert.equal(report.settings.call.inputBytes, (data.length - 2) / 2);
    assert.equal(report.results[0].call.returnBytes, 0);
  }
});
