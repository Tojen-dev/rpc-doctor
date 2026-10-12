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

test('all older fixtures remain valid; independent finality fixtures cover outcomes, exact numbers and all-probe skips', () => {
  for (const name of readdirSync(new URL('../examples/reports/', import.meta.url)).filter(n => n.endsWith('.json'))) valid(fixture(name.slice(0, -5)));
  const report = fixture('finality-outcomes-v1');
  assert.equal(report.schemaVersion, 1); assert.deepEqual(report.results.map(r => r.status), Array(4).fill('healthy'));
  assert.deepEqual(report.results.flatMap(r => Object.values(r.finality).map(f => [f.status, f.number, f.error, f.rpcErrorKind])), [
    ['found', '0', null, null], ['found', '9007199254740993', null, null], ['null', null, null, null], ['error', null, 'RPC_ERROR', 'invalid_params'],
    ['unsupported', null, 'RPC_ERROR', 'method_unavailable'], ['error', null, 'RPC_ERROR', 'other'], ['error', null, 'HTTP_ERROR', null], ['error', null, 'INVALID_RESULT', null],
  ]);
  const skipped = fixture('finality-skipped-v1');
  assert.deepEqual(skipped.results.map(r => r.finality.safe.skipReason), ['handshake_failed', 'network_mismatch']);
  assert.ok(skipped.results.every(r => Object.values(r.finality).every(f => f.attempts === 0 && f.startedMs === null && f.durationMs === null) && r.historicalBlock.attempts === 0 && r.call.attempts === 0 && r.logs.attempts === 0));
  assert.equal(skipped.finalityPhase.durationMs, 0);
});

test('optional finality v1 additions require every new member and validate types/enums/bounds without disallowing extensions', () => {
  const report = fixture('finality-outcomes-v1');
  for (const path of ['settings.finality', 'finalityPhase', 'results.0.finality']) valid(edit(report, path, undefined, true));
  for (const path of ['results.0.finality.safe', 'results.0.finality.finalized', ...['startedMs', 'finishedMs', 'durationMs'].map(k => `finalityPhase.${k}`),
    ...['safe', 'finalized'].flatMap(tag => ['status', 'attempts', 'number', 'hash', 'error', 'rpcErrorKind', 'skipReason', 'startedMs', 'finishedMs', 'durationMs'].map(k => `results.0.finality.${tag}.${k}`)),
  ]) assert.equal(validate(edit(report, path, undefined, true)), false, `missing ${path}`);
  for (const [path, values] of [
    ['settings.finality', [false, null, 1, 'true', {}]],
    ...['finalityPhase', 'results.0.finality', 'results.0.finality.safe', 'results.0.finality.finalized'].map(k => [k, [null, [], true]]),
    ...['startedMs', 'finishedMs', 'durationMs'].map(k => [`finalityPhase.${k}`, [-1, null, '1', 0.5]]),
    ...['safe', 'finalized'].flatMap(tag => [
      [`results.0.finality.${tag}.status`, [null, 'success', 'finalized', 0]],
      [`results.0.finality.${tag}.attempts`, [-1, 2, 0.5, '1', null]],
      [`results.0.finality.${tag}.number`, [0, '-1', '01', '0x1', '1\n', '9'.repeat(79)]],
      [`results.0.finality.${tag}.hash`, [0, '0x', [], `0x${'AB'.repeat(32)}`, `0x${'ab'.repeat(32)}\n`, `0x${'ab'.repeat(33)}`]],
      [`results.0.finality.${tag}.error`, ['INVALID_PARAMS', -32601, 'SYNTHETIC_SECRET']],
      [`results.0.finality.${tag}.rpcErrorKind`, ['unsupported_tag', -32602, 'SYNTHETIC_SECRET']],
      [`results.0.finality.${tag}.skipReason`, ['', 'unknown', 0]],
      ...['startedMs', 'finishedMs', 'durationMs'].map(k => [`results.0.finality.${tag}.${k}`, [-1, '1', 0.5]]),
    ]),
  ]) for (const value of values) assert.equal(validate(edit(report, path, value)), false, `accepted ${path}`);
  for (const tag of ['safe', 'finalized']) {
    for (const [key, values] of [
      ['number', [null, '0', (2n ** 256n - 1n).toString()]], ['hash', [null]], ['attempts', [0, 1]],
      ['rpcErrorKind', [null, 'method_unavailable', 'invalid_params', 'other']],
      ...['startedMs', 'finishedMs', 'durationMs'].map(k => [k, [0, null]]),
    ]) for (const value of values) valid(edit(report, `results.0.finality.${tag}.${key}`, value));
  }
  for (const path of ['finalityPhase.future', 'results.0.finality.future', 'results.0.finality.safe.future', 'results.0.finality.finalized.future']) valid(edit(report, path, { additive: true }));
});

test('real finality demo validates for default/strict health 0/1 and skips with all previous probes', () => {
  for (const earlier of [[], ['--historical-block', '0', '--call-to', `0x${'00'.repeat(20)}`, '--call-data', '0x', '--call-block', '0', '--logs-from', '0', '--logs-to', '0']]) {
    for (const [extra, code] of [[[], 0], [['--strict'], 1], [['--strict', '--max-failures', '1', '--lag-threshold', '6'], 0], [['--expected-chain', '2'], 1]]) {
      const r = spawnSync(process.execPath, ['bin/rpc-doctor.js', '--demo', '--samples', '3', '--finality', '--json', ...earlier, ...extra], { encoding: 'utf8', timeout: 10000 });
      assert.equal(r.status, code, r.stderr); assert.equal(r.stderr, ''); const report = JSON.parse(r.stdout); valid(report);
      assert.equal(report.settings.finality, true);
      assert.deepEqual(report.results.map(r => r.finality.safe.status), extra.includes('--expected-chain') ? ['skipped', 'skipped', 'skipped'] : ['found', 'null', 'unsupported']);
      assert.deepEqual(report.results.map(r => r.finality.finalized.status), extra.includes('--expected-chain') ? ['skipped', 'skipped', 'skipped'] : ['found', 'error', 'error']);
      if (!extra.includes('--expected-chain')) {
        assert.deepEqual(report.results.map(r => r.successes), [3, 3, 2]);
        assert.deepEqual(report.results.map(r => r.finality.finalized.rpcErrorKind), [null, 'invalid_params', 'other']);
        if (earlier.length) { assert.deepEqual(report.results.map(r => r.logs.status), ['success', 'success', 'unsupported']); assert.deepEqual(report.results.map(r => r.call.status), ['success', 'success', 'error']); assert.deepEqual(report.results.map(r => r.historicalBlock.status), ['found', 'null', 'unsupported']); }
      }
    }
  }
});
