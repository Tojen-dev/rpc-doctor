import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { main } from '../src/cli.js';
import { parseHealthPolicy } from '../src/health-policy.js';
import { serve } from './helpers.js';

const height = 9007199254741000n;
const block = (lag = 0n) => `0x${(height - lag).toString(16)}`;
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function run(args, env) {
  let out = '';
  let err = '';
  const code = await main(args, env, { write: (s) => { out += s; } }, { write: (s) => { err += s; } });
  return { code, out, err };
}

function fakeRpc(t, endpoints) {
  let now = 0;
  let calls = [];
  let indices = [];
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const index = Number(new URL(url).searchParams.get('endpoint'));
    const request = JSON.parse(options.body);
    calls.push({ endpoint: index, ...request });
    now += 10;
    const endpoint = endpoints[index];
    const value = request.method === 'eth_chainId' ? endpoint.chain ?? '0x1'
      : (endpoint.blocks ?? [block(), block()])[indices[index]++];
    if (value === 'http-error') return new Response('SYNTHETIC_SECRET', { status: 503 });
    const payload = value === null ? { error: { code: -32000, message: 'SYNTHETIC_SECRET' } } : { result: value };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...payload }));
  });
  return {
    env: { RPC_DOCTOR_ENDPOINTS_JSON: JSON.stringify(endpoints.map((_, i) => `http://127.0.0.1/SYNTHETIC_SECRET?endpoint=${i}&key=SYNTHETIC_SECRET`)) },
    reset() { now = 0; calls = []; indices = endpoints.map(() => 0); },
    get calls() { return structuredClone(calls); },
    get now() { return now; },
    advanceTo(time) { assert.ok(time >= now); now = time; },
  };
}

