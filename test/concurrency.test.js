import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmark } from '../src/benchmark.js';
import { serve, reply } from './helpers.js';

const HEIGHT = 9007199254740993n;

// Requests wait for an explicit response, never an arbitrary scheduling delay.
async function controlledRpcs(t, count) {
  const queue = [];
  const waiters = [];
  const active = new Set();
  const signals = Array.from({ length: count }, () => []);
  const history = Array.from({ length: count }, () => []);
  const peaks = Array(count).fill(0);
  let peak = 0;
  let aborted = 0;
  const servers = await Promise.all(Array.from({ length: count }, (_, index) => serve((req, res) => {
    const record = { index, method: req.method, res };
    const signal = signals[index].shift();
    history[index].push(req.method);
    active.add(record);
    const complete = () => {
      active.delete(record);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { aborted++; complete(); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    peak = Math.max(peak, active.size);
    peaks[index] = Math.max(peaks[index], [...active].filter((r) => r.index === index).length);
    res.once('finish', complete);
    record.closed = new Promise((resolve) => res.once('close', () => { complete(); resolve(); }));
    record.respond = (status = 200) => new Promise((resolve) => {
      res.once('finish', resolve);
      if (status !== 200) res.writeHead(status).end('SYNTHETIC_SECRET');
      else reply(res, req.method === 'eth_chainId' ? '0x1' : `0x${(HEIGHT + BigInt(index)).toString(16)}`);
    });
    if (waiters.length) waiters.shift()(record);
    else queue.push(record);
  })));
  for (const server of servers) t.after(server.close);
  // Pass through to real fetch; only observe cancellation. A provider's socket
  // close can arrive after the client has aborted and started its next request.
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const index = servers.findIndex((server) => server.url === new URL(url).origin);
    signals[index].push(options.signal);
    return fetch(url, options);
  });
  return {
    urls: servers.map((server) => server.url), history, peaks,
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve)),
    get peak() { return peak; },
    get active() { return active.size; },
    get aborted() { return aborted; },
  };
}

for (const [concurrency, count] of [[undefined, 6], [1, 3], [3, 6], [20, 2], [20, 20]]) {
  test(`concurrency ${concurrency ?? 'default 4'} bounds every request across ${count} endpoints`, { timeout: 15000 }, async (t) => {
    const rpc = await controlledRpcs(t, count);
    const workers = Math.min(concurrency ?? 4, count);
    const labels = Array.from({ length: count }, (_, index) => `Node ${index + 1}`);
    const running = benchmark(rpc.urls, { samples: 2, concurrency, labels });
    const initial = [];
    for (let i = 0; i < workers; i++) initial.push(await rpc.next());
    assert.ok(initial.every((r) => r.method === 'eth_chainId'));
    assert.deepEqual(initial.map((r) => r.index).sort((a, b) => a - b), Array.from({ length: workers }, (_, i) => i));
    // Hold the first endpoint's handshake until all other endpoints finish.
    // Remaining workers must cover both handshakes and samples within the same cap.
    const held = workers > 1 ? initial.splice(initial.findIndex((r) => r.index === 0), 1)[0] : null;
    const samples = Array(count).fill(0);
    const completionOrder = [];
    async function respond(record) {
      await record.respond();
      if (record.method === 'eth_blockNumber' && ++samples[record.index] === 2) completionOrder.push(record.index);
    }
    for (const record of initial) await respond(record);
    const beforeHeld = (count - (held ? 1 : 0)) * 3;
    for (let sent = initial.length; sent < beforeHeld; sent++) await respond(await rpc.next());
    if (held) {
      await respond(held);
      await respond(await rpc.next());
      await respond(await rpc.next());
    }
    const report = await running;
    assert.equal(rpc.peak, workers);
    assert.deepEqual(rpc.peaks, Array(count).fill(1));
    assert.equal(rpc.active, 0);
    assert.deepEqual(rpc.history, Array.from({ length: count }, () => ['eth_chainId', 'eth_blockNumber', 'eth_blockNumber']));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.settings.concurrency, workers);
    assert.deepEqual(report.results.map((r) => r.endpoint), labels);
    assert.deepEqual(report.results.map((r) => r.latestBlock), Array.from({ length: count }, (_, i) => (HEIGHT + BigInt(i)).toString()));
    assert.ok(report.results.every((r) => r.attempts === 2 && r.successes === 2 && Object.keys(r.errors).length === 0));
    if (held) assert.equal(completionOrder.at(-1), 0);
    else assert.deepEqual(completionOrder, Array.from({ length: count }, (_, i) => i));
  });
}

test('failures and body timeouts free workers, retain error counts, and respect the request cap', { timeout: 15000 }, async (t) => {
  const rpc = await controlledRpcs(t, 5);
  const running = benchmark(rpc.urls, { samples: 2, concurrency: 2, timeoutMs: 1000 });
  const samples = Array(5).fill(0);
  const stalled = [];
  // Two handshakes fail, while the other three endpoints each attempt two samples.
  for (let i = 0; i < 11; i++) {
    const record = await rpc.next();
    const { index, method, res } = record;
    const sample = method === 'eth_blockNumber' ? ++samples[index] : 0;
    if (index === 2 || (index === 3 && sample === 1)) {
      res.writeHead(200, { 'content-type': 'application/json' }).flushHeaders();
      stalled.push(record.closed);
    } else {
      await record.respond(index === 0 ? 503 : index === 1 && sample === 1 ? 429 : 200);
    }
  }
  const report = await running;
  await Promise.all(stalled);
  assert.equal(rpc.aborted, 2);
  assert.equal(rpc.peak, 2);
  assert.deepEqual(rpc.peaks, [1, 1, 1, 1, 1]);
  assert.equal(rpc.active, 0);
  assert.deepEqual(rpc.history.map((requests) => requests.length), [1, 3, 1, 3, 3]);
  assert.deepEqual(report.results.map((r) => [r.endpoint, r.attempts, r.successes, r.status, r.errors]), [
    ['RPC 1', 0, 0, 'unreachable', { HTTP_ERROR: 1 }],
    ['RPC 2', 2, 1, 'degraded', { RATE_LIMITED: 1 }],
    ['RPC 3', 0, 0, 'unreachable', { TIMEOUT: 1 }],
    ['RPC 4', 2, 1, 'degraded', { TIMEOUT: 1 }],
    ['RPC 5', 2, 2, 'healthy', {}],
  ]);
  assert.equal(report.results[4].latestBlock, (HEIGHT + 4n).toString());
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_SECRET'), false);
});

test('invalid concurrency is rejected before any RPC request', async (t) => {
  let requests = 0;
  const server = await serve((req, res) => { requests++; reply(res, '0x1'); });
  t.after(server.close);
  for (const concurrency of [null, false, '1', 0, -1, 1.5, 21, Infinity, NaN, [], {}]) {
    await assert.rejects(benchmark([server.url], { concurrency }), /Concurrency must be an integer from 1 to 20/);
  }
  assert.equal(requests, 0);
});
