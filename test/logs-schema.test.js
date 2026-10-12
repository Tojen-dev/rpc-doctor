import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(readFileSync(new URL('../schemas/report-v1.schema.json', import.meta.url))));
const fixture = name => JSON.parse(readFileSync(new URL(`../examples/reports/${name}.json`, import.meta.url)));
const valid = report => assert.equal(validate(report), true, JSON.stringify(validate.errors));
const edit = (report, path, value, remove = false) => {
  const copy = structuredClone(report); const keys = path.split('.'); const last = keys.pop(); const parent = keys.reduce((obj, key) => obj[key], copy);
  if (remove) delete parent[last]; else parent[last] = value; return copy;
};

test('independent log fixtures cover empty/max counts, removed entries, errors and all-probe skips', () => {
  const report = fixture('logs-outcomes-v1'); valid(report);
  assert.equal(report.schemaVersion, 1); assert.deepEqual(report.results.map(r => r.status), Array(4).fill('healthy'));
  assert.deepEqual(report.results.map(r => [r.logs.status, r.logs.logCount, r.logs.removedCount, r.logs.error]),
    [['success', 0, 0, null], ['success', 1000, 2, null], ['unsupported', null, null, 'RPC_ERROR'], ['error', null, null, 'TIMEOUT']]);
  assert.equal(report.settings.logs.fromBlock, '9007199254740993'); assert.equal(report.settings.logs.toBlock, '9007199254741092');
  const skipped = fixture('logs-skipped-v1'); valid(skipped);
  assert.deepEqual(skipped.results.map(r => r.logs.skipReason), ['handshake_failed', 'network_mismatch']);
  assert.ok(skipped.results.every(r => r.logs.attempts === 0 && r.logs.startedMs === null && r.historicalBlock.attempts === 0 && r.call.attempts === 0));
  assert.equal(skipped.logsPhase.durationMs, 0);
});

test('optional log schema additions enforce every present member, types and bounds while allowing extensions', () => {
  const report = fixture('logs-outcomes-v1');
  for (const path of ['settings.logs', 'logsPhase', 'results.0.logs']) valid(edit(report, path, undefined, true));
  for (const path of [
    ...['fromBlock', 'toBlock', 'address', 'topic0'].map(k => `settings.logs.${k}`),
    ...['startedMs', 'finishedMs', 'durationMs'].map(k => `logsPhase.${k}`),
    ...['status', 'attempts', 'logCount', 'removedCount', 'error', 'skipReason', 'startedMs', 'finishedMs', 'durationMs'].map(k => `results.0.logs.${k}`),
  ]) assert.equal(validate(edit(report, path, undefined, true)), false, `missing ${path}`);
  for (const [path, values] of [
    ['settings.logs', [null, []]], ['logsPhase', [null, []]], ['results.0.logs', [null, []]],
    ...['fromBlock', 'toBlock'].map(k => [`settings.logs.${k}`, [null, 0, '-1', '01', '0x1', '1\n', '9'.repeat(79)]]),
    ...[['address', 20], ['topic0', 32]].map(([k, n]) => [`settings.logs.${k}`, [0, '0x', [], `0x${'AB'.repeat(n)}`, `0x${'ab'.repeat(n)}\n`, `0x${'ab'.repeat(n + 1)}`]]),
    ['results.0.logs.status', [null, 'null', 'found', 'partial', 0]], ['results.0.logs.attempts', [-1, 2, 0.5, '1', null]],
    ...['logCount', 'removedCount'].map(k => [`results.0.logs.${k}`, [-1, 1001, 0.5, '0']]),
    ['results.0.logs.error', ['LIMIT', -32601, 'SYNTHETIC_SECRET']], ['results.0.logs.skipReason', ['', 'unknown', 0]],
    ...['startedMs', 'finishedMs', 'durationMs'].map(k => [`logsPhase.${k}`, [-1, null, '1', 0.5]]),
    ...['startedMs', 'finishedMs', 'durationMs'].map(k => [`results.0.logs.${k}`, [-1, '1', 0.5]]),
  ]) for (const value of values) assert.equal(validate(edit(report, path, value)), false, `accepted ${path}`);
  for (const [path, values] of [
    ...['fromBlock', 'toBlock'].map(k => [`settings.logs.${k}`, ['0', (2n ** 256n - 1n).toString()]]),
    ...['address', 'topic0'].map(k => [`settings.logs.${k}`, [null]]),
    ...['logCount', 'removedCount'].map(k => [`results.0.logs.${k}`, [0, 1000, null]]),
    ['results.0.logs.attempts', [0, 1]], ...['startedMs', 'finishedMs', 'durationMs'].map(k => [`results.0.logs.${k}`, [0, null]]),
  ]) for (const value of values) valid(edit(report, path, value));
  for (const path of ['settings.logs.future', 'logsPhase.future', 'results.0.logs.future']) valid(edit(report, path, { additive: true }));
  // Cross-field consistency (including range and removed <= logCount) is semantic.
  valid(edit(report, 'results.0.logs.removedCount', 1000));
});

test('real log demo reports validate independently of measured errors, strict policy and previous probes', () => {
  for (const earlier of [[], ['--historical-block', '0', '--call-to', `0x${'00'.repeat(20)}`, '--call-data', '0x', '--call-block', '0']]) {
    for (const [extra, code] of [[[], 0], [['--strict'], 1], [['--strict', '--max-failures', '1', '--lag-threshold', '6'], 0], [['--expected-chain', '2'], 1]]) {
      const r = spawnSync(process.execPath, ['bin/rpc-doctor.js', '--demo', '--samples', '3', '--logs-from', '0xF', '--logs-to', '15',
        '--logs-address', `0x${'ab'.repeat(20)}`, '--logs-topic0', `0x${'11'.repeat(32)}`, '--json', ...earlier, ...extra], { encoding: 'utf8', timeout: 10000 });
      assert.equal(r.status, code, r.stderr); assert.equal(r.stderr, ''); const report = JSON.parse(r.stdout); valid(report);
      assert.equal(report.settings.logs.fromBlock, '15'); assert.equal(report.settings.logs.toBlock, '15');
      assert.deepEqual(report.results.map(r => r.logs.status), extra.includes('--expected-chain') ? ['skipped', 'skipped', 'skipped'] : ['success', 'success', 'unsupported']);
      if (!extra.includes('--expected-chain')) {
        assert.deepEqual(report.results.map(r => r.logs.logCount), [1, 0, null]); assert.deepEqual(report.results.map(r => r.successes), [3, 3, 2]);
        if (earlier.length) { assert.deepEqual(report.results.map(r => r.call.status), ['success', 'success', 'error']); assert.deepEqual(report.results.map(r => r.historicalBlock.status), ['found', 'null', 'unsupported']); }
      }
    }
  }
});
