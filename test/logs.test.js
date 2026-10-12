import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLogsOptions, logCounts, LogsProbeError } from '../src/logs.js';
import { benchmark } from '../src/benchmark.js';
import { evaluateHealthPolicy } from '../src/health-policy.js';
import { serve, reply } from './helpers.js';

const address = `0x${'ab'.repeat(20)}`; const topic = `0x${'11'.repeat(32)}`;
const block = '9007199254740993'; const hex = '0x20000000000001';
const options = { logsFrom: block, logsTo: (BigInt(block) + 99n).toString(), logsAddress: address, logsTopic0: topic };
const request = parseLogsOptions(options);
const log = (extra = {}) => ({ removed: false, logIndex: '0x0', transactionIndex: '0x0',
  transactionHash: `0x${'ef'.repeat(32)}`, blockHash: `0x${'cd'.repeat(32)}`, blockNumber: hex,
  address, data: '0xfeedbeef', topics: [topic], ...extra });
const rpcError = code => ({ error: { code, message: 'SYNTHETIC_SECRET method not found', data: 'SYNTHETIC_SECRET' } });

test('log options require a pair, exact uint256 bounds, inclusive 1–100 blocks and single fixed-width filters', () => {
  assert.equal(parseLogsOptions(), undefined);
  for (const [from, to] of [['0', '0x0'], ['0', '99'], ['0xA', '0x6D'], [block, options.logsTo],
    [(2n ** 256n - 100n).toString(), `0x${'F'.repeat(64)}`]]) {
    const r = parseLogsOptions({ logsFrom: from, logsTo: to });
    assert.equal(r.from, BigInt(from)); assert.equal(r.to, BigInt(to));
  }
  assert.deepEqual(parseLogsOptions({ ...options, logsAddress: `0x${'AB'.repeat(20)}` }), request);
  for (const fields of [{ logsFrom: '0' }, { logsTo: '0' }, { logsAddress: address }, { logsTopic0: topic },
    { logsFrom: '1', logsTo: '0' }, { logsFrom: '0', logsTo: '100' }]) assert.throws(() => parseLogsOptions(fields), LogsProbeError);
  for (const key of ['logsFrom', 'logsTo']) {
    for (const value of [null, 0, 1n, '', ' ', '0\n', '+1', '-1', '01', '0x01', '0x', '0X1', '1.0', '1e3', 'latest', 'earliest', 'pending', 'safe', 'finalized', '9'.repeat(79), (2n ** 256n).toString(), 'SYNTHETIC_SECRET']) {
      assert.throws(() => parseLogsOptions({ ...options, [key]: value }), e => e instanceof LogsProbeError && !/SYNTHETIC_SECRET/.test(e.message));
    }
  }
  for (const [key, size] of [['logsAddress', 20], ['logsTopic0', 32]]) {
    for (const value of [null, 0, [], '', '0x', `0x${'ab'.repeat(size - 1)}`, `0x${'ab'.repeat(size + 1)}`, `0X${'ab'.repeat(size)}`, `0x${'ab'.repeat(size)}\n`, `0x${'gg'.repeat(size)}`, 'SYNTHETIC_SECRET']) {
      assert.throws(() => parseLogsOptions({ ...options, [key]: value }), LogsProbeError);
    }
  }
});

test('whole log validation accepts exact count/data/topic/quantity boundaries and counts removed without retaining raw fields', () => {
  assert.deepEqual(logCounts([], request), { logCount: 0, removedCount: 0 });
  const logs = Array.from({ length: 1000 }, (_, i) => log({ logIndex: `0x${i.toString(16)}`, removed: i < 2 }));
  assert.deepEqual(logCounts(logs, request), { logCount: 1000, removedCount: 2 });
  for (const bytes of ['0x', `0x${'AB'.repeat(4096)}`]) {
    assert.deepEqual(logCounts([log({ data: bytes, address: `0x${'AB'.repeat(20)}`, topics: [topic, topic, topic, topic],
      blockNumber: `0x${request.to.toString(16)}`, blockTimestamp: '0xF', transactionIndex: `0x${'F'.repeat(64)}`, unknown: 'SYNTHETIC_SECRET' })], request), { logCount: 1, removedCount: 0 });
  }
  assert.deepEqual(logCounts([log({ topics: [] })], { ...request, topic0: undefined }), { logCount: 1, removedCount: 0 });
  const max = 2n ** 256n - 1n;
  assert.deepEqual(logCounts([log({ blockNumber: `0x${max.toString(16)}` })], { ...request, from: max, to: max }), { logCount: 1, removedCount: 0 });
});

