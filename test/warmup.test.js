import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmark } from '../src/benchmark.js';
import { formatTable } from '../src/format.js';
import { main } from '../src/cli.js';
import { serve, reply } from './helpers.js';

async function run(args, env = {}) {
  let out = '';
  let err = '';
  const code = await main(args, env, { write: (s) => { out += s; } }, { write: (s) => { err += s; } });
  return { code, out, err };
}

test('warm-up precedes measurements with distinct IDs and separate deterministic timing', async (t) => {
  let now = 0;
  const requests = [];
  const durations = [50, 1000, 2000, 10, 30, 20, 40];
  t.mock.method(performance, 'now', () => now);
  // A synthetic transport advances a controlled clock without scheduler sleeps.
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = JSON.parse(options.body);
    const index = requests.length;
    requests.push(request);
    now += durations[index];
    if (index === 2) return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32000, message: 'SYNTHETIC_SECRET' },
    }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: index === 0 ? '0x1' : index < 3 ? '0xffffffffffffffffffff' : '0x20000000000001',
    }));
  });
  const report = await benchmark(['http://127.0.0.1:8545'], { samples: 4, warmup: 2 });
  assert.deepEqual(requests.map((r) => r.method), ['eth_chainId', ...Array(6).fill('eth_blockNumber')]);
  assert.deepEqual(requests.map((r) => r.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(requests.every((r) => r.jsonrpc === '2.0' && r.params.length === 0));
  assert.equal(report.durationMs, 3150);
  assert.equal(report.settings.warmup, 2);
  const row = report.results[0];
  assert.deepEqual(row.warmup, { attempts: 2, successes: 1, errors: { RPC_ERROR: 1 }, durationMs: 3000 });
  assert.deepEqual(row.latencyMs, { min: 10, median: 25, p95: 40, max: 40 });
  assert.equal(row.attempts, 4);
  assert.equal(row.successes, 4);
  assert.equal(row.successRate, 100);
  assert.equal(row.latestBlock, '9007199254740993');
  assert.equal(row.status, 'degraded');
  assert.deepEqual(row.errors, {});
  const table = formatTable(report);
  assert.match(table, /Warm-up OK\s+Warm-up elapsed/);
  assert.match(table, /1\/2\s+3000ms/);
  assert.match(table, /Elapsed: 3150ms/);
  assert.match(table, /warm-up time and errors are separate from measured samples/);
});

test('zero warm-up preserves default report fields and request count; twenty calls is accepted', async (t) => {
  let requests = [];
  const server = await serve((req, res) => { requests.push(req); reply(res, '0x1'); });
  t.after(server.close);
  const reports = [];
  for (const warmup of [undefined, 0, 20]) {
    requests = [];
    const report = await benchmark([server.url], { samples: 2, warmup });
    const row = report.results[0];
    assert.equal(requests.length, 3 + (warmup ?? 0));
    assert.equal(new Set(requests.map((r) => r.id)).size, requests.length);
    assert.equal(row.attempts, 2);
    assert.equal(row.successes, 2);
    if (warmup) {
      assert.equal(report.settings.warmup, 20);
      assert.equal(row.warmup.attempts, 20);
      assert.equal(row.warmup.successes, 20);
    } else {
      assert.equal(Object.hasOwn(report.settings, 'warmup'), false);
      assert.equal(Object.hasOwn(row, 'warmup'), false);
      assert.doesNotMatch(formatTable(report), /Warm-up/);
      // Only wall-clock measurements and the generation timestamp may differ.
      reports.push({ ...report, generatedAt: '', durationMs: 0,
        results: [{ ...row, latencyMs: { min: 1, median: 1, p95: 1, max: 1 } }],
      });
    }
  }
  assert.deepEqual(reports[0], reports[1]);
  assert.equal(formatTable(reports[0]), formatTable(reports[1]));
});

test('invalid API and CLI warm-up values are rejected safely before any RPC', async (t) => {
  let requests = 0;
  const server = await serve((req, res) => { requests++; reply(res, '0x1'); });
  t.after(server.close);
  for (const warmup of [null, false, '1', -1, 1.5, 21, Infinity, NaN, [], {}]) {
    await assert.rejects(benchmark([server.url], { warmup }), /Warm-up must be an integer from 0 to 20/);
  }
  for (const value of ['', '-1', '21', '1.5', '1e1', '0x1', 'Infinity', ' 1', '1\n', '+1', '9'.repeat(400), 'SYNTHETIC_SECRET\x1b']) {
    const result = await run([`--warmup=${value}`, server.url]);
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.equal(result.err, 'RPC Doctor: Warm-up must be an integer from 0 to 20.\n');
  }
  assert.equal((await run(['--warmup'])).code, 2);
  assert.equal(requests, 0);
});