const normalized = ({ healthPolicy, startedAt, generatedAt, ...report }) => report;
for (const { name, endpoints, flags = [], statuses, codes = [], defaultCode = 0, allowedCode } of [
  { name: 'single endpoint has unchecked lag', endpoints: [{}], statuses: ['healthy'] },
  { name: 'healthy peers at zero lag', endpoints: [{}, {}], flags: ['--lag-threshold', '0'], statuses: ['healthy', 'healthy'] },
  { name: 'lag at inclusive boundary', endpoints: [{}, { blocks: [block(3n), block(3n)] }], statuses: ['healthy', 'healthy'] },
  { name: 'lag above boundary', endpoints: [{}, { blocks: [block(4n), block(4n)] }], statuses: ['healthy', 'degraded'], codes: ['LAG_EXCEEDED'] },
  { name: 'zero lag threshold exceeded', endpoints: [{}, { blocks: [block(1n), block(1n)] }], flags: ['--lag-threshold', '0'], statuses: ['healthy', 'degraded'], codes: ['LAG_EXCEEDED'] },
  { name: 'BigInt lag above maximum safe threshold', endpoints: [{}, { blocks: ['0x1', '0x1'] }], flags: ['--lag-threshold', '9007199254740991'], statuses: ['healthy', 'degraded'], codes: ['LAG_EXCEEDED'] },
  { name: 'partial failures at allowed count', endpoints: [{ blocks: [null, block()] }, {}], statuses: ['degraded', 'healthy'], codes: ['MEASURED_FAILURES'], allowedCode: 0 },
  { name: 'all samples fail even within allowance', endpoints: [{ blocks: [null, null] }], statuses: ['unreachable'], codes: ['NO_MEASURED_SUCCESS', 'MEASURED_FAILURES'], defaultCode: 1 },
  { name: 'mixed usable and unreachable', endpoints: [{}, { blocks: [null, null] }], statuses: ['healthy', 'unreachable'], codes: ['NO_MEASURED_SUCCESS', 'MEASURED_FAILURES'] },
  { name: 'handshake failure cannot be allowed', endpoints: [{}, { chain: 'http-error' }], statuses: ['healthy', 'unreachable'], codes: ['HANDSHAKE_FAILED'] },
  { name: 'invalid handshake', endpoints: [{ chain: '0x01' }], statuses: ['unreachable'], codes: ['HANDSHAKE_FAILED'], defaultCode: 1 },
  { name: 'mixed network mismatch', endpoints: [{}, { chain: '0x2' }], flags: ['--expected-chain', '1'], statuses: ['healthy', 'mismatch'], codes: ['NETWORK_MISMATCH'] },
  { name: 'all network mismatches', endpoints: [{ chain: '0x2' }], flags: ['--expected-chain', '1'], statuses: ['mismatch'], codes: ['NETWORK_MISMATCH'], defaultCode: 1 },
  { name: 'warm-up error despite perfect measurements', endpoints: [{ blocks: [null, block(), block()] }], flags: ['--warmup', '1'], statuses: ['degraded'], codes: ['WARMUP_FAILURES'] },
  { name: 'warm-up success cannot rescue failed measurements', endpoints: [{ blocks: [block(), null, null] }], flags: ['--warmup', '1'], statuses: ['unreachable'], codes: ['NO_MEASURED_SUCCESS', 'MEASURED_FAILURES'], defaultCode: 1 },
  { name: 'reference alone has unchecked lag', endpoints: [{}], flags: ['--reference', '1'], statuses: ['healthy'] },
  { name: 'reference itself and peer ahead', endpoints: [{ blocks: [block(1n), block(1n)] }, {}], flags: ['--reference', '1', '--lag-threshold', '0'], statuses: ['healthy', 'healthy'] },
  { name: 'partial reference keeps its failure and usable baseline', endpoints: [{ blocks: [null, block()] }, {}], flags: ['--reference', '1'], statuses: ['degraded', 'healthy'], codes: ['MEASURED_FAILURES'], allowedCode: 0 },
  { name: 'reference with no successful measurements', endpoints: [{ blocks: [null, null] }, {}], flags: ['--reference', '1'], statuses: ['unreachable', 'degraded'], codes: ['NO_MEASURED_SUCCESS', 'MEASURED_FAILURES', 'REFERENCE_UNAVAILABLE'] },
  { name: 'unavailable reference never falls back', endpoints: [{ chain: 'http-error' }, {}, {}], flags: ['--reference', '1'], statuses: ['unreachable', 'degraded', 'degraded'], codes: ['HANDSHAKE_FAILED', 'REFERENCE_UNAVAILABLE', 'REFERENCE_UNAVAILABLE'] },
  { name: 'mismatched reference never falls back', endpoints: [{ chain: '0x2' }, {}, {}], flags: ['--reference', '1', '--expected-chain', '1'], statuses: ['mismatch', 'degraded', 'degraded'], codes: ['NETWORK_MISMATCH', 'REFERENCE_MISMATCH', 'REFERENCE_MISMATCH'] },
  { name: 'reference on different chain', endpoints: [{}, { chain: '0x2' }], flags: ['--reference', '1'], statuses: ['healthy', 'degraded'], codes: ['REFERENCE_DIFFERENT_CHAIN'] },
  { name: 'separate lone chains have unchecked lag', endpoints: [{}, { chain: '0x2' }], statuses: ['healthy', 'healthy'] },
]) {
  test(`strict policy: ${name}`, async (t) => {
    const rpc = fakeRpc(t, endpoints);
    const args = ['--samples', '2', '--concurrency', '2', ...flags];
    rpc.reset();
    const baseline = await run([...args, '--json'], rpc.env);
    assert.equal(baseline.code, defaultCode, baseline.err);
    assert.equal(baseline.err, '');
    const baselineReport = JSON.parse(baseline.out);
    assert.equal(Object.hasOwn(baselineReport, 'healthPolicy'), false);
    assert.deepEqual(baselineReport.results.map(r => r.status), statuses);
    const baselineCalls = rpc.calls;
    for (const format of [['--json'], []]) {
      rpc.reset();
      const result = await run([...args, '--strict', ...format], rpc.env);
      assert.equal(result.code, codes.length ? 1 : 0, result.err);
      assert.equal(result.err, '');
      assert.deepEqual(rpc.calls, baselineCalls, 'policy must not change RPC count, order, or IDs');
      assert.doesNotMatch(result.out, /SYNTHETIC_SECRET|127\.0\.0\.1|https?:/);
      if (format.length) {
        const report = JSON.parse(result.out);
        assert.deepEqual(normalized(report), normalized(baselineReport), 'all measurements and statuses stay unchanged');
        assert.equal(report.schemaVersion, 1);
        assert.equal(report.healthPolicy.maxFailures, 0);
        assert.equal(report.healthPolicy.passed, codes.length === 0);
        assert.deepEqual(report.healthPolicy.violations.map(v => v.code), codes);
        assert.deepEqual(report.healthPolicy.uncheckedLagEndpoints,
          report.results.flatMap((r, i) => r.successes > 0 && r.lagBlocks === null ? [i + 1] : []));
        assert.match(report.healthPolicy.notes.join(' '), /does not establish freshness/);
      } else {
        for (let i = 0; i < endpoints.length; i++) assert.match(result.out, new RegExp(`^RPC ${i + 1}\\s`, 'm'));
        for (const row of baselineReport.results) {
          for (const [code, count] of Object.entries(row.errors)) assert.ok(result.out.includes(`${row.endpoint}: ${code} × ${count}`));
          for (const [code, count] of Object.entries(row.warmup?.errors ?? {})) assert.ok(result.out.includes(`${row.endpoint}: ${code} × ${count}`));
        }
        for (const code of codes) assert.ok(result.out.includes(code));
        assert.ok(result.out.includes(`Strict policy: ${codes.length ? 'FAIL' : 'PASS'}`));
        assert.match(result.out, /does not establish freshness/);
      }
    }
    rpc.reset();
    const allowed = await run([...args, '--strict', '--max-failures', '100', '--json'], rpc.env);
    assert.equal(allowed.code, allowedCode ?? (codes.length ? 1 : 0), allowed.err);
    assert.deepEqual(normalized(JSON.parse(allowed.out)), normalized(baselineReport));
    assert.deepEqual(rpc.calls, baselineCalls);
  });
}