const invalidLogs = [];
for (const key of Object.keys(log())) {
  const missing = log(); delete missing[key]; invalidLogs.push([`missing ${key}`, missing], [`null ${key}`, log({ [key]: null })]);
}
for (const key of ['blockNumber', 'transactionIndex', 'logIndex', 'blockTimestamp']) {
  for (const value of ['0x00', '0x0\n', 0, '0X0', `0x1${'0'.repeat(64)}`]) invalidLogs.push([`bad quantity ${key}`, log({ [key]: value })]);
}
invalidLogs.push(
  ['pending hash', log({ blockHash: null })], ['invalid hash', log({ transactionHash: '0x0' })],
  ['invalid address', log({ address: address + '\n' })], ['wrong address', log({ address: `0x${'00'.repeat(20)}` })],
  ['wrong topic', log({ topics: [`0x${'22'.repeat(32)}`] })], ['empty topics with filter', log({ topics: [] })],
  ['topics not array', log({ topics: topic })], ['nested topic OR', log({ topics: [[topic]] })], ['too many topics', log({ topics: Array(5).fill(topic) })],
  ['bad topic', log({ topics: [topic, '0x0'] })], ['null topic', log({ topics: [topic, null] })],
  ['before range', log({ blockNumber: `0x${(request.from - 1n).toString(16)}` })], ['after range', log({ blockNumber: `0x${(request.to + 1n).toString(16)}` })],
  ['string removed', log({ removed: 'false' })], ['oversize data', log({ data: `0x${'ff'.repeat(4097)}` })],
  ['odd data', log({ data: '0xf' })], ['nonhex data', log({ data: '0xzz' })], ['trailing newline data', log({ data: '0x\n' })],
  ['array log', []], ['null log', null], ['primitive log', 'SYNTHETIC_SECRET'],
);
test('missing, null and malformed mined fields and filter mismatches reject the whole result', () => {
  for (const [name, entry] of invalidLogs) {
    assert.throws(() => logCounts([log(), entry], request), e => e.code === 'INVALID_RESULT' && !/SYNTHETIC_SECRET/.test(e.message), name);
  }
  for (const value of [null, {}, 'SYNTHETIC_SECRET', Array(1001).fill(log())]) assert.throws(() => logCounts(value, request), e => e.code === 'INVALID_RESULT');
});

for (const [name, response, status, error, count, removed] of [
  ['empty', { result: [] }, 'success', null, 0, 0],
  ['one with extras', { result: [log({ removed: true, extra: 'SYNTHETIC_SECRET' })], extra: 'SYNTHETIC_SECRET' }, 'success', null, 1, 1],
  ['1000 logs', { result: Array.from({ length: 1000 }, (_, i) => log({ logIndex: `0x${i.toString(16)}` })) }, 'success', null, 1000, 0],
  ['1001 logs', { result: Array(1001).fill(log()) }, 'error', 'INVALID_RESULT', null, null],
  ['max data', { result: [log({ data: `0x${'ff'.repeat(4096)}` })] }, 'success', null, 1, 0],
  ['oversize data', { result: [log({ data: `0x${'ff'.repeat(4097)}` })] }, 'error', 'INVALID_RESULT', null, null],
  ['bad final log', { result: [log(), log({ blockNumber: '0x1' })] }, 'error', 'INVALID_RESULT', null, null],
  ['null', { result: null }, 'error', 'INVALID_RESULT', null, null],
  ['unsupported', rpcError(-32601), 'unsupported', 'RPC_ERROR', null, null],
  ['invalid params', rpcError(-32602), 'error', 'RPC_ERROR', null, null],
  ['provider limit', rpcError(-32005), 'error', 'RPC_ERROR', null, null],
  ['pruned history', rpcError(4444), 'error', 'RPC_ERROR', null, null],
  ['wrong ID', { id: 999, ...rpcError(-32601) }, 'error', 'INVALID_RESPONSE', null, null],
  ['wrong version', { jsonrpc: '1.0', result: [] }, 'error', 'INVALID_RESPONSE', null, null],
  ['string code', rpcError('-32601'), 'error', 'INVALID_RESPONSE', null, null],
  ['missing message', { error: { code: -32601 } }, 'error', 'INVALID_RESPONSE', null, null],
  ['both result and error', { result: [], ...rpcError(-32601) }, 'error', 'INVALID_RESPONSE', null, null],
  ['neither result nor error', {}, 'error', 'INVALID_RESPONSE', null, null],
]) test(`loopback logs outcome: ${name}`, async t => {
  const trace = [];
  const server = await serve((req, res) => {
    trace.push(req); if (req.method !== 'eth_getLogs') return reply(res, '0x1');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...response }));
  }); t.after(server.close);
  const report = await benchmark([server.url + '/?SYNTHETIC_SECRET'], { samples: 1, ...options });
  assert.deepEqual(trace, [
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
    { jsonrpc: '2.0', id: 3, method: 'eth_getLogs', params: [{ fromBlock: hex, toBlock: '0x20000000000064', address, topics: [topic] }] },
  ]);
  assert.deepEqual(report.settings.logs, { fromBlock: block, toBlock: options.logsTo, address, topic0: topic });
  const r = report.results[0];
  assert.deepEqual([r.logs.status, r.logs.error, r.logs.logCount, r.logs.removedCount, r.logs.attempts, r.logs.skipReason], [status, error, count, removed, 1, null]);
  assert.equal(r.status, 'healthy'); assert.deepEqual(r.errors, {}); assert.equal(r.successes, 1);
  assert.equal(evaluateHealthPolicy(report, { maxFailures: 0 }).passed, true);
  assert.ok(r.logs.startedMs >= report.rounds[0].finishedMs); assert.ok(report.durationMs >= report.logsPhase.finishedMs);
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_SECRET|feedbeef|transactionHash|blockHash|127\.0\.0\.1/);
});