test('warm-up failures are not retried or mixed with measured errors, labels, or provider secrets', async (t) => {
  let blocks = 0;
  const ids = [];
  const server = await serve((req, res) => {
    ids.push(req.id);
    if (req.method === 'eth_chainId') { blocks = 0; return reply(res, '0x1'); }
    switch (++blocks) {
      case 1: return res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id,
        error: { code: -32000, message: 'SYNTHETIC_SECRET\x1b' } }));
      case 2: return res.end('SYNTHETIC_SECRET invalid JSON');
      case 3: return reply(res, '0x01');
      case 4: return res.writeHead(429).end('SYNTHETIC_SECRET');
      case 5: return reply(res, '0x1', req.id + 100);
      case 6: return res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: '0x1', error: {} }));
      case 7: return reply(res, '0xffffffffffffffffffff');
      case 8: return res.writeHead(503).end('SYNTHETIC_SECRET');
      default: return reply(res, '0x10');
    }
  });
  t.after(server.close);
  for (const format of [[], ['--json']]) {
    ids.length = 0;
    const result = await run(['--samples', '3', '--warmup', '7', '--label', '  Primary\n\x1b\u202e node ', ...format], {
      RPC_DOCTOR_ENDPOINTS_JSON: JSON.stringify([`${server.url}/SYNTHETIC_SECRET?key=SYNTHETIC_SECRET`]),
    });
    assert.equal(result.code, 0, result.err);
    assert.equal(result.err, '');
    assert.equal(ids.length, 11);
    assert.equal(new Set(ids).size, 11);
    assert.equal(result.out.includes('SYNTHETIC_SECRET'), false);
    assert.equal(result.out.includes(server.url), false);
    assert.doesNotMatch(result.out.replace(/\n/g, ''), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    if (format.length) {
      const row = JSON.parse(result.out).results[0];
      assert.equal(row.endpoint, 'Primary node');
      assert.equal(row.status, 'degraded');
      assert.equal(row.attempts, 3);
      assert.equal(row.successes, 2);
      assert.equal(row.successRate, 66.67);
      assert.equal(row.latestBlock, '16');
      assert.deepEqual(row.errors, { HTTP_ERROR: 1 });
      assert.equal(row.warmup.attempts, 7);
      assert.equal(row.warmup.successes, 1);
      assert.deepEqual(row.warmup.errors, { RPC_ERROR: 1, INVALID_RESPONSE: 3, INVALID_RESULT: 1, RATE_LIMITED: 1 });
    } else {
      assert.match(result.out, /^Primary node\s+1\s+degraded\s+2\/3/m);
      assert.match(result.out, /1\/7\s+\d+ms/);
      assert.match(result.out, /\nErrors:\n  Primary node: HTTP_ERROR × 1\n/);
      assert.match(result.out, /\nWarm-up errors:\n  Primary node: RPC_ERROR × 1/);
      assert.match(result.out, /Primary node: INVALID_RESPONSE × 3/);
      assert.match(result.out, /Primary node: INVALID_RESULT × 1/);
      assert.match(result.out, /Primary node: RATE_LIMITED × 1/);
    }
  }
});

test('failed handshakes and rejected networks skip all warm-up and measured calls', async (t) => {
  for (const [chain, status, errors] of [['0x2', 'mismatch', {}], ['0x01', 'unreachable', { INVALID_RESULT: 1 }]]) {
    const requests = [];
    const server = await serve((req, res) => { requests.push(req.method); reply(res, chain); });
    t.after(server.close);
    const result = await run(['--json', '--expected-chain', '1', '--warmup', '20', server.url]);
    assert.equal(result.code, 1, result.err);
    const row = JSON.parse(result.out).results[0];
    assert.deepEqual(requests, ['eth_chainId']);
    assert.equal(row.status, status);
    assert.deepEqual(row.errors, errors);
    assert.deepEqual(row.warmup, { attempts: 0, successes: 0, errors: {}, durationMs: 0 });
    assert.equal(row.attempts, 0);
    assert.equal(row.successes, 0);
    assert.equal(row.latestBlock, null);
    assert.equal(row.latencyMs.median, null);
  }
});

