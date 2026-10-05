import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import { benchmark } from '../src/benchmark.js';
import { main } from '../src/cli.js';

const schema = JSON.parse(readFileSync(new URL('../schemas/report-v1.schema.json', import.meta.url)));
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);
const fixture = (name) => JSON.parse(readFileSync(new URL(`../examples/reports/${name}.json`, import.meta.url)));
const valid = (data) => assert.equal(validate(data), true, JSON.stringify(validate.errors));
const invalid = (data) => assert.equal(validate(data), false, 'corrupted report must fail validation');
const edit = (data, path, value, remove = false) => {
  const copy = structuredClone(data);
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((node, key) => node[key], copy);
  if (remove) delete parent[last];
  else parent[last] = value;
  return copy;
};

const fixtures = [
  ['legacy-cli-v1', ['healthy']], ['legacy-warmup-v1', ['degraded']], ['legacy-variability-v1', ['healthy']],
  ['success-v1', ['healthy', 'healthy']], ['mixed-v1', ['healthy', 'degraded', 'healthy']],
  ['failure-v1', ['unreachable', 'unreachable']], ['strict-pass-v1', ['healthy']], ['strict-fail-v1', ['mismatch', 'degraded']],
];
for (const [name, statuses] of fixtures) {
  test(`independent synthetic fixture: ${name}`, () => {
    const report = fixture(name);
    valid(report);
    assert.deepEqual(report.results.map(r => r.status), statuses);
    assert.equal(report.schemaVersion, 1);
    if (name === 'strict-pass-v1') assert.equal(report.healthPolicy.passed, true);
    if (name === 'strict-fail-v1') {
      assert.equal(report.healthPolicy.passed, false);
      assert.deepEqual(report.healthPolicy.violations.map(v => v.code), ['NETWORK_MISMATCH', 'MEASURED_FAILURES', 'WARMUP_FAILURES', 'REFERENCE_MISMATCH']);
      assert.equal(report.pacingWaitMs, 90);
    }
    if (name === 'failure-v1') {
      assert.deepEqual(report.results.map(r => r.successes), [0, 0]);
      assert.deepEqual(report.results.map(r => r.attempts), [0, 2]);
      assert.equal(report.results[0].chainId, null);
      assert.equal(report.results[1].latencyMs.p99, null);
      assert.deepEqual(report.results[1].errors, { TIMEOUT: 2 });
    }
    if (name === 'mixed-v1') {
      assert.deepEqual(report.results.map(r => r.lagBlocks), ['0', '5', null]);
      assert.deepEqual(report.results.map(r => r.successes), [2, 1, 2]);
    }
    if (name.startsWith('legacy-')) assert.equal(Object.hasOwn(report, 'healthPolicy'), false);
    if (['legacy-cli-v1', 'legacy-warmup-v1'].includes(name)) {
      for (const key of ['startedAt', 'rounds', 'latencyNotes', 'pacingWaitMs']) assert.equal(Object.hasOwn(report, key), false);
      for (const key of ['observations', 'latencySampleCount']) assert.equal(Object.hasOwn(report.results[0], key), false);
      for (const key of ['stddev', 'p99']) assert.equal(Object.hasOwn(report.results[0].latencyMs, key), false);
    }
  });
}

test('schema is standard Draft 2020-12 and compiles without unknown keywords', () => {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(ajv.validateSchema(schema), true);
  assert.throws(() => new Ajv2020({ strict: true }).compile({ type: 'object', requried: ['x'] }), /unknown keyword/);
});

test('mandatory core and present optional objects reject missing members', () => {
  const report = fixture('strict-fail-v1');
  for (const path of [
    'schemaVersion', 'generatedAt', 'durationMs', 'settings', 'results',
    ...['samples', 'timeoutMs', 'concurrency', 'lagThreshold'].map(k => `settings.${k}`),
    ...['endpoint', 'chainId', 'latestBlock', 'attempts', 'successes', 'errors', 'latencyMs', 'successRate', 'lagBlocks', 'peerCount', 'status'].map(k => `results.0.${k}`),
    ...['min', 'median', 'p95', 'max'].map(k => `results.0.latencyMs.${k}`),
    ...['attempts', 'successes', 'errors', 'durationMs'].map(k => `results.1.warmup.${k}`),
    ...['round', 'startedMs', 'finishedMs'].map(k => `rounds.0.${k}`),
    ...['round', 'startedMs', 'finishedMs', 'block', 'error'].map(k => `results.1.observations.0.${k}`),
    ...['mode', 'maxFailures', 'passed', 'violations', 'uncheckedLagEndpoints', 'notes'].map(k => `healthPolicy.${k}`),
    ...['endpointIndex', 'code', 'message'].map(k => `healthPolicy.violations.0.${k}`),
  ]) {
    const data = edit(report, path, undefined, true);
    assert.equal(validate(data), false, `missing ${path}`);
  }
});

