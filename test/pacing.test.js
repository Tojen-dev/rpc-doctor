import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmark } from '../src/benchmark.js';
import { formatTable } from '../src/format.js';
import { main } from '../src/cli.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const response = (id, result = '0x1') => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));

// Advance only the monotonic measurement clock and explicitly fire timers.
// Wall-clock dates stay real; no test sleeps for an interval or RPC timeout.
function fakeClock(t, initial = 0) {
  let now = initial;
  let nextId = 0;
  const timers = new Map();
  const fired = [];
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { id, callback, delay, due: now + delay });
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', (id) => timers.delete(id));
  return {
    timers, fired,
    get now() { return now; },
    advance(ms) { now += ms; },
    async fireNext(offset = 0) {
      const timer = [...timers.values()].sort((a, b) => a.due - b.due)[0];
      assert.ok(timer, 'expected a pending timer');
      assert.ok(timer.due + offset >= now, 'monotonic clock cannot move backwards');
      now = timer.due + offset;
      timers.delete(timer.id);
      fired.push({ delay: timer.delay, at: now });
      timer.callback();
      await settle();
    },
  };
}

test('pacing waits only for remaining time, handles long failed rounds, and never catches up after a late timer', async (t) => {
  const clock = fakeClock(t);
  const calls = [];
  const durations = [20, 30, 10, 120, 10, 10, 10];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = JSON.parse(options.body);
    const index = calls.length;
    calls.push({ ...request, started: clock.now });
    clock.advance(durations[index]);
    if (index === 3) return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32000, message: 'SYNTHETIC_SECRET' },
    }));
    return response(request.id, index === 1 ? '0xffffffffffffffffffff' : '0x1');
  });
  const running = benchmark(['http://127.0.0.1/SYNTHETIC_SECRET'], { warmup: 1, samples: 5, intervalMs: 100 });
  await settle();
  assert.deepEqual(calls.map((r) => r.started), [0, 20, 50]);
  assert.equal(clock.fired.length, 0, 'no wait before first round or during preparation');
  assert.equal(clock.timers.size, 1);
  await clock.fireNext();
  assert.deepEqual(calls.map((r) => r.started), [0, 20, 50, 150, 270]);
  assert.equal(clock.timers.size, 1, 'a long round skips its wait, then the next short round waits');
  await clock.fireNext(50);
  assert.equal(calls.at(-1).started, 420);
  assert.equal([...clock.timers.values()][0].due, 520, 'next deadline uses actual start, without catch-up');
  await clock.fireNext();
  const report = await running;
  assert.deepEqual(clock.fired, [{ delay: 90, at: 150 }, { delay: 90, at: 420 }, { delay: 90, at: 520 }]);
  assert.equal(clock.timers.size, 0, 'no final wait');
  assert.equal(report.durationMs, 530);
  assert.equal(report.pacingWaitMs, 320, 'account actual waiting, including a late wake-up');
  assert.equal(report.settings.intervalMs, 100);
  assert.deepEqual(report.rounds, [
    { round: 1, startedMs: 50, finishedMs: 60 }, { round: 2, startedMs: 150, finishedMs: 270 },
    { round: 3, startedMs: 270, finishedMs: 280 }, { round: 4, startedMs: 420, finishedMs: 430 },
    { round: 5, startedMs: 520, finishedMs: 530 },
  ]);
  const row = report.results[0];
  assert.deepEqual(row.observations.map((o) => [o.startedMs, o.finishedMs]), [[50, 60], [150, 270], [270, 280], [420, 430], [520, 530]]);
  assert.deepEqual(row.latencyMs, { min: 10, median: 10, p95: 10, max: 10, stddev: 0, p99: 10 });
  assert.deepEqual(row.errors, { RPC_ERROR: 1 });
  assert.equal(row.observations[1].error, 'RPC_ERROR');
  assert.equal(row.observations[1].block, null);
  assert.equal(row.status, 'degraded');
  assert.equal(row.attempts, 5);
  assert.equal(row.successes, 4);
  assert.equal(row.latencySampleCount, 4);
  assert.equal(row.latestBlock, '1');
  assert.equal(row.warmup.durationMs, 30);
  assert.equal(new Set(calls.map((r) => r.id)).size, 7);
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_SECRET'), false);
  assert.match(formatTable(report), /Round interval: 100ms minimum between starts · Pacing wait: 320ms/);
  assert.match(formatTable(report), /50–530/);
});

