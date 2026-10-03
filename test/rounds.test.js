import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmark } from '../src/benchmark.js';
import { formatTable } from '../src/format.js';
import { main } from '../src/cli.js';

const HEIGHT = 1n << 80n;
const hex = (value) => `0x${value.toString(16)}`;
// Drain promise/stream callbacks, without advancing a timer or sleeping for RPCs.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function controlledTransport(t, count, warmup) {
  let now = 0;
  let peak = 0;
  const requests = [];
  const blocks = Array(count).fill(0);
  const urls = Array.from({ length: count }, (_, i) => `http://127.0.0.1:${8545 + i}/SYNTHETIC_SECRET`);
  const pending = () => requests.filter((r) => r.finishedMs === null);
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise((resolve, reject) => {
    const index = urls.indexOf(url);
    const request = JSON.parse(options.body);
    const round = request.method === 'eth_chainId' ? 0 : Math.max(0, ++blocks[index] - warmup);
    const record = { index, round, ...request, startedMs: now, finishedMs: null };
    requests.push(record);
    peak = Math.max(peak, pending().length);
    const onAbort = () => { record.finishedMs = now; reject(new Error('Aborted fake request')); };
    options.signal.addEventListener('abort', onAbort, { once: true });
    record.respond = (result, error, elapsed) => {
      now += elapsed;
      record.finishedMs = now;
      options.signal.removeEventListener('abort', onAbort);
      resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        ...(error ? { error: { code: -32000, message: 'SYNTHETIC_SECRET' } } : { result }),
      })));
    };
  }));
  return {
    urls, requests, pending,
    get peak() { return peak; },
    async respond(index, result, { error = false, elapsed = 10 } = {}) {
      const waiting = pending().filter((r) => r.index === index);
      assert.equal(waiting.length, 1, 'one sequential request per endpoint');
      waiting[0].respond(result, error, elapsed);
      await settle();
    },
  };
}

test('preparation and every round wait for slow peers with bounded concurrency and exact observations', { timeout: 10000 }, async (t) => {
  const rpc = controlledTransport(t, 3, 1);
  const running = benchmark(rpc.urls, {
    samples: 3, concurrency: 2, warmup: 1, reference: 1, expectedChain: '1',
    labels: [' Slow\nnode ', 'Fast node', 'Queued node'],
  });
  await settle();
  assert.deepEqual(rpc.pending().map((r) => [r.index, r.method]), [[0, 'eth_chainId'], [1, 'eth_chainId']]);
  // Keep endpoint 0's handshake pending while 1 and 2 finish preparation.
  await rpc.respond(1, '0x1');
  await rpc.respond(1, '0x01'); // Warm-up validation failure must stay separate.
  await rpc.respond(2, '0x1');
  await rpc.respond(2, hex(1n << 120n));
  assert.equal(rpc.requests.length, 5);
  assert.deepEqual(rpc.pending().map((r) => r.index), [0]);
  assert.ok(rpc.requests.every((r) => r.round === 0));
  await rpc.respond(0, '0x1', { elapsed: 100 });
  assert.equal(rpc.requests.length, 6);
  assert.ok(rpc.requests.every((r) => r.round === 0));
  await rpc.respond(0, hex(1n << 120n), { elapsed: 100 });

  for (let round = 1; round <= 3; round++) {
    assert.deepEqual(rpc.pending().map((r) => [r.index, r.round]), [[0, round], [1, round]]);
    await rpc.respond(1, hex(HEIGHT - 3n), { error: round === 2 });
    await rpc.respond(2, hex(HEIGHT - 4n));
    assert.deepEqual(rpc.pending().map((r) => [r.index, r.round]), [[0, round]]);
    assert.equal(rpc.requests.length, 6 + round * 3, 'no next round while one peer is pending');
    await rpc.respond(0, hex(HEIGHT + BigInt(4 - round)), { elapsed: 100 });
  }
  const report = await running;
  assert.equal(rpc.peak, 2);
  assert.equal(rpc.pending().length, 0);
  assert.equal(new Set(rpc.requests.map((r) => r.id)).size, 15);
  assert.deepEqual(report.results.map((r) => r.endpoint), ['Slow node', 'Fast node', 'Queued node']);
  assert.deepEqual(report.results.map((r) => r.latestBlock), [HEIGHT + 3n, HEIGHT - 3n, HEIGHT - 4n].map(String));
  assert.deepEqual(report.results.map((r) => r.lagBlocks), [null, '6', '7']);
  assert.deepEqual(report.results.map((r) => r.successes), [3, 2, 3]);
  assert.deepEqual(report.results.map((r) => r.status), ['healthy', 'degraded', 'degraded']);
  assert.deepEqual(report.results[1].warmup.errors, { INVALID_RESULT: 1 });
  assert.deepEqual(report.results[1].errors, { RPC_ERROR: 1 });
  assert.equal(report.results[1].successRate, 66.67);
  for (const [index, result] of report.results.entries()) {
    const measured = rpc.requests.filter((r) => r.index === index && r.round > 0);
    assert.equal(result.attempts, 3);
    assert.deepEqual(result.observations.map(({ round, startedMs, finishedMs }) => ({ round, startedMs, finishedMs })),
      measured.map(({ round, startedMs, finishedMs }) => ({ round, startedMs, finishedMs })));
    for (const observation of result.observations) {
      const failed = index === 1 && observation.round === 2;
      assert.equal(observation.error, failed ? 'RPC_ERROR' : null);
      assert.equal(observation.block, failed ? null : index === 0
        ? (HEIGHT + BigInt(4 - observation.round)).toString() : (HEIGHT - BigInt(index + 2)).toString());
    }
  }
  assert.deepEqual(report.rounds, [
    { round: 1, startedMs: 240, finishedMs: 360 },
    { round: 2, startedMs: 360, finishedMs: 480 },
    { round: 3, startedMs: 480, finishedMs: 600 },
  ]);
  assert.deepEqual(report.results[0].latencyMs, { min: 120, median: 120, p95: 120, max: 120 });
  assert.deepEqual(report.results[1].latencyMs, { min: 10, median: 10, p95: 10, max: 10 });
  assert.equal(report.durationMs, 600);
  assert.ok(Number.isFinite(Date.parse(report.startedAt)));
  assert.ok(Number.isFinite(Date.parse(report.generatedAt)));
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_SECRET'), false);
  const table = formatTable(report);
  assert.match(table, /Observed \(ms\)/);
  assert.match(table, /Slow node\s+1\s+match.*240–600/m);
  assert.match(table, /Sampling: 3 completed rounds/);
  assert.match(table, /failed attempts and waits between rounds/);
});

