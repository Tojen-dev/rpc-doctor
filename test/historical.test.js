import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHistoricalBlock, historicalHeader } from '../src/historical.js';
import { benchmark } from '../src/benchmark.js';
import { evaluateHealthPolicy } from '../src/health-policy.js';
import { serve, reply } from './helpers.js';

const hash = `0x${'ab'.repeat(32)}`;
const big = '9007199254740993';
const bigHex = '0x20000000000001';

test('historical input uses exact bounded unsigned expected-chain grammar and canonical normalization', () => {
  for (const [value, expected] of [['0', 0n], ['0x0', 0n], ['15', 15n], ['0xF', 15n], [big, 9007199254740993n],
    [bigHex, 9007199254740993n], [(2n ** 256n - 1n).toString(), 2n ** 256n - 1n], [`0x${'F'.repeat(64)}`, 2n ** 256n - 1n]]) {
    assert.equal(parseHistoricalBlock(value), expected);
  }
  for (const value of [0, 1n, null, undefined, '', ' ', '\n', '0\n', '+1', '-1', '1.0', '1e3', '01', '0x01', '0x', '0X1',
    'latest', 'pending', 'earliest', 'safe', 'finalized', 'SYNTHETIC_SECRET', '9'.repeat(79), (2n ** 256n).toString(), `0x1${'0'.repeat(64)}`]) {
    assert.throws(() => parseHistoricalBlock(value), error => /Historical block/.test(error.message) && !/SYNTHETIC_SECRET/.test(error.message));
  }
});

test('header projection validates canonical number equality and a 32-byte hash without retaining hostile fields', () => {
  assert.deepEqual(historicalHeader({ number: '0xF', hash: `0x${'AB'.repeat(32)}`, transactions: ['SYNTHETIC_SECRET'], extraData: '<script>' }, 15n),
    { number: '15', hash });
  for (const value of [[], true, 'SYNTHETIC_SECRET', 1, {}, { number: '0x0' }, { hash },
    ...[null, '0x00', '0x0\n', '0X0', '0', '0x1', `0x${'f'.repeat(65)}`].map(number => ({ number, hash })),
    ...[null, '', '0x1', `0X${'ab'.repeat(32)}`, `${hash}\n`, '0x' + 'gg'.repeat(32), `0x${'ab'.repeat(33)}`].map(hash => ({ number: '0x0', hash }))]) {
    assert.throws(() => historicalHeader(value, 0n), error => error.code === 'INVALID_RESULT' && !/SYNTHETIC_SECRET|script/.test(error.message));
  }
});

const rpcError = code => ({ error: { code, message: 'SYNTHETIC_SECRET method not found', data: { url: 'SYNTHETIC_SECRET' } } });
for (const [name, response, status, error] of [
  ['found', () => ({ result: { number: bigHex, hash, transactions: ['SYNTHETIC_SECRET'] } }), 'found', null],
  ['null', () => ({ result: null }), 'null', null],
  ['method not found', () => rpcError(-32601), 'unsupported', 'RPC_ERROR'],
  ['invalid params', () => rpcError(-32602), 'error', 'RPC_ERROR'],
  ['generic RPC error', () => rpcError(-32000), 'error', 'RPC_ERROR'],
  ['pruned history error', () => rpcError(4444), 'error', 'RPC_ERROR'],
  ['string error code', () => rpcError('-32601'), 'error', 'INVALID_RESPONSE'],
  ['missing error message', () => ({ error: { code: -32601 } }), 'error', 'INVALID_RESPONSE'],
  ['wrong envelope ID', () => ({ id: 999, ...rpcError(-32601) }), 'error', 'INVALID_RESPONSE'],
  ['wrong JSON-RPC version', () => ({ jsonrpc: '1.0', result: null }), 'error', 'INVALID_RESPONSE'],
  ['result plus error', () => ({ result: null, ...rpcError(-32601) }), 'error', 'INVALID_RESPONSE'],
  ['missing result and error', () => ({}), 'error', 'INVALID_RESPONSE'],
  ['wrong number', () => ({ result: { number: '0x1', hash } }), 'error', 'INVALID_RESULT'],
  ['pending number', () => ({ result: { number: null, hash } }), 'error', 'INVALID_RESULT'],
  ['pending hash', () => ({ result: { number: bigHex, hash: null } }), 'error', 'INVALID_RESULT'],
  ['array block', () => ({ result: [] }), 'error', 'INVALID_RESULT'],
  ['bad hash', () => ({ result: { number: bigHex, hash: '<img src=SYNTHETIC_SECRET>' } }), 'error', 'INVALID_RESULT'],
]) {
  test(`loopback historical outcome: ${name}`, async t => {
    const calls = [];
    const server = await serve((req, res) => {
      calls.push(req);
      if (req.method !== 'eth_getBlockByNumber') return reply(res, req.method === 'eth_chainId' ? '0x1' : '0x10');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...response() }));
    }); t.after(server.close);
    const report = await benchmark([server.url], { samples: 1, historicalBlock: big });
    const r = report.results[0];
    assert.equal(r.historicalBlock.status, status); assert.equal(r.historicalBlock.error, error);
    assert.equal(r.historicalBlock.attempts, 1); assert.equal(r.historicalBlock.skipReason, null);
    assert.equal(r.historicalBlock.number, status === 'found' ? big : null);
    assert.equal(r.historicalBlock.hash, status === 'found' ? hash : null);
    assert.equal(r.status, 'healthy'); assert.equal(r.successes, 1); assert.deepEqual(r.errors, {});
    assert.equal(evaluateHealthPolicy(report, { maxFailures: 0 }).passed, true);
    assert.deepEqual(calls, [
      { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
      { jsonrpc: '2.0', id: 3, method: 'eth_getBlockByNumber', params: [bigHex, false] },
    ]);
    assert.ok(r.historicalBlock.startedMs >= report.rounds[0].finishedMs);
    assert.ok(report.durationMs >= report.historicalPhase.finishedMs);
    assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_SECRET|transactions|extraData/);
  });
}

