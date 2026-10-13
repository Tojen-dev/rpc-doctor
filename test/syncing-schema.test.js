import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(readFileSync(new URL('../schemas/report-v1.schema.json', import.meta.url))));
const fixture = name => JSON.parse(readFileSync(new URL(`../examples/reports/${name}.json`, import.meta.url)));
const valid = report => assert.equal(validate(report), true, JSON.stringify(validate.errors));
const edit = (report, path, value, remove = false) => {
  const copy = structuredClone(report); const keys = path.split('.'); const last = keys.pop(); const parent = keys.reduce((obj, key) => obj[key], copy);
  if (remove) delete parent[last]; else parent[last] = value; return copy;
};

test('all older fixtures validate; independent sync fixtures distinguish provider state, ordering, unknowns and skips', () => {
  for (const n of readdirSync(new URL('../examples/reports/', import.meta.url)).filter(n => n.endsWith('.json'))) valid(fixture(n.slice(0, -5)));
  const report = fixture('syncing-outcomes-v1');
  assert.equal(report.schemaVersion, 1); assert.deepEqual(report.results.map(r => r.status), Array(6).fill('healthy'));
  assert.deepEqual(report.results.map(r => [r.syncing.status, r.syncing.isSyncing, r.syncing.currentBlock, r.syncing.heightOrder, r.syncing.error]), [
    ['not_syncing', false, null, null, null], ['syncing', true, '0', 'nondecreasing', null], ['syncing', true, '9007199254740993', 'nondecreasing', null],
    ['syncing', true, '3', 'out_of_order', null], ['unsupported', null, null, null, 'RPC_ERROR'], ['error', null, null, null, 'INVALID_RESULT'],
  ]);
  assert.equal(report.results[2].syncing.highestBlock, (2n ** 256n - 1n).toString());
  const skipped = fixture('syncing-skipped-v1'); assert.deepEqual(skipped.results.map(r => r.syncing.skipReason), ['handshake_failed', 'network_mismatch']);
  assert.ok(skipped.results.every(r => r.syncing.attempts === 0 && r.syncing.isSyncing === null && r.syncing.startedMs === null && r.historicalBlock.attempts === 0 && r.call.attempts === 0 && r.logs.attempts === 0 && r.finality.safe.attempts === 0));
  assert.equal(skipped.syncingPhase.durationMs, 0);
});

test('optional syncing schema requires new object members and validates types/bounds/enums while permitting additive fields', () => {
  const report = fixture('syncing-outcomes-v1');
  for (const path of ['settings.syncing', 'syncingPhase', 'results.0.syncing']) valid(edit(report, path, undefined, true));
  for (const path of [...['startedMs', 'finishedMs', 'durationMs'].map(k => `syncingPhase.${k}`),
    ...['status', 'attempts', 'isSyncing', 'startingBlock', 'currentBlock', 'highestBlock', 'heightOrder', 'error', 'skipReason', 'startedMs', 'finishedMs', 'durationMs'].map(k => `results.0.syncing.${k}`),
  ]) assert.equal(validate(edit(report, path, undefined, true)), false, `missing ${path}`);
  for (const [path, values] of [
    ['settings.syncing', [false, null, 1, 'true', {}]], ...['syncingPhase', 'results.0.syncing'].map(k => [k, [null, [], true]]),
    ...['startedMs', 'finishedMs', 'durationMs'].map(k => [`syncingPhase.${k}`, [-1, null, '1', 0.5]]),
    ['results.0.syncing.status', [null, 'success', 'false', 'synced', 0]], ['results.0.syncing.attempts', [-1, 2, 0.5, '1', null]],
    ['results.0.syncing.isSyncing', [0, 1, 'false', 'true', {}]],
    ...['startingBlock', 'currentBlock', 'highestBlock'].map(k => [`results.0.syncing.${k}`, [0, '-1', '01', '0x1', '1\n', '9'.repeat(79)]]),
    ['results.0.syncing.heightOrder', [true, 'valid', 'synced', '']], ['results.0.syncing.error', ['INVALID_PARAMS', -32601, 'SYNTHETIC_SECRET']],
    ['results.0.syncing.skipReason', ['', 'unknown', 0]], ...['startedMs', 'finishedMs', 'durationMs'].map(k => [`results.0.syncing.${k}`, [-1, '1', 0.5]]),
  ]) for (const value of values) assert.equal(validate(edit(report, path, value)), false, `accepted ${path}`);
  for (const [key, values] of [
    ['isSyncing', [null, true, false]], ['attempts', [0, 1]], ['heightOrder', [null, 'nondecreasing', 'out_of_order']],
    ...['startingBlock', 'currentBlock', 'highestBlock'].map(k => [k, [null, '0', (2n ** 256n - 1n).toString()]]),
    ...['startedMs', 'finishedMs', 'durationMs'].map(k => [k, [0, null]]),
  ]) for (const value of values) valid(edit(report, `results.0.syncing.${key}`, value));
  for (const path of ['syncingPhase.future', 'results.0.syncing.future']) valid(edit(report, path, { additive: true }));
  // Schema is structural: outcome/order/boolean/counter relationships are not enforced.
  valid(edit(report, 'results.0.syncing.currentBlock', '10'));
});

test('real sync demo validates for default/strict exits 0/1 and all-skipped with prior probes', () => {
  for (const earlier of [[], ['--historical-block', '0', '--call-to', `0x${'00'.repeat(20)}`, '--call-data', '0x', '--call-block', '0', '--logs-from', '0', '--logs-to', '0', '--finality']]) {
    for (const [extra, code] of [[[], 0], [['--strict'], 1], [['--strict', '--max-failures', '1', '--lag-threshold', '6'], 0], [['--expected-chain', '2'], 1]]) {
      const r = spawnSync(process.execPath, ['bin/rpc-doctor.js', '--demo', '--samples', '3', '--syncing', '--json', ...earlier, ...extra], { encoding: 'utf8', timeout: 10000 });
      assert.equal(r.status, code, r.stderr); assert.equal(r.stderr, ''); const p = JSON.parse(r.stdout); valid(p); assert.equal(p.settings.syncing, true);
      const skip = extra.includes('--expected-chain');
      assert.deepEqual(p.results.map(r => r.syncing.status), skip ? ['skipped', 'skipped', 'skipped'] : ['not_syncing', 'syncing', 'unsupported']);
      assert.deepEqual(p.results.map(r => r.syncing.isSyncing), skip ? [null, null, null] : [false, true, null]);
      if (!skip) {
        assert.deepEqual(p.results.map(r => r.successes), [3, 3, 2]); assert.equal(p.results[1].syncing.currentBlock, '250'); assert.equal(p.results[1].syncing.highestBlock, '256');
        assert.doesNotMatch(r.stdout, /knownStates|Synthetic method/);
        if (earlier.length) { assert.deepEqual(p.results.map(r => r.finality.safe.status), ['found', 'null', 'unsupported']); assert.deepEqual(p.results.map(r => r.logs.status), ['success', 'success', 'unsupported']); assert.deepEqual(p.results.map(r => r.call.status), ['success', 'success', 'error']); assert.deepEqual(p.results.map(r => r.historicalBlock.status), ['found', 'null', 'unsupported']); }
      }
    }
  }
});