test('a round waits for the complete response body and records validation failure before recovery', { timeout: 10000 }, async (t) => {
  let now = 0;
  let body;
  const requests = [];
  const counts = [0, 0];
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const index = Number(new URL(url).pathname.slice(1));
    const request = JSON.parse(options.body);
    requests.push({ index, ...request });
    if (request.method === 'eth_blockNumber' && ++counts[index] === 1 && index === 0) {
      return new Response(new ReadableStream({ start(controller) {
        body = controller;
        controller.enqueue(new TextEncoder().encode('{'));
      } }));
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x1' }));
  });
  const running = benchmark(['http://127.0.0.1/0', 'http://127.0.0.1/1'], { samples: 2, concurrency: 2 });
  await settle();
  assert.equal(requests.length, 4);
  assert.deepEqual(counts, [1, 1]);
  now = 200;
  body.enqueue(new TextEncoder().encode('SYNTHETIC_SECRET invalid JSON'));
  body.close();
  const report = await running;
  assert.deepEqual(counts, [2, 2]);
  assert.deepEqual(report.results[0].observations, [
    { round: 1, startedMs: 0, finishedMs: 200, block: null, error: 'INVALID_RESPONSE' },
    { round: 2, startedMs: 200, finishedMs: 200, block: '1', error: null },
  ]);
  assert.deepEqual(report.rounds, [
    { round: 1, startedMs: 0, finishedMs: 200 }, { round: 2, startedMs: 200, finishedMs: 200 },
  ]);
  assert.equal(report.results[1].observations[0].finishedMs, 0);
  assert.equal(report.results[1].observations[1].startedMs, 200);
  assert.deepEqual(report.results[0].errors, { INVALID_RESPONSE: 1 });
  assert.equal(report.results[0].successRate, 50);
  assert.equal(report.results[0].status, 'degraded');
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_SECRET'), false);
});

test('a run with only failed handshakes and network mismatches has no rounds or invented observations', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    return url.endsWith('/failed') ? new Response('SYNTHETIC_SECRET', { status: 503 })
      : new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x2' }));
  });
  let output = '';
  const code = await main(['--json', '--warmup', '2', '--expected-chain', '1',
    'http://127.0.0.1/failed', 'http://127.0.0.1/wrong'], {},
  { write: (value) => { output += value; } }, { write: assert.fail });
  assert.equal(code, 1);
  const report = JSON.parse(output);
  assert.deepEqual(report.rounds, []);
  assert.deepEqual(report.results.map((r) => r.observations), [[], []]);
  assert.deepEqual(report.results.map((r) => r.status), ['unreachable', 'mismatch']);
  assert.deepEqual(report.results.map((r) => r.warmup.attempts), [0, 0]);
  assert.deepEqual(requests.map((r) => r.method), ['eth_chainId', 'eth_chainId']);
  assert.match(formatTable(report), /Sampling: 0 completed rounds/);
  assert.match(formatTable(report), /^RPC 1.*\s—$/m);
  assert.equal(output.includes('SYNTHETIC_SECRET'), false);
});