test('large warm-up blocks never influence peer or explicit-reference lag', async (t) => {
  const heights = [9007199254741003n, 9007199254740993n];
  const servers = await Promise.all(heights.map(async (height, index) => {
    let blocks = 0;
    return serve((req, res) => {
      if (req.method === 'eth_chainId') { blocks = 0; return reply(res, '0x1'); }
      reply(res, ++blocks === 1 ? `0x${((1n << 100n) + BigInt(index)).toString(16)}` : `0x${height.toString(16)}`);
    });
  }));
  for (const server of servers) t.after(server.close);
  for (const reference of [undefined, 1]) {
    const { results } = await benchmark(servers.map((s) => s.url), { samples: 1, warmup: 1, reference });
    assert.deepEqual(results.map((r) => r.latestBlock), heights.map(String));
    assert.deepEqual(results.map((r) => r.lagBlocks), [reference ? null : '0', '10']);
    assert.deepEqual(results.map((r) => r.peerCount), [1, 1]);
    assert.deepEqual(results.map((r) => r.status), ['healthy', 'degraded']);
  }
});

test('successful warm-up cannot make failed samples usable for reference comparison or exit 0', async (t) => {
  let blocks = 0;
  const reference = await serve((req, res) => {
    if (req.method === 'eth_chainId') { blocks = 0; return reply(res, '0x1'); }
    if (++blocks <= 2) return reply(res, '0xffffffffffffffffffff');
    res.writeHead(503).end();
  });
  t.after(reference.close);
  const peer = await serve((req, res) => reply(res, '0x1'));
  t.after(peer.close);
  for (const endpoints of [[reference.url], [reference.url, peer.url]]) {
    const result = await run(['--warmup', '2', '--samples', '2', '--reference', '1', '--json', ...endpoints]);
    assert.equal(result.code, endpoints.length === 1 ? 1 : 0, result.err);
    const { results } = JSON.parse(result.out);
    assert.equal(results[0].warmup.successes, 2);
    assert.equal(results[0].status, 'unreachable');
    assert.equal(results[0].latestBlock, null);
    assert.equal(results[0].successes, 0);
    assert.equal(results[0].attempts, 2);
    assert.equal(results[0].successRate, 0);
    assert.deepEqual(results[0].errors, { HTTP_ERROR: 2 });
    assert.deepEqual(results[0].latencyMs, { min: null, median: null, p95: null, max: null });
    if (results[1]) {
      assert.equal(results[1].lagStatus, 'reference_unavailable');
      assert.equal(results[1].lagBlocks, null);
      assert.equal(results[1].peerCount, 0);
      assert.equal(results[1].status, 'degraded');
    }
  }
});

test('demo accepts warm-up in table and JSON, and recovery exits 0 despite warm-up errors', async () => {
  const args = ['--demo', '--warmup', '3', '--samples', '2', '--expected-chain', '1', '--reference', '1'];
  const json = await run([...args, '--json']);
  assert.equal(json.code, 0, json.err);
  const report = JSON.parse(json.out);
  assert.equal(report.demo, true);
  assert.equal(report.settings.warmup, 3);
  assert.deepEqual(report.results.map((r) => r.attempts), [2, 2, 2]);
  assert.deepEqual(report.results.map((r) => r.successes), [2, 2, 2]);
  assert.deepEqual(report.results[2].errors, {});
  assert.deepEqual(report.results[2].warmup.errors, { RATE_LIMITED: 1 });
  assert.equal(report.results[2].status, 'degraded');
  const table = await run(args);
  assert.equal(table.code, 0, table.err);
  assert.match(table.out, /Network/);
  assert.match(table.out, /Lag check/);
  assert.match(table.out, /Warm-up OK/);
  assert.match(table.out, /Warm-up elapsed/);
  assert.match(table.out, /Warm-up errors:\n  RPC 3: RATE_LIMITED × 1/);
  assert.doesNotMatch(table.out, /\nErrors:/);
  assert.doesNotMatch((await run(['--demo', '--warmup', '0', '--samples', '1'])).out, /Warm-up/);
});