for (const [name, send, expected] of [
  ['HTTP failure', (req, res) => res.writeHead(500).end('SYNTHETIC_SECRET'), 'HTTP_ERROR'],
  ['rate limit', (req, res) => res.writeHead(429).end('SYNTHETIC_SECRET'), 'RATE_LIMITED'],
  ['malformed JSON', (req, res) => res.end('SYNTHETIC_SECRET'), 'INVALID_RESPONSE'],
  ['oversize', (req, res) => res.end(' '.repeat(1024 * 1024 + 1)), 'RESPONSE_TOO_LARGE'],
  ['body timeout', (req, res) => { res.writeHead(200); res.write('{"jsonrpc":"2.0",'); }, 'TIMEOUT'],
  ['network failure', (req, res) => res.destroy(), 'NETWORK_ERROR'],
]) {
  test(`historical transport limit remains separate: ${name}`, async t => {
    const server = await serve((req, res) => req.method === 'eth_getBlockByNumber' ? send(req, res) : reply(res, '0x1'));
    t.after(server.close);
    const report = await benchmark([server.url], { samples: 1, timeoutMs: 200, historicalBlock: '0' });
    const r = report.results[0];
    assert.equal(r.historicalBlock.status, 'error'); assert.equal(r.historicalBlock.error, expected);
    assert.equal(r.status, 'healthy'); assert.equal(r.latencySampleCount, 1); assert.deepEqual(r.errors, {});
    assert.equal(evaluateHealthPolicy(report, { maxFailures: 0 }).passed, true);
    assert.ok(r.historicalBlock.durationMs >= 0);
    if (expected === 'TIMEOUT') assert.ok(r.historicalBlock.durationMs >= 150);
    assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_SECRET/);
  });
}