for (const [name, send, expected] of [
  ['HTTP', (req, res) => res.writeHead(500).end('SYNTHETIC_SECRET'), 'HTTP_ERROR'],
  ['429', (req, res) => res.writeHead(429).end('SYNTHETIC_SECRET'), 'RATE_LIMITED'],
  ['malformed JSON', (req, res) => res.end('SYNTHETIC_SECRET'), 'INVALID_RESPONSE'],
  ['body limit', (req, res) => res.end(' '.repeat(1024 * 1024 + 1)), 'RESPONSE_TOO_LARGE'],
  ['whole-body timeout', (req, res) => { res.writeHead(200); res.write('{"jsonrpc":"2.0",'); }, 'TIMEOUT'],
  ['network', (req, res) => res.destroy(), 'NETWORK_ERROR'],
]) test(`logs transport failure: ${name}`, async t => {
  const server = await serve((req, res) => req.method === 'eth_getLogs' ? send(req, res) : reply(res, '0x1'));
  t.after(server.close);
  const report = await benchmark([server.url], { samples: 1, timeoutMs: 200, ...options });
  const r = report.results[0];
  assert.equal(r.logs.status, 'error'); assert.equal(r.logs.error, expected); assert.equal(r.logs.logCount, null); assert.equal(r.logs.removedCount, null);
  assert.equal(r.logs.attempts, 1); assert.equal(r.status, 'healthy'); assert.deepEqual(r.errors, {});
  assert.equal(evaluateHealthPolicy(report, { maxFailures: 0 }).passed, true);
  if (expected === 'TIMEOUT') assert.ok(r.logs.durationMs >= 150);
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_SECRET/);
});

test('zero/max block and every optional filter combination produce the exact bounded request', async t => {
  const trace = [];
  const server = await serve((req, res) => { trace.push(req); reply(res, req.method === 'eth_getLogs' ? [] : '0x1'); }); t.after(server.close);
  for (const bound of ['0', (2n ** 256n - 1n).toString()]) for (const filter of [{}, { logsAddress: address }, { logsTopic0: topic }, { logsAddress: address, logsTopic0: topic }]) {
    await benchmark([server.url], { samples: 1, logsFrom: bound, logsTo: bound, ...filter });
    assert.deepEqual(trace.at(-1).params, [{ fromBlock: `0x${BigInt(bound).toString(16)}`, toBlock: `0x${BigInt(bound).toString(16)}`,
      ...(filter.logsAddress ? { address } : {}), ...(filter.logsTopic0 ? { topics: [topic] } : {}) }]);
  }
});

