import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { main } from '../src/cli.js';
import { serve, reply } from './helpers.js';

async function run(args, env = {}) {
  let out = '';
  let err = '';
  const code = await main(args, env, { write: (s) => { out += s; } }, { write: (s) => { err += s; } });
  return { code, out, err };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rpc-doctor-config-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'SYNTHETIC_SECRET.json') };
}

test('config reports preserve named endpoint order, sanitize labels, and redact secrets in table/JSON', async (t) => {
  const { path } = await fixture(t);
  const failed = await serve((req, res) => res.writeHead(503).end('SYNTHETIC_SECRET'));
  t.after(failed.close);
  const healthy = await serve((req, res) => reply(res, req.method === 'eth_chainId' ? '0x1' : '0x10'));
  t.after(healthy.close);
  await writeFile(path, JSON.stringify({ endpoints: [
    { label: '  Private\n\x1b\u202e node ', urlEnv: 'SYNTHETIC_SECRET_ENV' },
    { label: 'Backup node', url: healthy.url },
  ], samples: 2, timeout: 1000 }));
  for (const format of [[], ['--json']]) {
    const result = await run(['--config', path, ...format], {
      SYNTHETIC_SECRET_ENV: `${failed.url}/SYNTHETIC_SECRET?key=SYNTHETIC_SECRET`,
      RPC_DOCTOR_ENDPOINTS_JSON: 'ignored invalid environment input',
    });
    assert.equal(result.code, 0, result.err);
    assert.equal(result.err, '');
    for (const secret of ['SYNTHETIC_SECRET', path, failed.url, healthy.url]) {
      assert.equal(result.out.includes(secret), false);
    }
    assert.doesNotMatch(result.out.replace(/\n/g, ''), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    if (format.length) {
      const report = JSON.parse(result.out);
      assert.deepEqual(report.results.map((r) => [r.endpoint, r.status]),
        [['Private node', 'unreachable'], ['Backup node', 'healthy']]);
      assert.equal(report.settings.samples, 2);
      assert.equal(report.settings.timeoutMs, 1000);
      assert.equal(report.results[1].attempts, 2);
    } else {
      assert.match(result.out, /^Private node\s+—\s+unreachable/m);
      assert.match(result.out, /^Backup node\s+1\s+healthy\s+2\/2/m);
      assert.match(result.out, /^  Private node: HTTP_ERROR × 1$/m);
      assert.ok(result.out.indexOf('Private node') < result.out.indexOf('Backup node'));
    }
  }
});

test('CLI replaces config endpoints and names together; settings override independently', async (t) => {
  const { path } = await fixture(t);
  let configRequests = 0;
  const configured = await serve((req, res) => { configRequests++; reply(res, '0x1'); });
  t.after(configured.close);
  const positional = await serve((req, res) => reply(res, '0x2'));
  t.after(positional.close);
  await writeFile(path, JSON.stringify({ endpoints: [
    { label: 'Config A', url: `${configured.url}/a` },
    { label: 'Config B', url: `${configured.url}/b` },
  ], samples: 2, timeout: 1200 }));
  const env = { RPC_DOCTOR_ENDPOINTS_JSON: 'ignored invalid environment input' };
  const cases = [
    { flags: [], samples: 2, timeoutMs: 1200, name: 'RPC 1' },
    { flags: ['--samples', '1'], samples: 1, timeoutMs: 1200, name: 'RPC 1' },
    { flags: ['--timeout', '1500'], samples: 2, timeoutMs: 1500, name: 'RPC 1' },
    { flags: ['--samples', '3', '--timeout', '1600', '--label', 'CLI node'],
      samples: 3, timeoutMs: 1600, name: 'CLI node' },
  ];
  for (const { flags, samples, timeoutMs, name } of cases) {
    const result = await run(['--config', path, '--json', positional.url, ...flags], env);
    assert.equal(result.code, 0, result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.settings.samples, samples);
    assert.equal(report.settings.timeoutMs, timeoutMs);
    assert.deepEqual(report.results.map((r) => [r.endpoint, r.chainId, r.attempts]), [[name, '2', samples]]);
    assert.equal(configRequests, 0);
  }
  const renamed = await run(['--config', path, '--json', '--label', 'New A', '--label', 'New B'], env);
  assert.equal(renamed.code, 0, renamed.err);
  assert.deepEqual(JSON.parse(renamed.out).results.map((r) => r.endpoint), ['New A', 'New B']);
  const before = configRequests;
  const badCount = await run(['--config', path, '--label', 'Only one'], env);
  assert.equal(badCount.code, 2);
  assert.equal(configRequests, before);
});

test('settings-only config uses environment endpoints, CLI labels, and missing-setting defaults', async (t) => {
  const { path } = await fixture(t);
  const server = await serve((req, res) => reply(res, '0x1'));
  t.after(server.close);
  const env = { RPC_DOCTOR_ENDPOINTS_JSON: JSON.stringify([server.url]) };
  for (const [config, samples, timeoutMs] of [[{}, 5, 5000], [{ samples: 1 }, 1, 5000], [{ timeout: 1000 }, 5, 1000]]) {
    await writeFile(path, JSON.stringify(config));
    const result = await run(['--config', path, '--json'], env);
    assert.equal(result.code, 0, result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.results[0].endpoint, 'RPC 1');
    assert.equal(report.settings.samples, samples);
    assert.equal(report.settings.timeoutMs, timeoutMs);
  }
  const labeled = await run(['--config', path, '--json', '--label', 'Environment node'], env);
  assert.equal(labeled.code, 0, labeled.err);
  assert.equal(JSON.parse(labeled.out).results[0].endpoint, 'Environment node');
  assert.equal((await run(['--config', path], {})).code, 2);
});

test('concurrency uses CLI over config over default, including settings-only config and environment URLs', async (t) => {
  const { path } = await fixture(t);
  let requests = 0;
  const server = await serve((req, res) => { requests++; reply(res, '0x1'); });
  t.after(server.close);
  const endpoints = Array.from({ length: 5 }, (_, index) => ({ label: `Node ${index}`, url: `${server.url}/${index}` }));
  const env = { RPC_DOCTOR_ENDPOINTS_JSON: JSON.stringify(endpoints.map((e) => e.url)) };
  for (const [config, flags, expected] of [
    [{ endpoints }, [], 4],
    [{ endpoints, concurrency: 2 }, [], 2],
    [{ endpoints, concurrency: 2 }, ['--concurrency', '1'], 1],
    [{ endpoints, concurrency: 1 }, ['--concurrency', '20'], 5],
    [{ concurrency: 3 }, [], 3],
  ]) {
    await writeFile(path, JSON.stringify(config));
    requests = 0;
    const result = await run(['--config', path, '--samples', '1', '--json', ...flags], env);
    assert.equal(result.code, 0, result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.settings.concurrency, expected);
    assert.equal(report.results.length, 5);
    assert.equal(requests, 10);
  }
});

test('CLI concurrency cannot hide invalid config concurrency and failures keep exit code 1', async (t) => {
  const { path } = await fixture(t);
  let requests = 0;
  const server = await serve((req, res) => { requests++; res.writeHead(503).end(); });
  t.after(server.close);
  for (const concurrency of [null, false, '2', 0, -1, 1.5, 21, 'SYNTHETIC_SECRET']) {
    await writeFile(path, JSON.stringify({ concurrency }));
    const result = await run(['--config', path, '--concurrency', '1', server.url]);
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.equal(result.err, 'RPC Doctor: Config concurrency must be an integer from 1 to 20.\n');
  }
  assert.equal(requests, 0);
  await writeFile(path, '{"concurrency":1}');
  const failed = await run(['--config', path, '--json', server.url]);
  assert.equal(failed.code, 1);
  const report = JSON.parse(failed.out);
  assert.equal(report.settings.concurrency, 1);
  assert.equal(report.results[0].status, 'unreachable');
  assert.deepEqual(report.results[0].errors, { HTTP_ERROR: 1 });
  assert.equal(requests, 1);
});

test('lag policy uses CLI over config over defaults with indices in the selected list', async (t) => {
  const { path } = await fixture(t);
  const first = await serve((req, res) => reply(res, req.method === 'eth_chainId' ? '0x1' : '0x10'));
  t.after(first.close);
  const second = await serve((req, res) => reply(res, req.method === 'eth_chainId' ? '0x1' : '0x13'));
  t.after(second.close);
  const env = { RPC_DOCTOR_ENDPOINTS_JSON: JSON.stringify([first.url, second.url]) };
  for (const [config, flags, threshold, reference, lags, statuses] of [
    [{}, [], 3, undefined, ['3', '0'], ['healthy', 'healthy']],
    [{ lagThreshold: 0 }, [], 0, undefined, ['3', '0'], ['degraded', 'healthy']],
    [{ lagThreshold: 0, reference: 2 }, [], 0, 2, ['3', null], ['degraded', 'healthy']],
    [{ lagThreshold: 0, reference: 2 }, ['--lag-threshold', '3'], 3, 2, ['3', null], ['healthy', 'healthy']],
    [{ lagThreshold: 3, reference: 2 }, ['--reference', '1', '--lag-threshold', '0'], 0, 1, [null, '0'], ['healthy', 'healthy']],
  ]) {
    await writeFile(path, JSON.stringify(config));
    const result = await run(['--config', path, '--samples', '1', '--json', ...flags], env);
    assert.equal(result.code, 0, result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.settings.lagThreshold, threshold);
    assert.equal(report.settings.reference, reference);
    assert.deepEqual(report.results.map((r) => r.lagBlocks), lags);
    assert.deepEqual(report.results.map((r) => r.status), statuses);
  }
  await writeFile(path, JSON.stringify({ endpoints: [{ label: 'Unused config name', url: second.url }], reference: 2 }));
  const positional = await run(['--config', path, '--samples', '1', '--json', first.url, second.url]);
  assert.equal(positional.code, 0, positional.err);
  const report = JSON.parse(positional.out);
  assert.equal(report.settings.reference, 2);
  assert.deepEqual(report.results.map((r) => [r.endpoint, r.lagBlocks]), [['RPC 1', '3'], ['RPC 2', null]]);
});

test('invalid config lag policy remains an error when overridden, before RPC', async (t) => {
  const { path } = await fixture(t);
  let requests = 0;
  const server = await serve((req, res) => { requests++; reply(res, '0x1'); });
  t.after(server.close);
  for (const config of [
    { lagThreshold: null }, { lagThreshold: 'SYNTHETIC_SECRET' }, { lagThreshold: -1 },
    { lagThreshold: Number.MAX_SAFE_INTEGER + 1 }, { reference: null }, { reference: 'SYNTHETIC_SECRET' },
    { reference: 0 }, { reference: 2 }, { reference: 21 },
  ]) {
    await writeFile(path, JSON.stringify(config));
    const result = await run(['--config', path, '--lag-threshold', '0', '--reference', '1', server.url]);
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.match(result.err, /^RPC Doctor: Config (lagThreshold |reference )/);
    for (const secret of [path, server.url, 'SYNTHETIC_SECRET']) assert.equal(result.err.includes(secret), false);
  }
  assert.equal(requests, 0);
});

test('expected chain uses CLI over config with exact large-ID normalization and an opt-in default', async (t) => {
  const { path } = await fixture(t);
  const observed = 9007199254740993n;
  let blockCalls = 0;
  const server = await serve((req, res) => {
    if (req.method === 'eth_chainId') reply(res, `0x${observed.toString(16)}`);
    else { blockCalls++; reply(res, '0x10'); }
  });
  t.after(server.close);
  for (const [config, flags, expected, code] of [
    [{}, [], undefined, 0],
    [{ expectedChain: '0x20000000000001' }, [], observed.toString(), 0],
    [{ expectedChain: '1' }, ['--expected-chain', observed.toString()], observed.toString(), 0],
    [{ expectedChain: observed.toString() }, ['--expected-chain', '0x1'], '1', 1],
  ]) {
    await writeFile(path, JSON.stringify(config));
    blockCalls = 0;
    const result = await run(['--config', path, '--samples', '1', '--json', ...flags], {
      RPC_DOCTOR_ENDPOINTS_JSON: JSON.stringify([server.url]),
    });
    assert.equal(result.code, code, result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.settings.expectedChain, expected);
    assert.equal(report.results[0].chainId, observed.toString());
    assert.equal(blockCalls, code === 0 ? 1 : 0);
    assert.equal(report.results[0].networkStatus, expected === undefined ? undefined : code === 0 ? 'match' : 'mismatch');
  }
});

test('invalid explicit config expectedChain cannot be hidden by CLI overrides', async (t) => {
  const { path } = await fixture(t);
  let requests = 0;
  const server = await serve((req, res) => { requests++; reply(res, '0x1'); });
  t.after(server.close);
  for (const expectedChain of [null, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, false,
    [], {}, '01', '0x01', '1\n', (1n << 256n).toString(), 'SYNTHETIC_SECRET']) {
    await writeFile(path, JSON.stringify({ expectedChain }));
    const result = await run(['--config', path, '--expected-chain', '1', server.url]);
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.match(result.err, /^RPC Doctor: Config expectedChain must be/);
    for (const secret of ['SYNTHETIC_SECRET', server.url, path]) assert.equal(result.err.includes(secret), false);
    assert.doesNotMatch(result.err.trimEnd(), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  }
  assert.equal(requests, 0);
});

test('warm-up uses CLI over config over zero, including an explicit zero override', async (t) => {
  const { path } = await fixture(t);
  let requests = 0;
  const server = await serve((req, res) => { requests++; reply(res, '0x1'); });
  t.after(server.close);
  for (const [config, flags, warmup] of [
    [{}, [], 0], [{ warmup: 0 }, [], 0], [{ warmup: 20 }, [], 20],
    [{ warmup: 3 }, ['--warmup', '1'], 1], [{ warmup: 3 }, ['--warmup', '0'], 0],
  ]) {
    requests = 0;
    await writeFile(path, JSON.stringify({ endpoints: [{ label: 'Configured node', url: server.url }], ...config }));
    const result = await run(['--config', path, '--samples', '1', '--json', ...flags]);
    assert.equal(result.code, 0, result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.results[0].endpoint, 'Configured node');
    assert.equal(report.settings.warmup, warmup || undefined);
    assert.equal(report.results[0].warmup?.attempts, warmup || undefined);
    assert.equal(requests, 2 + warmup);
  }
});

test('invalid explicit config warm-up cannot be hidden by CLI overrides', async (t) => {
  const { path } = await fixture(t);
  let requests = 0;
  const server = await serve((req, res) => { requests++; reply(res, '0x1'); });
  t.after(server.close);
  for (const warmup of [null, '1', false, -1, 1.5, 21, [], {}, 'SYNTHETIC_SECRET\x1b']) {
    await writeFile(path, JSON.stringify({ warmup }));
    const result = await run(['--config', path, '--warmup', '0', server.url]);
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.equal(result.err, 'RPC Doctor: Config warmup must be an integer from 0 to 20.\n');
  }
  assert.equal(requests, 0);
});

test('explicit config is fully validated even when overridden, before any request, without leaking input', async (t) => {
  const { directory, path } = await fixture(t);
  let requests = 0;
  const server = await serve((req, res) => { requests++; reply(res, '0x1'); });
  t.after(server.close);
  const configs = [
    '{"SYNTHETIC_SECRET\u001b":',
    JSON.stringify({ samples: 0 }), JSON.stringify({ timeout: 'SYNTHETIC_SECRET' }),
    JSON.stringify({ SYNTHETIC_SECRET: server.url }),
    JSON.stringify({ endpoints: [{ label: 'Unused', urlEnv: 'SYNTHETIC_SECRET_ENV' }] }),
    JSON.stringify({ endpoints: [{ label: 'Unused', url: server.url, SYNTHETIC_SECRET: true }] }),
    JSON.stringify({ endpoints: [{ label: server.url, url: server.url }] }),
  ];
  for (const contents of configs) {
    await writeFile(path, contents);
    const result = await run(['--config', path, server.url, '--samples', '1', '--timeout', '1000', '--label', 'CLI node']);
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.match(result.err, /^RPC Doctor: Config /);
    for (const secret of ['SYNTHETIC_SECRET', directory, server.url]) assert.equal(result.err.includes(secret), false);
    assert.doesNotMatch(result.err.trimEnd(), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  }
  const missing = await run(['--config', join(directory, 'MISSING_SYNTHETIC_SECRET'), server.url]);
  assert.equal(missing.code, 2);
  assert.equal(missing.err, 'RPC Doctor: Config could not be read as UTF-8 JSON.\n');
  assert.equal(requests, 0);
});

test('help/version skip config reads and references; demo rejects config before reading it', async (t) => {
  const { directory, path } = await fixture(t);
  await writeFile(path, '{"endpoints":[{"label":"Node","urlEnv":"MISSING_SECRET"}]}');
  for (const file of [path, join(directory, 'missing.json')]) {
    const help = await run(['--config', file, '--warmup', 'invalid', '--demo', '--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /--config <file>/);
    assert.match(help.out, /--warmup <n>/);
    assert.equal(help.err, '');
    const version = await run(['--config', file, '--warmup', 'invalid', '--version']);
    assert.equal(version.code, 0);
    assert.equal(version.out, '0.1.0\n');
    assert.equal(version.err, '');
    const demo = await run(['--demo', '--config', file]);
    assert.equal(demo.code, 2);
    assert.equal(demo.err, 'RPC Doctor: Use --demo without --config.\n');
  }
  const demo = await run(['--demo', '--json', '--samples', '1'], { RPC_DOCTOR_ENDPOINTS_JSON: 'invalid ignored input' });
  assert.equal(demo.code, 0, demo.err);
  assert.equal(JSON.parse(demo.out).demo, true);
  assert.equal((await run(['--config'])).code, 2);
});

test('CLI does not auto-load files or execute config content, and explicit paths are relative to cwd', async (t) => {
  const { directory } = await fixture(t);
  const server = await serve((req, res) => reply(res, '0x1'));
  t.after(server.close);
  for (const filename of ['rpc-doctor.local.json', 'rpc-doctor.json']) {
    await writeFile(join(directory, filename), 'process.stdout.write("SYNTHETIC_SECRET")');
  }
  const bin = fileURLToPath(new URL('../bin/rpc-doctor.js', import.meta.url));
  async function childRun(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, ...args], {
        cwd: directory, timeout: 10000, env: { ...process.env, RPC_DOCTOR_ENDPOINTS_JSON: '' },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (data) => { out += data; });
      child.stderr.on('data', (data) => { err += data; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out, err }));
    });
  }
  const legacy = await childRun(['--json', server.url]);
  assert.equal(legacy.code, 0, legacy.err);
  assert.equal(JSON.parse(legacy.out).settings.samples, 5);
  assert.equal(JSON.parse(legacy.out).results[0].endpoint, 'RPC 1');
  const invalid = await childRun(['--config', 'rpc-doctor.json', server.url]);
  assert.equal(invalid.code, 2);
  assert.equal(invalid.out, '');
  assert.equal(invalid.err, 'RPC Doctor: Config could not be read as UTF-8 JSON.\n');
  await writeFile(join(directory, 'relative.json'), JSON.stringify({
    endpoints: [{ label: 'Relative config', url: server.url }], samples: 1,
  }));
  const explicit = await childRun(['--config', 'relative.json', '--json']);
  assert.equal(explicit.code, 0, explicit.err);
  assert.equal(JSON.parse(explicit.out).results[0].endpoint, 'Relative config');
});