test('measured failure allowance is inclusive and applies separately to each endpoint', async (t) => {
  const rpc = fakeRpc(t, [{ blocks: [null, null, block()] }, { blocks: [null, block(), block()] }]);
  for (const [limit, expectedCode, violations] of [['0', 1, [1, 2]], ['1', 1, [1]], ['2', 0, []], ['100', 0, []]]) {
    rpc.reset();
    const result = await run(['--strict', '--max-failures', limit, '--samples', '3', '--json'], rpc.env);
    const report = JSON.parse(result.out);
    assert.equal(result.code, expectedCode);
    assert.deepEqual(report.healthPolicy.violations.map(v => v.endpointIndex), violations);
    assert.deepEqual(report.results.map(r => r.status), ['degraded', 'degraded']);
  }
});

test('strict parsing rejects invalid types, values and conflicts before any requests', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', () => { requests++; assert.fail('unexpected RPC'); });
  for (const strict of [null, 0, 1, 'true', [], {}]) assert.throws(() => parseHealthPolicy({ strict }), /boolean/);
  for (const maxFailures of [null, false, 1, 1n, [], {}, '', '-0', '-1', '+1', '1.5', '1e1', '0x1', ' 1', '1\n', '101', 'Infinity', 'NaN', '9'.repeat(400), 'SYNTHETIC_SECRET']) {
    assert.throws(() => parseHealthPolicy({ strict: true, maxFailures }), /integer from 0 to 100/);
  }
  for (const flags of [
    ['--max-failures', '0'], ['--max-failures', '100'], ['--strict=false'], ['--strict=true'], ['--no-strict'],
    ['--strict', '--max-failures'], ...['', '-1', '+1', '1.5', '1e1', '0x1', ' 1', '1\n', '101', 'Infinity', 'NaN', '9'.repeat(400), 'SYNTHETIC_SECRET'].map(value => ['--strict', `--max-failures=${value}`]),
  ]) {
    const result = await run([...flags, 'http://127.0.0.1/SYNTHETIC_SECRET'], {});
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.match(result.err, /^RPC Doctor: (Use --max-failures only with --strict|Invalid arguments|Max failures must be)/);
    assert.doesNotMatch(result.err, /SYNTHETIC_SECRET|127\.0\.0\.1/);
  }
  assert.equal(requests, 0);
});