test('all log outcomes preserve baseline and every previous probe combination under fixed time', async t => {
  let now = 0; let trace; let blocks; let outcome;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const req = JSON.parse(init.body); const i = Number(new URL(url).pathname.slice(1)); trace.push({ i, ...req });
    now += req.method === 'eth_getLogs' ? 50 : 10;
    const body = req.method === 'eth_getLogs' ? outcome
      : req.method === 'eth_call' ? { result: '0x' }
        : req.method === 'eth_getBlockByNumber' ? rpcError(-32601)
          : req.method === 'eth_chainId' ? { result: '0x1' }
            : ++blocks[i] === (i === 0 ? 1 : 2) ? rpcError(-32000) : { result: i === 0 ? '0x100' : '0xfa' };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
  });
  for (const historical of [false, true]) for (const call of [false, true]) {
    let baseline; let baseTrace;
    for (const value of [undefined, { result: [] }, { result: [log()] }, { result: null }, rpcError(-32601), rpcError(-32005)]) {
      now = 0; trace = []; blocks = [0, 0]; outcome = value;
      const report = await benchmark(['http://127.0.0.1/0', 'http://127.0.0.1/1'], {
        samples: 2, warmup: 1, concurrency: 1, intervalMs: 1, reference: 1, expectedChain: '1',
        ...(historical ? { historicalBlock: '0' } : {}), ...(call ? { callTo: address, callData: '0x', callBlock: '0' } : {}),
        ...(value === undefined ? {} : options),
      });
      report.healthPolicy = evaluateHealthPolicy(report, { maxFailures: 0 }); delete report.startedAt; delete report.generatedAt;
      if (value === undefined) { baseline = report; baseTrace = trace; continue; }
      const n = 8 + Number(historical) * 2 + Number(call) * 2;
      assert.equal(trace.length, n + 2); assert.deepEqual(trace.slice(0, n), baseTrace);
      assert.deepEqual(trace.slice(n).map(r => [r.i, r.id, r.method]), [[0, n + 1, 'eth_getLogs'], [1, n + 2, 'eth_getLogs']]);
      assert.equal(report.durationMs, baseline.durationMs + 100);
      assert.deepEqual(report.logsPhase, { startedMs: n * 10, finishedMs: n * 10 + 100, durationMs: 100 });
      assert.deepEqual(report.results.map(r => r.logs.durationMs), [50, 50]);
      delete report.logsPhase; delete report.settings.logs; report.results.forEach(r => delete r.logs);
      report.durationMs = baseline.durationMs; assert.deepEqual(report, baseline);
    }
  }
});

test('handshake failures/mismatches skip while accepted all-sample-failed endpoints still attempt logs', async t => {
  const trace = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const req = JSON.parse(init.body); const i = Number(new URL(url).pathname.slice(1)); trace.push({ i, ...req });
    const body = i === 0 || req.method === 'eth_blockNumber' ? rpcError(-32601)
      : req.method === 'eth_chainId' ? { result: i === 1 ? '0x2' : '0x1' } : { result: [] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
  });
  const report = await benchmark([0, 1, 2].map(i => `http://127.0.0.1/${i}`), { samples: 2, expectedChain: '1', ...options });
  assert.deepEqual(report.results.map(r => [r.status, r.logs.status, r.logs.skipReason]),
    [['unreachable', 'skipped', 'handshake_failed'], ['mismatch', 'skipped', 'network_mismatch'], ['unreachable', 'success', null]]);
  for (const r of report.results.slice(0, 2)) assert.deepEqual(r.logs, {
    status: 'skipped', attempts: 0, logCount: null, removedCount: null, error: null, skipReason: r.logs.skipReason, startedMs: null, finishedMs: null, durationMs: null,
  });
  assert.equal(trace.length, 6); assert.equal(trace.at(-1).i, 2); assert.equal(evaluateHealthPolicy(report, { maxFailures: 0 }).passed, false);
});

test('shared pool enforces complete-body barriers through measured/historical/call/log phases and unique IDs', async t => {
  let active = 0; let maximum = 0; let samples = 0; let historical = 0; let calls = 0;
  const trace = [];
  const servers = await Promise.all([0, 1, 2, 3].map(i => serve(async (req, res) => {
    active++; maximum = Math.max(maximum, active); trace.push({ i, ...req });
    if (['eth_getBlockByNumber', 'eth_call', 'eth_getLogs'].includes(req.method)) assert.equal(samples, 8);
    if (['eth_call', 'eth_getLogs'].includes(req.method)) assert.equal(historical, 4);
    if (req.method === 'eth_getLogs') assert.equal(calls, 4);
    res.writeHead(200); res.write(`{"jsonrpc":"2.0","id":${req.id},"result":`);
    await new Promise(resolve => setTimeout(resolve, i === 0 ? 15 : 3)); active--;
    if (req.method === 'eth_blockNumber') samples++;
    if (req.method === 'eth_getBlockByNumber') historical++;
    if (req.method === 'eth_call') calls++;
    res.end(JSON.stringify(req.method === 'eth_getLogs' ? [] : req.method === 'eth_call' ? '0x'
      : req.method === 'eth_getBlockByNumber' ? null : '0x1') + '}');
  })));
  t.after(() => Promise.all(servers.map(s => s.close())));
  const report = await benchmark(servers.map(s => s.url), { samples: 2, concurrency: 2, historicalBlock: '0', callTo: address, callData: '0x', callBlock: '0', ...options });
  assert.equal(maximum, 2); assert.equal(trace.length, 24);
  assert.deepEqual(trace.map(r => r.id).sort((a, b) => a - b), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.deepEqual(trace.slice(-4).map(r => r.method), Array(4).fill('eth_getLogs'));
  assert.ok(report.logsPhase.startedMs >= report.callPhase.finishedMs);
  assert.ok(report.results.every(r => r.logs.startedMs >= report.callPhase.finishedMs));
  assert.ok(report.logsPhase.durationMs >= Math.max(...report.results.map(r => r.logs.durationMs)));
});