test('fractional monotonic starts and an early wake-up cannot shorten the interval', async (t) => {
  const clock = fakeClock(t, 0.1);
  const starts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'eth_blockNumber') starts.push(clock.now);
    clock.advance(0.4);
    return response(request.id);
  });
  const running = benchmark(['http://127.0.0.1'], { samples: 2, intervalMs: 1 });
  await settle();
  assert.deepEqual(starts, [0.5]);
  await clock.fireNext(-0.5);
  assert.deepEqual(starts, [0.5], 'early callback must recheck the unrounded deadline');
  assert.equal(clock.timers.size, 1);
  await clock.fireNext();
  const report = await running;
  assert.ok(starts[1] - starts[0] >= 1);
  assert.equal(clock.fired.length, 2);
  assert.equal(clock.timers.size, 0);
  assert.equal(report.pacingWaitMs, 2);
  assert.deepEqual(report.results[0].latencyMs, { min: 0.4, median: 0.4, p95: 0.4, max: 0.4, stddev: 0, p99: 0.4 });
});

for (const [name, options, rejected] of [
  ['default interval', { samples: 3 }, false], ['zero interval', { samples: 3, intervalMs: 0 }, false],
  ['one round with maximum interval', { samples: 1, intervalMs: 60000 }, false],
  ['no accepted endpoints', { samples: 3, intervalMs: 60000, expectedChain: '1' }, true],
]) {
  test(`${name} schedules no pacing timers`, async (t) => {
    const clock = fakeClock(t);
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, request) => {
      const rpc = JSON.parse(request.body);
      calls.push(rpc);
      clock.advance(5);
      if (rejected && url.endsWith('/failed')) return new Response('SYNTHETIC_SECRET', { status: 503 });
      return response(rpc.id, rejected ? '0x2' : '0x1');
    });
    const report = await benchmark(rejected ? ['http://127.0.0.1/failed', 'http://127.0.0.1/wrong'] : ['http://127.0.0.1'], options);
    assert.equal(clock.timers.size, 0);
    assert.equal(clock.fired.length, 0);
    assert.equal(report.rounds.length, rejected ? 0 : options.samples);
    assert.equal(calls.length, rejected ? 2 : 1 + options.samples);
    assert.equal(report.durationMs, calls.length * 5);
    if (options.intervalMs) {
      assert.equal(report.pacingWaitMs, 0);
      assert.equal(report.settings.intervalMs, 60000);
    } else {
      assert.equal(Object.hasOwn(report, 'pacingWaitMs'), false);
      assert.equal(Object.hasOwn(report.settings, 'intervalMs'), false);
      assert.doesNotMatch(formatTable(report), /Round interval|Pacing wait/);
    }
    if (rejected) assert.deepEqual(report.results.map((r) => [r.status, r.observations]), [['unreachable', []], ['mismatch', []]]);
  });
}