test('all probe outcomes preserve baseline traces, timings, errors, lag, warm-up and strict reasons', async t => {
  let now = 0; let calls; let blockCalls; let outcome;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const req = JSON.parse(options.body); const i = Number(new URL(url).pathname.slice(1));
    calls.push({ i, ...req }); now += req.method === 'eth_getBlockByNumber' ? 50 : 10;
    let body;
    if (req.method === 'eth_getBlockByNumber') body = outcome;
    else if (req.method === 'eth_chainId') body = { result: '0x1' };
    else body = i === 1 && ++blockCalls[i] === 1 ? rpcError(-32000) : { result: i === 0 ? '0x100' : '0xfa' };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
  });
  let baseline; let trace;
  for (const value of [undefined, { result: { number: '0x0', hash } }, { result: null }, rpcError(-32601), rpcError(-32602)]) {
    now = 0; calls = []; blockCalls = [0, 0]; outcome = value;
    const report = await benchmark(['http://127.0.0.1/0', 'http://127.0.0.1/1'], {
      samples: 2, warmup: 1, concurrency: 1, intervalMs: 1, reference: 1, expectedChain: '1',
      ...(value === undefined ? {} : { historicalBlock: '0' }),
    });
    report.healthPolicy = evaluateHealthPolicy(report, { maxFailures: 0 });
    delete report.generatedAt; delete report.startedAt;
    if (value === undefined) { baseline = report; trace = calls; continue; }
    assert.deepEqual(calls.slice(0, 8), trace);
    assert.deepEqual(calls.slice(8).map(c => [c.i, c.id, c.method, c.params]), [[0, 9, 'eth_getBlockByNumber', ['0x0', false]], [1, 10, 'eth_getBlockByNumber', ['0x0', false]]]);
    assert.equal(report.durationMs, 180); assert.equal(baseline.durationMs, 80);
    assert.deepEqual(report.historicalPhase, { startedMs: 80, finishedMs: 180, durationMs: 100 });
    assert.deepEqual(report.results.map(r => r.historicalBlock.durationMs), [50, 50]);
    delete report.historicalPhase; delete report.settings.historicalBlock;
    report.results.forEach(r => delete r.historicalBlock); report.durationMs = baseline.durationMs;
    assert.deepEqual(report, baseline);
  }
});

test('unknown and rejected networks are skipped; accepted endpoints probe even after every sample fails', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const i = Number(new URL(url).pathname.slice(1)); const req = JSON.parse(options.body); calls.push({ i, ...req });
    const body = i === 0 || req.method === 'eth_blockNumber' ? rpcError(-32601)
      : req.method === 'eth_chainId' ? { result: i === 1 ? '0x2' : '0x1' }
        : { result: { number: '0x0', hash } };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
  });
  const report = await benchmark([0, 1, 2].map(i => `http://127.0.0.1/${i}`), { samples: 2, expectedChain: '1', historicalBlock: '0' });
  assert.deepEqual(report.results.map(r => [r.status, r.historicalBlock.status, r.historicalBlock.skipReason]),
    [['unreachable', 'skipped', 'handshake_failed'], ['mismatch', 'skipped', 'network_mismatch'], ['unreachable', 'found', null]]);
  for (const r of report.results.slice(0, 2)) assert.deepEqual(r.historicalBlock,
    { status: 'skipped', attempts: 0, number: null, hash: null, error: null, skipReason: r.historicalBlock.skipReason, startedMs: null, finishedMs: null, durationMs: null });
  assert.equal(calls.length, 6); assert.equal(calls.at(-1).method, 'eth_getBlockByNumber'); assert.equal(calls.at(-1).i, 2);
  assert.equal(report.results.some(r => r.successes > 0), false);
});

test('probe phase waits for complete measured bodies and stays within the shared concurrency cap', async t => {
  let active = 0; let maximum = 0; let finishedSamples = 0; let releaseSamples;
  const samplesReady = new Promise(resolve => { releaseSamples = resolve; });
  const trace = []; const ids = [];
  const servers = await Promise.all([0, 1, 2, 3].map(async i => serve(async (req, res) => {
    active++; maximum = Math.max(maximum, active); trace.push([i, req.method]); ids.push(req.id);
    if (req.method === 'eth_getBlockByNumber') assert.equal(finishedSamples, 8);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(`{"jsonrpc":"2.0","id":${req.id},"result":`);
    await new Promise(resolve => setTimeout(resolve, i === 0 ? 15 : 3));
    active--;
    if (req.method === 'eth_blockNumber' && ++finishedSamples === 8) releaseSamples();
    res.end(JSON.stringify(req.method === 'eth_getBlockByNumber' ? { number: '0x0', hash } : '0x1') + '}');
  })));
  t.after(() => Promise.all(servers.map(server => server.close())));
  const report = await benchmark(servers.map(s => s.url), { samples: 2, concurrency: 2, historicalBlock: '0' });
  await samplesReady;
  assert.equal(maximum, 2); assert.equal(trace.length, 16);
  assert.deepEqual(ids.slice().sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1));
  assert.deepEqual(trace.slice(-4).map(c => c[1]), Array(4).fill('eth_getBlockByNumber'));
  assert.ok(report.results.every(r => r.historicalBlock.startedMs >= report.rounds.at(-1).finishedMs));
  assert.ok(report.historicalPhase.durationMs >= Math.max(...report.results.map(r => r.historicalBlock.durationMs)));
});
