import test from 'node:test';
import assert from 'node:assert/strict';
import { latencyStats } from '../src/benchmark.js';
import { main } from '../src/cli.js';

// Expected values are analytic fixtures, not a second implementation of the
// aggregation: [2,4,4,4,5,5,7,9] has mean 5 / variance 4; the outlier set has
// mean 21 / variance 1600; 1..100 has variance (100² - 1) / 12 = 833.25.
for (const [name, values, expected] of [
  ['empty', [], { min: null, median: null, p95: null, max: null, stddev: null, p99: null }],
  ['one success', [1.23456], { min: 1.23, median: 1.23, p95: 1.23, max: 1.23, stddev: 0, p99: 1.23 }],
  ['identical', [7.125, 7.125, 7.125], { min: 7.13, median: 7.13, p95: 7.13, max: 7.13, stddev: 0, p99: 7.13 }],
  ['fractions', [0.1, 0.4], { min: 0.1, median: 0.25, p95: 0.4, max: 0.4, stddev: 0.15, p99: 0.4 }],
  ['unsorted', [4, 1, 3, 2], { min: 1, median: 2.5, p95: 4, max: 4, stddev: 1.12, p99: 4 }],
  ['known population variance', [2, 4, 4, 4, 5, 5, 7, 9], { min: 2, median: 4.5, p95: 9, max: 9, stddev: 2, p99: 9 }],
  ['outlier', [1, 1, 1, 1, 101], { min: 1, median: 1, p95: 101, max: 101, stddev: 40, p99: 101 }],
  // Raw stddev is .0035, rounding to 0. Rounding inputs first would yield .005
  // and incorrectly round the deviation to .01 instead.
  ['round only after calculation', [0.002, 0.009], { min: 0, median: 0.01, p95: 0.01, max: 0.01, stddev: 0, p99: 0.01 }],
  ['large common offset', [1000000000004, 1000000000001, 1000000000003, 1000000000002],
    { min: 1000000000001, median: 1000000000002.5, p95: 1000000000004, max: 1000000000004, stddev: 1.12, p99: 1000000000004 }],
  ['99 successes', Array.from({ length: 99 }, (_, i) => 99 - i),
    { min: 1, median: 50, p95: 95, max: 99, stddev: 28.58, p99: 99 }],
  ['100 successes distinguish p99 from max', Array.from({ length: 100 }, (_, i) => 100 - i),
    { min: 1, median: 50.5, p95: 95, max: 100, stddev: 28.87, p99: 99 }],
]) {
  test(`latency statistics: ${name}`, () => {
    const original = [...values];
    assert.deepEqual(latencyStats(values), expected);
    assert.deepEqual(values, original, 'statistics must not reorder the caller’s samples');
  });
}

for (const [name, chain, outcomes, status, exitCode, n, stddev, p99, errors] of [
  ['partial failures', '0x1', [10, null, 40], 'degraded', 0, 2, 15, 40, { RPC_ERROR: 1 }],
  ['one success among failures', '0x1', [null, 10, null], 'degraded', 0, 1, 0, 10, { RPC_ERROR: 2 }],
  ['all measured failures', '0x1', [null, null, null], 'unreachable', 1, 0, null, null, { RPC_ERROR: 3 }],
  ['network mismatch', '0x2', [], 'mismatch', 1, 0, null, null, {}],
  ['invalid handshake', '0x01', [], 'unreachable', 1, 0, null, null, { INVALID_RESULT: 1 }],
]) {
  test(`JSON and table preserve ${name} with latency sample counts and caveats`, async (t) => {
    let now = 0;
    let calls = [];
    t.mock.method(performance, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const request = JSON.parse(options.body);
      const index = calls.length;
      calls.push(request);
      const duration = outcomes[index - 1];
      // The 900ms handshake and failed 250ms calls must never enter statistics.
      now += index === 0 ? 900 : duration ?? 250;
      const payload = index === 0 ? { result: chain } : duration === null
        ? { error: { code: -32000, message: 'SYNTHETIC_SECRET' } }
        : { result: '0x20000000000001' };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...payload }));
    });
    for (const format of [[], ['--json']]) {
      calls = [];
      now = 0;
      let out = '';
      let err = '';
      const code = await main(['--samples', '3', '--expected-chain', '1', '--label', 'Node', ...format],
        { RPC_DOCTOR_ENDPOINTS_JSON: '["http://127.0.0.1/SYNTHETIC_SECRET?key=SYNTHETIC_SECRET"]' },
        { write: (s) => { out += s; } }, { write: (s) => { err += s; } });
      assert.equal(code, exitCode);
      assert.equal(err, '');
      assert.equal(calls.length, 1 + outcomes.length, 'statistics add no RPC requests');
      assert.deepEqual(calls.map((r) => r.method), ['eth_chainId', ...outcomes.map(() => 'eth_blockNumber')]);
      assert.doesNotMatch(out, /SYNTHETIC_SECRET|127\.0\.0\.1|https?:/);
      let notes;
      if (format.length) {
        const report = JSON.parse(out);
        const row = report.results[0];
        assert.equal(report.schemaVersion, 1);
        assert.equal(row.status, status);
        assert.equal(row.attempts, outcomes.length);
        assert.equal(row.successes, n);
        assert.equal(row.latencySampleCount, n);
        assert.equal(row.latencyMs.stddev, stddev);
        assert.equal(row.latencyMs.p99, p99);
        assert.deepEqual(row.errors, errors);
        assert.equal(row.latestBlock, n ? '9007199254740993' : null);
        assert.equal(row.lagBlocks, null);
        if (!n) assert.deepEqual(row.latencyMs, { min: null, median: null, p95: null, max: null, stddev: null, p99: null });
        notes = report.latencyNotes.join('\n');
      } else {
        const headers = out.split('\n').find((line) => line.startsWith('Endpoint')).split(/ {2,}/);
        const cells = out.split('\n').find((line) => line.startsWith('Node ')).split(/ {2,}/);
        const row = Object.fromEntries(headers.map((header, i) => [header, cells[i]]));
        assert.equal(row.Status, status);
        assert.equal(row.OK, `${n}/${outcomes.length}`);
        assert.equal(row['Latency n'], String(n));
        assert.equal(row.Stddev, stddev === null ? '—' : `${stddev.toFixed(1)}ms`);
        assert.equal(row.p99, p99 === null ? '—' : `${p99.toFixed(1)}ms`);
        for (const [error, count] of Object.entries(errors)) assert.ok(out.includes(`Node: ${error} × ${count}`));
        notes = out;
      }
      assert.match(notes, /successful measured calls only/);
      assert.match(notes, /failed attempts remain in Errors/);
      assert.match(notes, /population standard deviation \(divisor n\)/);
      assert.match(notes, /n=0 is unavailable; n=1 gives 0ms/);
      assert.match(notes, /does not establish stability/);
      assert.match(notes, /Short samples cannot reliably estimate tails/);
      assert.match(notes, /Nearest-rank p99 equals max for 0 < n < 100/);
    }
  });
}