test('strict flags are CLI-only and cannot conceal invalid overridden config', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rpc-doctor-health-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'SYNTHETIC_SECRET.json');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; assert.fail('unexpected RPC'); });
  for (const config of [{ strict: true }, { strict: false }, { maxFailures: 0 }, { maxFailures: 'SYNTHETIC_SECRET' }, { lagThreshold: -1 }, { samples: 'SYNTHETIC_SECRET' }]) {
    await writeFile(path, JSON.stringify(config));
    const result = await run(['--config', path, '--strict', '--max-failures', '100', '--lag-threshold', '3', '--samples', '1', 'http://127.0.0.1/SYNTHETIC_SECRET'], {});
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.match(result.err, /^RPC Doctor: Config /);
    assert.doesNotMatch(result.err, /SYNTHETIC_SECRET|127\.0\.0\.1/);
  }
  assert.equal(calls, 0);
});

test('runtime failure stays exit 2 and does not leak raw exception text', async (t) => {
  t.mock.method(performance, 'now', () => { throw new Error('SYNTHETIC_SECRET http://127.0.0.1'); });
  const result = await run(['--strict', '--json', 'http://127.0.0.1'], {});
  assert.equal(result.code, 2);
  assert.equal(result.out, '');
  assert.equal(result.err, 'RPC Doctor: Unable to complete the check.\n');
});

test('strict evaluation uses the effective lag threshold with CLI over config over default', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rpc-doctor-health-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  const rpc = fakeRpc(t, [{}, { blocks: [block(4n), block(4n)] }]);
  for (const [config, flags, threshold, code] of [
    [{}, [], 3, 1], [{ lagThreshold: 4 }, [], 4, 0], [{ lagThreshold: 4 }, ['--lag-threshold', '3'], 3, 1],
  ]) {
    await writeFile(path, JSON.stringify(config));
    rpc.reset();
    const result = await run(['--config', path, '--samples', '2', '--strict', '--json', ...flags], rpc.env);
    const report = JSON.parse(result.out);
    assert.equal(result.code, code, result.err);
    assert.equal(report.settings.lagThreshold, threshold);
    assert.deepEqual(report.healthPolicy.violations.map(v => v.code), code ? ['LAG_EXCEEDED'] : []);
  }
});

test('strict mode leaves warm-up, concurrency, rounds, pacing and latency statistics unchanged', async (t) => {
  const rpc = fakeRpc(t, [{ blocks: [block(), null, block()] }, { blocks: [block(), block(1n), block(1n)] }]);
  const timers = new Map();
  let nextId = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, due: rpc.now + delay });
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const outputs = [];
  const requests = [];
  for (const flags of [[], ['--strict', '--max-failures', '1']]) {
    rpc.reset();
    const running = run(['--samples', '2', '--warmup', '1', '--concurrency', '1', '--interval', '100', '--json', ...flags], rpc.env);
    await settle();
    assert.equal(timers.size, 1, 'only pacing timer remains after first round');
    const [id, timer] = [...timers][0];
    timers.delete(id);
    rpc.advanceTo(timer.due);
    timer.callback();
    const result = await running;
    assert.equal(result.code, 0, result.err);
    assert.equal(timers.size, 0);
    const report = JSON.parse(result.out);
    assert.equal(report.pacingWaitMs, 80);
    assert.deepEqual(report.results.map(r => r.latencySampleCount), [1, 2]);
    outputs.push(normalized(report));
    requests.push(rpc.calls);
  }
  assert.deepEqual(outputs[0], outputs[1]);
  assert.deepEqual(requests[0], requests[1]);
});

test('strict mode keeps Ctrl+C exit 130', { timeout: 10000 }, async (t) => {
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const server = await serve(() => started());
  t.after(server.close);
  const child = spawn(process.execPath, ['bin/rpc-doctor.js', '--strict', '--json', server.url], { timeout: 10000 });
  t.after(() => child.kill());
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  await requestStarted;
  child.kill('SIGINT');
  assert.deepEqual(await closed, { code: 130, signal: null });
});