test('known fields reject wrong versions, types, nulls, enums and out-of-bound values', () => {
  const report = fixture('strict-fail-v1');
  const mutations = [
    ['schemaVersion', [0, 2, '1', null]], ['settings', [null, []]], ['results', [null, {}, [], Array(21).fill(report.results[0])]],
    ['durationMs', [-1, 0.5, '30', null]], ['generatedAt', ['yesterday', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00.000Z\n', null]],
    ['startedAt', [1, null]], ['settings.samples', [0, 101, 1.5, '2', null]], ['settings.timeoutMs', [0, 60001]],
    ['settings.concurrency', [0, 21]], ['settings.lagThreshold', [-1, 9007199254740992, '3']],
    ['settings.reference', [0, 21, null, '1']], ['settings.expectedChain', [1, null, '01', '0x1', '1\n', '9'.repeat(79)]],
    ['settings.warmup', [0, 21, '1', null]], ['settings.intervalMs', [0, 60001, null, '100']],
    ['pacingWaitMs', [null, -1, 1.5, '90']], ['latencyNotes', [null, [], [''], [1]]], ['demo', [false, 1, 'true']],
    ['results.0.endpoint', ['', 'x'.repeat(65), null]], ['results.0.attempts', [-1, 101, 0.5, null]],
    ['results.0.successes', ['0', 101]], ['results.0.successRate', [-1, 101, null]], ['results.0.peerCount', [-1, 20]],
    ['results.0.status', ['ok', null, 0]], ['results.0.networkStatus', ['healthy', null]], ['results.0.lagStatus', ['unknown', null]],
    ['results.0.latencySampleCount', [-1, 101, '0', null]], ['results.0.latencyMs', [null, []]],
    ...['min', 'median', 'p95', 'max', 'stddev', 'p99'].map(k => [`results.0.latencyMs.${k}`, [-1, '0', false]]),
    ['results.0.errors', [null, [], { TIMEOUT: 0 }, { TIMEOUT: 1.5 }, { TIMEOUT: '1' }, { TIMEOUT: 101 }, { TYPO: 1 }]],
    ['results.1.warmup', [null, []]], ['results.1.warmup.attempts', [-1, 21]], ['results.1.warmup.successes', [21, null]],
    ['results.1.warmup.durationMs', [-1, 0.5]], ['results.1.warmup.errors', [{ RPC_ERROR: -1 }]],
    ['rounds', [null, {}, Array(101).fill(report.rounds[0])]], ['rounds.0.round', [0, 101]], ['rounds.0.startedMs', [-1, 0.5]],
    ['rounds.0.finishedMs', [null, '20']], ['results.1.observations', [null, {}, Array(101).fill(report.results[1].observations[0])]],
    ['results.1.observations.0.error', ['TYPO', 0, {}]], ['results.1.observations.0.round', [0, 101]],
    ['results.1.observations.0.startedMs', [-1, 0.5]], ['results.1.observations.0.finishedMs', ['20', null]],
    ['healthPolicy', [null, []]], ['healthPolicy.mode', ['default', null]], ['healthPolicy.maxFailures', [-1, 101, '0']],
    ['healthPolicy.passed', [0, 'false', null]], ['healthPolicy.violations', [null, {}]],
    ['healthPolicy.violations.0.endpointIndex', [0, 21, '1']], ['healthPolicy.violations.0.code', ['TYPO', null]],
    ['healthPolicy.violations.0.message', [null, 1, '']], ['healthPolicy.uncheckedLagEndpoints', [null, [0], [21], [1, 1], ['1']]],
    ['healthPolicy.notes', [null, [], [1]]],
  ];
  for (const [path, values] of mutations) for (const value of values) {
    assert.equal(validate(edit(report, path, value)), false, `accepted corruption at ${path}: ${JSON.stringify(value)}`);
  }
});

test('large quantities retain exact decimal strings and null, never JSON numbers or BigInt', () => {
  const report = fixture('strict-fail-v1');
  for (const path of ['results.0.chainId', 'results.0.latestBlock', 'results.0.lagBlocks', 'results.1.observations.0.block']) {
    for (const value of [null, '0', '9007199254740993', '18446744073709551617', '1' + '0'.repeat(100)]) valid(edit(report, path, value));
    for (const value of [0, 9007199254740992, 1n, '', '00', '-1', '+1', '1.0', '1e3', '0x10', '1\n', ' 1']) invalid(edit(report, path, value));
  }
});

test('inclusive structural bounds accept their exact edges', () => {
  const report = fixture('strict-fail-v1');
  for (const [path, values] of [
    ['settings.samples', [1, 100]], ['settings.timeoutMs', [1, 60000]], ['settings.concurrency', [1, 20]],
    ['settings.lagThreshold', [0, 9007199254740991]], ['settings.reference', [1, 20]],
    ['settings.warmup', [1, 20]], ['settings.intervalMs', [1, 60000]], ['pacingWaitMs', [0, 90]],
    ['results.0.attempts', [0, 100]], ['results.0.successes', [0, 100]], ['results.0.peerCount', [0, 19]],
    ['results.0.successRate', [0, 100]], ['results.0.latencySampleCount', [0, 100]],
    ['results.0.endpoint', ['x', '🛰'.repeat(64)]], ['results.0.latencyMs.p99', [null, 0, 0.01]],
    ['results.0.errors', [{}, { TIMEOUT: 1 }, { TIMEOUT: 100 }]], ['results.0.warmup.attempts', [0, 20]],
    ['healthPolicy.maxFailures', [0, 100]], ['healthPolicy.violations.0.endpointIndex', [1, 20]],
  ]) for (const value of values) valid(edit(report, path, value));
  invalid(JSON.parse(readFileSync(new URL('../examples/rpc-doctor.json', import.meta.url))));
});

test('additive fields are allowed at every extension object without bypassing known fields', () => {
  let report = fixture('strict-fail-v1');
  for (const path of ['', 'settings.', 'results.0.', 'results.0.latencyMs.', 'results.0.warmup.', 'rounds.0.', 'results.1.observations.0.', 'healthPolicy.', 'healthPolicy.violations.0.']) {
    report = edit(report, `${path}futureField`, { arbitrary: ['extension', 1, null] });
  }
  const before = structuredClone(report);
  valid(report);
  assert.deepEqual(report, before, 'validator must not strip, default, or coerce data');
  invalid(edit(report, 'results.0.status', 'invented'));
  invalid(edit(report, 'settings.samples', '2'));
});

test('structural validity deliberately does not prove cross-field arithmetic or safe text', () => {
  let report = fixture('strict-pass-v1');
  report.results[0].successes = 0; // inconsistent with successes/latency/status
  report.healthPolicy.passed = false; // no violations, still structurally a boolean
  report.settings.reference = 20; // within the hard bound, outside this result list
  report.results[0].endpoint = '<b>not trusted HTML</b>';
  report.rounds[0].finishedMs = 0; // chronology is a semantic check
  valid(report);
});

for (const [name, plans, flags, statuses, exitCode] of [
  ['healthy lone peer', [{}], [], ['healthy'], 0],
  ['mixed chains and partial errors', [{ blocks: [null, '0x20000000000001'] }, { chain: '0x2105' }], [], ['degraded', 'healthy'], 0],
  ['failed handshake and all failed samples', [{ chain: null }, { blocks: [null, null] }], [], ['unreachable', 'unreachable'], 1],
  ['expected network mismatch', [{ chain: '0x2' }], ['--expected-chain', '1'], ['mismatch'], 1],
  ['usable reference strict pass', [{}, {}], ['--reference', '1', '--expected-chain', '1', '--strict'], ['healthy', 'healthy'], 0],
  ['unavailable reference strict fail', [{ chain: null }, {}], ['--reference', '1', '--strict'], ['unreachable', 'degraded'], 1],
  ['different-chain reference', [{}, { chain: '0x2' }], ['--reference', '1'], ['healthy', 'degraded'], 0],
  ['warm-up errors strict fail', [{ blocks: [null, '0x1', '0x1'] }], ['--warmup', '1', '--strict'], ['degraded'], 1],
  ['zero pacing omitted', [{}], ['--interval', '0'], ['healthy'], 0],
  ['positive pacing field', [{}], ['--interval', '1'], ['healthy'], 0],
]) {
  test(`fresh serialized CLI report validates: ${name}`, async (t) => {
    let now = 0;
    const calls = plans.map(() => 0);
    t.mock.method(performance, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const index = Number(new URL(url).pathname.slice(1));
      const request = JSON.parse(options.body);
      now += 10; // controlled successful latency, longer than the 1ms pacing interval
      const plan = plans[index];
      const value = request.method === 'eth_chainId' ? ('chain' in plan ? plan.chain : '0x1')
        : (plan.blocks ?? ['0x20000000000001', '0x20000000000001'])[calls[index]++];
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        ...(value === null ? { error: { code: -32000, message: 'SYNTHETIC_SECRET' } } : { result: value }),
      }));
    });
    let out = ''; let err = '';
    const code = await main(['--json', '--samples', '2', ...flags],
      { RPC_DOCTOR_ENDPOINTS_JSON: JSON.stringify(plans.map((_, i) => `http://127.0.0.1/${i}?key=SYNTHETIC_SECRET`)) },
      { write: s => { out += s; } }, { write: s => { err += s; } });
    assert.equal(code, exitCode, err);
    assert.equal(err, '');
    assert.doesNotMatch(out, /SYNTHETIC_SECRET|127\.0\.0\.1/);
    const report = JSON.parse(out);
    valid(report);
    assert.deepEqual(report.results.map(r => r.status), statuses);
    assert.ok(Array.isArray(report.rounds));
    assert.ok(report.results.every(r => r.latencySampleCount === r.successes));
    if (flags.includes('--strict')) assert.equal(report.healthPolicy.passed, code === 0);
    if (name === 'zero pacing omitted') assert.equal(Object.hasOwn(report, 'pacingWaitMs'), false);
    if (name === 'positive pacing field') { assert.equal(report.settings.intervalMs, 1); assert.equal(report.pacingWaitMs, 0); }
  });
}