test('a queued round finishes through timeout before pacing; later rounds keep concurrency, errors, and exact blocks', async (t) => {
  const clock = fakeClock(t);
  const calls = [];
  const pending = new Map();
  let peak = 0;
  const height = 9007199254740993n;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const index = Number(new URL(url).pathname.slice(1));
    const request = JSON.parse(options.body);
    calls.push({ index, ...request, started: clock.now });
    if (request.method === 'eth_chainId') return Promise.resolve(response(request.id));
    return new Promise((resolve, reject) => {
      assert.equal(pending.has(index), false);
      const onAbort = () => { pending.delete(index); reject(new Error('SYNTHETIC_SECRET')); };
      options.signal.addEventListener('abort', onAbort, { once: true });
      pending.set(index, (status = 200) => {
        pending.delete(index);
        options.signal.removeEventListener('abort', onAbort);
        clock.advance(10);
        resolve(status === 200 ? response(request.id, `0x${(height - BigInt(index * 2)).toString(16)}`)
          : new Response('SYNTHETIC_SECRET', { status }));
      });
      peak = Math.max(peak, pending.size);
    });
  });
  const running = benchmark([0, 1, 2].map((i) => `http://127.0.0.1/${i}`), {
    samples: 2, intervalMs: 100, timeoutMs: 40, concurrency: 2, reference: 1, labels: ['Slow', 'Fast', 'Queued'],
  });
  await settle();
  assert.deepEqual([...pending.keys()], [0, 1]);
  pending.get(1)(); await settle();
  pending.get(2)(); await settle();
  assert.deepEqual([...pending.keys()], [0]);
  assert.equal(clock.timers.size, 1, 'only the unfinished RPC timeout remains');
  await clock.fireNext();
  assert.equal(clock.now, 40);
  assert.equal(pending.size, 0);
  assert.equal(clock.timers.size, 1, 'pacing starts only after the timeout settles');
  await clock.fireNext();
  assert.equal(clock.now, 100);
  assert.deepEqual([...pending.keys()], [0, 1]);
  pending.get(0)(); await settle();
  pending.get(1)(429); await settle();
  pending.get(2)(); await settle();
  const report = await running;
  assert.equal(peak, 2);
  assert.equal(clock.timers.size, 0);
  assert.equal(report.pacingWaitMs, 60);
  assert.equal(report.durationMs, 130);
  assert.deepEqual(calls.filter((r) => r.method === 'eth_blockNumber').map((r) => [r.index, r.started]),
    [[0, 0], [1, 0], [2, 10], [0, 100], [1, 100], [2, 110]]);
  assert.equal(new Set(calls.map((r) => r.id)).size, 9);
  assert.deepEqual(report.rounds, [{ round: 1, startedMs: 0, finishedMs: 40 }, { round: 2, startedMs: 100, finishedMs: 130 }]);
  assert.deepEqual(report.results.map((r) => r.endpoint), ['Slow', 'Fast', 'Queued']);
  assert.deepEqual(report.results.map((r) => r.errors), [{ TIMEOUT: 1 }, { RATE_LIMITED: 1 }, {}]);
  assert.deepEqual(report.results.map((r) => r.lagBlocks), [null, '2', '4']);
  assert.equal(report.results[0].latestBlock, height.toString());
  assert.deepEqual(report.results.map((r) => r.latencySampleCount), [1, 1, 2]);
  assert.deepEqual(report.results[0].observations[0], { round: 1, startedMs: 0, finishedMs: 40, block: null, error: 'TIMEOUT' });
  assert.deepEqual(report.results[0].latencyMs, { min: 10, median: 10, p95: 10, max: 10, stddev: 0, p99: 10 });
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_SECRET'), false);
});

test('invalid interval API and CLI input is safely rejected before RPC', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(1); });
  for (const intervalMs of [null, false, '1', -1, 0.5, 60001, Infinity, -Infinity, NaN, [], {}, 1n]) {
    await assert.rejects(benchmark(['http://127.0.0.1'], { intervalMs }), /Interval must be an integer from 0 to 60000 ms/);
  }
  for (const interval of ['', '-1', '-0', '60001', '1.5', '1e2', '0x10', 'Infinity', 'NaN', ' 1', '1\n', '+1', '9'.repeat(400), 'SYNTHETIC_SECRET\x1b']) {
    let out = '';
    let err = '';
    const code = await main([`--interval=${interval}`, 'http://127.0.0.1/SYNTHETIC_SECRET'], {},
      { write: (s) => { out += s; } }, { write: (s) => { err += s; } });
    assert.equal(code, 2);
    assert.equal(out, '');
    assert.equal(err, 'RPC Doctor: Interval must be an integer from 0 to 60000 ms.\n');
  }
  assert.equal(await main(['--interval'], {}, { write: assert.fail }, { write() {} }), 2);
  assert.equal(calls, 0);
});
