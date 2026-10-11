import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';

const schema = JSON.parse(readFileSync(new URL('../schemas/report-v1.schema.json', import.meta.url)));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const fixture = name => JSON.parse(readFileSync(new URL(`../examples/reports/${name}.json`, import.meta.url)));
const valid = report => assert.equal(validate(report), true, JSON.stringify(validate.errors));
const edit = (report, path, value, remove = false) => {
  const copy = structuredClone(report); const keys = path.split('.'); const last = keys.pop();
  const parent = keys.reduce((obj, key) => obj[key], copy);
  if (remove) delete parent[last]; else parent[last] = value;
  return copy;
};

test('independent call fixtures cover empty/max DATA, failures, skipped and combined historical fields', () => {
  const report = fixture('call-outcomes-v1'); valid(report);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.results.map(r => r.status), Array(5).fill('healthy'));
  assert.deepEqual(report.results.map(r => [r.call.status, r.call.returnBytes, r.call.error]),
    [['success', 0, null], ['success', 4096, null], ['unsupported', null, 'RPC_ERROR'], ['error', null, 'RPC_ERROR'], ['error', null, 'INVALID_RESULT']]);
  assert.equal(report.settings.call.block, '9007199254740993');
  assert.equal(report.settings.call.inputBytes, 4096);
  const skipped = fixture('call-skipped-v1'); valid(skipped);
  assert.deepEqual(skipped.results.map(r => r.status), ['unreachable', 'mismatch']);
  assert.deepEqual(skipped.results.map(r => r.call.skipReason), ['handshake_failed', 'network_mismatch']);
  assert.ok(skipped.results.every(r => r.call.attempts === 0 && r.call.startedMs === null && r.historicalBlock.attempts === 0));
  assert.equal(skipped.callPhase.durationMs, 0);
});

test('call additions remain optional but known fields and every present object member are checked', () => {
  const report = fixture('call-outcomes-v1');
  for (const path of ['settings.call', 'callPhase', 'results.0.call']) valid(edit(report, path, undefined, true));
  for (const path of [
    ...['to', 'block', 'gas', 'value', 'inputBytes'].map(k => `settings.call.${k}`),
    ...['startedMs', 'finishedMs', 'durationMs'].map(k => `callPhase.${k}`),
    ...['status', 'attempts', 'returnBytes', 'error', 'skipReason', 'startedMs', 'finishedMs', 'durationMs'].map(k => `results.0.call.${k}`),
  ]) assert.equal(validate(edit(report, path, undefined, true)), false, `missing ${path}`);
  for (const [path, values] of [
    ['settings.call', [null, []]], ['callPhase', [null, []]], ['results.0.call', [null, []]],
    ['settings.call.to', [null, 0, '0x', `0x${'AA'.repeat(20)}`, `0x${'aa'.repeat(20)}\n`, `0x${'aa'.repeat(21)}`]],
    ['settings.call.block', [null, 0, '-1', '01', '0x1', '1\n', '9'.repeat(79)]],
    ['settings.call.gas', [0, 100001, '100000', null]], ['settings.call.value', [0, '1', '0x0', null]],
    ['settings.call.inputBytes', [-1, 0.5, 4097, '0', null]],
    ['results.0.call.status', [null, 'null', 'found', 'revert', 0]],
    ['results.0.call.attempts', [-1, 2, 0.5, '1', null]],
    ['results.0.call.returnBytes', [-1, 4097, 0.5, '0']],
    ['results.0.call.error', ['REVERT', 3, '-32601', 'SYNTHETIC_SECRET']],
    ['results.0.call.skipReason', ['', 'unknown', 0]],
    ...['startedMs', 'finishedMs', 'durationMs'].map(k => [`callPhase.${k}`, [-1, null, '1', 0.5]]),
    ...['startedMs', 'finishedMs', 'durationMs'].map(k => [`results.0.call.${k}`, [-1, '1', 0.5]]),
  ]) for (const value of values) assert.equal(validate(edit(report, path, value)), false, `accepted ${path}`);
  for (const [path, values] of [
    ['settings.call.block', ['0', (2n ** 256n - 1n).toString()]], ['settings.call.inputBytes', [0, 4096]],
    ['results.0.call.returnBytes', [0, 4096, null]], ['results.0.call.attempts', [0, 1]],
    ...['startedMs', 'finishedMs', 'durationMs'].map(k => [`results.0.call.${k}`, [0, null]]),
  ]) for (const value of values) valid(edit(report, path, value));
  for (const path of ['settings.call.future', 'callPhase.future', 'results.0.call.future']) valid(edit(report, path, { additive: true }));
  // Structural validation deliberately does not assert arithmetic or outcome consistency.
  valid(edit(report, 'results.0.call.attempts', 0));
});

test('real call-only and combined demo reports validate including strict 0/1 and all-skipped', () => {
  for (const history of [[], ['--historical-block', '0']]) {
    for (const [extra, code] of [[[], 0], [['--strict'], 1], [['--strict', '--max-failures', '1', '--lag-threshold', '6'], 0], [['--expected-chain', '2'], 1]]) {
      const r = spawnSync(process.execPath, ['bin/rpc-doctor.js', '--demo', '--samples', '3', '--call-to', `0x${'00'.repeat(20)}`,
        '--call-data', '0x', '--call-block', '0xF', '--json', ...history, ...extra], { encoding: 'utf8', timeout: 10000 });
      assert.equal(r.status, code, r.stderr); assert.equal(r.stderr, '');
      const report = JSON.parse(r.stdout); valid(report); assert.equal(report.settings.call.block, '15');
      assert.equal(Object.hasOwn(report, 'historicalPhase'), history.length > 0);
    }
  }
});