test('fresh benchmark serializes to valid JSON before validation', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const { id } = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x20000000000001' }));
  });
  const report = JSON.parse(JSON.stringify(await benchmark(['http://127.0.0.1'], { samples: 1 })));
  valid(report);
  assert.equal(report.results[0].chainId, '9007199254740993');
});

test('real loopback demo CLI produces valid complete reports for exit 0 and strict exit 1', () => {
  for (const flags of [[], ['--strict']]) {
    const result = spawnSync(process.execPath, ['bin/rpc-doctor.js', '--demo', '--json', '--samples', '2', '--warmup', '1', '--interval', '100', ...flags], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, flags.length ? 1 : 0, result.stderr);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    valid(report);
    assert.equal(report.demo, true);
    assert.equal(report.settings.intervalMs, 100);
    assert.equal(report.results[2].errors.RATE_LIMITED, 1);
    if (flags.length) assert.equal(report.healthPolicy.passed, false);
  }
});

test('development validator reports valid/invalid/unreadable input without leaking contents or paths', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rpc-doctor-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'SYNTHETIC_SECRET.json');
  for (const [data, expected] of [[JSON.stringify(fixture('failure-v1')), 0], ['{"SYNTHETIC_SECRET":1}', 1], ['SYNTHETIC_SECRET', 2]]) {
    await writeFile(path, data);
    const result = spawnSync(process.execPath, ['scripts/validate-report.js', path], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, expected, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_SECRET/);
  }
});

test('package manifest ships the schema and all examples, with only dev dependencies', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.ok(pkg.files.includes('schemas'));
  assert.ok(pkg.files.includes('examples'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies.ajv, '8.20.0');
});
