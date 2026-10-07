import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { main } from '../src/cli.js';
import { serve } from './helpers.js';

async function sandbox(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'rpc-doctor-output-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'SYNTHETIC_SECRET-report') };
}
async function run(args, env = {}) {
  let out = ''; let err = '';
  const code = await main(args, env, { write: s => { out += s; } }, { write: s => { err += s; } });
  return { code, out, err };
}
const urls = ['http://127.0.0.1/first?key=SYNTHETIC_SECRET', 'http://127.0.0.1/second?key=SYNTHETIC_SECRET'];

for (const format of [undefined, '--json', '--csv', '--markdown']) {
  for (const [scenario, flags, expectedCode] of [
    ['partial', [], 0], ['strict-fail', ['--strict'], 1],
    ['strict-pass', ['--strict', '--max-failures', '1'], 0], ['all-failed', [], 1],
  ]) {
    test(`${format ?? 'table'} file bytes and RPC trace match stdout for ${scenario}`, async t => {
      const { directory, path } = await sandbox(t);
      let now = 0; let calls = []; let blocks = {};
      const RealDate = Date;
      t.mock.method(globalThis, 'Date', class extends RealDate {
        constructor(...args) { super(...(args.length ? args : ['2026-10-07T00:00:00.000Z'])); }
      });
      t.mock.method(performance, 'now', () => now);
      t.mock.method(globalThis, 'fetch', async (url, options) => {
        const req = JSON.parse(options.body); calls.push({ url, ...req }); now += 10;
        const index = urls.indexOf(url); const call = blocks[index] ?? 0;
        if (req.method === 'eth_blockNumber') blocks[index] = call + 1;
        const failed = scenario === 'all-failed' || (index === 1 && req.method === 'eth_blockNumber' && call === 1);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id,
          ...(failed ? { error: { code: -32000, message: 'SYNTHETIC_SECRET' } }
            : { result: req.method === 'eth_chainId' ? '0x1' : '0x20000000000001' }),
        }));
      });
      const args = [...(format ? [format] : []), '--samples', '2', '--warmup', '1', '--concurrency', '1',
        '--label', 'Київ 🛰', '--label', 'Other | node', ...flags, ...urls];
      const baseline = await run(args); const baselineCalls = calls;
      now = 0; calls = []; blocks = {};
      const saved = await run([...args, '--output', path]);
      assert.equal(baseline.code, expectedCode, baseline.err);
      assert.deepEqual(saved, { code: expectedCode, out: '', err: '' });
      assert.deepEqual(calls, baselineCalls);
      assert.equal(calls.length, scenario === 'all-failed' ? 2 : 8);
      const bytes = await fs.readFile(path);
      assert.deepEqual(bytes, Buffer.from(baseline.out));
      assert.match(bytes.toString(), /Київ 🛰/); assert.doesNotMatch(bytes.toString(), /SYNTHETIC_SECRET|127\.0\.0\.1|"output"|"overwrite"/);
      if (format === '--csv') assert.ok(bytes.toString().endsWith('\r\n'));
      if (format === '--json') {
        const report = JSON.parse(bytes); assert.equal(report.schemaVersion, 1);
        assert.equal(report.healthPolicy?.passed, flags.includes('--strict') ? scenario === 'strict-pass' : undefined);
      }
      assert.deepEqual(await fs.readdir(directory), ['SYNTHETIC_SECRET-report']);
      if (process.platform !== 'win32') assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
    });
  }
}

test('file output keeps nonzero pacing outside successful RPC latency and unchanged request order', async t => {
  const { path } = await sandbox(t);
  let now = 0; let calls = []; let sequence = 0;
  const timers = new Map(); let pacingStarted;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = ++sequence; timers.set(id, { callback, due: now + delay });
    if (delay === 80) pacingStarted();
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const req = JSON.parse(options.body); calls.push({ url, ...req }); now += 10;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: '0x1' }));
  });
  const runs = [];
  for (const save of [false, true]) {
    now = 0; calls = [];
    const waiting = new Promise(resolve => { pacingStarted = resolve; });
    const running = run(['--json', '--samples', '2', '--warmup', '1', '--interval', '100', '--concurrency', '1', ...urls,
      ...(save ? ['--output', path] : [])]);
    await waiting;
    assert.equal(timers.size, 1);
    const [id, timer] = [...timers][0]; timers.delete(id); now = timer.due; timer.callback();
    const result = await running; assert.equal(result.code, 0, result.err);
    const report = JSON.parse(save ? await fs.readFile(path, 'utf8') : result.out);
    assert.equal(report.pacingWaitMs, 80); assert.equal(report.durationMs, 160);
    assert.deepEqual(report.results.map(r => r.latencyMs.median), [10, 10]);
    delete report.startedAt; delete report.generatedAt;
    runs.push({ report, calls });
  }
  assert.deepEqual(runs[0], runs[1]);
});

test('new option errors precede help/version, config/env reads and RPC without touching files', async t => {
  const { directory, path } = await sandbox(t);
  const env = Object.defineProperty({}, 'RPC_DOCTOR_ENDPOINTS_JSON', { get() { assert.fail('env read'); } });
  t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  const invalid = [
    ['--output'], ['--output='], ['--output', '  '], ['--output', '\0SYNTHETIC_SECRET'],
    ['--overwrite'], ['--output', path, '--output', path], ['--output', path, '--overwrite', '--overwrite'],
    ['--overwrite=true'], ['--overwrite=false'], ['--no-overwrite'], ['--no-output'],
    ['--json', '--csv', '--output', path], ['--markdown', '--json', '--output', path],
  ];
  for (const flags of invalid) {
    for (const extra of [[], ['--help'], ['--version']]) {
      const result = await run([...flags, ...extra], env);
      assert.equal(result.code, 2); assert.equal(result.out, '');
      assert.doesNotMatch(result.err, /SYNTHETIC_SECRET|\u0000|ENOENT|EACCES/);
    }
  }
  assert.deepEqual(await fs.readdir(directory), []);
});

test('valid help/version ignore paths and config/env/RPC and keep their stdout contract', async t => {
  const { directory, path } = await sandbox(t);
  await fs.writeFile(path, 'original');
  const env = Object.defineProperty({}, 'RPC_DOCTOR_ENDPOINTS_JSON', { get() { assert.fail('env read'); } });
  t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  for (const method of ['realpath', 'lstat', 'stat', 'access', 'open']) t.mock.method(fs, method, () => assert.fail('output FS access'));
  for (const flag of ['--help', '--version']) {
    const result = await run([flag, '--output', path, '--overwrite', '--config', '/SYNTHETIC_SECRET'], env);
    assert.equal(result.code, 0); assert.equal(result.err, '');
    if (flag === '--version') assert.equal(result.out, '0.1.0\n');
    else assert.match(result.out, /--output <file>/);
  }
  assert.equal(await fs.readFile(path, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(directory), ['SYNTHETIC_SECRET-report']);
});

test('predictable destination failures and config aliases stop before RPC and preserve input', async t => {
  const { directory, path } = await sandbox(t);
  let calls = 0; t.mock.method(globalThis, 'fetch', () => { calls++; assert.fail('RPC'); });
  await fs.writeFile(path, 'existing report');
  for (const [destination, flags] of [[path, []], [directory, ['--overwrite']], [join(directory, 'missing', 'report'), []]]) {
    const result = await run(['--output', destination, ...flags, ...urls]);
    assert.equal(result.code, 2); assert.equal(result.out, ''); assert.doesNotMatch(result.err, /SYNTHETIC_SECRET|ENOENT|EACCES/);
  }
  const config = join(directory, 'config.json');
  const source = JSON.stringify({ endpoints: [{ label: 'Primary', url: urls[0] }], samples: 1 });
  await fs.writeFile(config, source);
  const hardlink = join(directory, 'hardlink'); await fs.link(config, hardlink);
  const destinations = [config, relative(process.cwd(), config), hardlink];
  if (process.platform !== 'win32') {
    const link = join(directory, 'symlink'); await fs.symlink(config, link); destinations.push(link);
  }
  for (const destination of destinations) {
    const result = await run(['--output', destination, '--overwrite', '--config', config]);
    assert.equal(result.code, 2); assert.equal(result.out, ''); assert.doesNotMatch(result.err, /SYNTHETIC_SECRET/);
    assert.equal(await fs.readFile(config, 'utf8'), source);
  }
  assert.equal(calls, 0); assert.equal(await fs.readFile(path, 'utf8'), 'existing report');
  assert.ok(!(await fs.readdir(directory)).some(name => name.startsWith('.rpc-doctor-')));
});

test('fatal usage/config/benchmark failures cannot create or replace a report', async t => {
  const { directory, path } = await sandbox(t);
  const config = join(directory, 'config.json'); await fs.writeFile(config, '{"output":"SYNTHETIC_SECRET"}');
  t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  for (const existing of [false, true]) {
    if (existing) await fs.writeFile(path, 'original');
    for (const flags of [['--samples', '0', ...urls], ['--max-failures', '0', ...urls], [urls[0], urls[0]],
      ['--config', config, ...urls], ['--config', join(directory, 'absent'), ...urls], []]) {
      const result = await run(['--output', path, ...(existing ? ['--overwrite'] : []), ...flags]);
      assert.equal(result.code, 2); assert.equal(result.out, ''); assert.doesNotMatch(result.err, /SYNTHETIC_SECRET/);
      if (existing) assert.equal(await fs.readFile(path, 'utf8'), 'original');
      else await assert.rejects(fs.lstat(path), { code: 'ENOENT' });
    }
  }
  await fs.writeFile(config, '{"overwrite":true}');
  assert.equal((await run(['--output', path, '--overwrite', '--config', config, ...urls])).code, 2);
  t.mock.method(performance, 'now', () => { throw new Error('SYNTHETIC_SECRET'); });
  assert.deepEqual(await run(['--output', path, '--overwrite', ...urls]),
    { code: 2, out: '', err: 'RPC Doctor: Unable to complete the check.\n' });
  assert.equal(await fs.readFile(path, 'utf8'), 'original');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['SYNTHETIC_SECRET-report', 'config.json']);
});

test('late file failure overrides health exit with safe exit 2 and no success output', async t => {
  const { directory, path } = await sandbox(t); await fs.writeFile(path, 'original');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const { id } = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x1' }));
  });
  t.mock.method(fs, 'open', async () => { throw new Error('Use /SYNTHETIC_SECRET https://private.invalid EACCES'); });
  const result = await run(['--output', path, '--overwrite', '--strict', '--samples', '1', ...urls]);
  assert.deepEqual(result, { code: 2, out: '', err: 'RPC Doctor: Report file operation failed.\n' });
  assert.equal(await fs.readFile(path, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(directory), ['SYNTHETIC_SECRET-report']);
});

test('actual CLI saves all demo formats and full strict failure reports; overwrite is explicit', async t => {
  const { directory, path } = await sandbox(t);
  for (const format of [undefined, '--json', '--csv', '--markdown']) {
    const flags = ['bin/rpc-doctor.js', '--demo', '--samples', '3', '--strict', ...(format ? [format] : []), '--output', path];
    const first = spawnSync(process.execPath, flags, { encoding: 'utf8', timeout: 10000 });
    assert.equal(first.status, 1, first.stderr); assert.equal(first.stdout, ''); assert.equal(first.stderr, '');
    const before = await fs.readFile(path);
    assert.ok(before.length > 0);
    const refused = spawnSync(process.execPath, flags, { encoding: 'utf8', timeout: 10000 });
    assert.equal(refused.status, 2); assert.equal(refused.stdout, ''); assert.deepEqual(await fs.readFile(path), before);
    const replaced = spawnSync(process.execPath, [...flags, '--overwrite'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(replaced.status, 1, replaced.stderr); assert.equal(replaced.stdout, ''); assert.equal(replaced.stderr, '');
    const saved = await fs.readFile(path, 'utf8');
    if (format === '--json') assert.equal(JSON.parse(saved).healthPolicy.passed, false);
    else if (format === '--csv') assert.match(saved, /"false"/);
    else assert.match(saved, /FAIL/);
    await fs.unlink(path);
  }
  assert.deepEqual(await fs.readdir(directory), []);
});

test('file output preserves SIGINT 130 and an existing report during unfinished measurement', { timeout: 10000 }, async t => {
  const { directory, path } = await sandbox(t); await fs.writeFile(path, 'original');
  let started; const requested = new Promise(resolve => { started = resolve; });
  const server = await serve(() => started()); t.after(server.close);
  const child = spawn(process.execPath, ['bin/rpc-doctor.js', '--output', path, '--overwrite', server.url], { timeout: 10000 });
  t.after(() => child.kill()); let out = ''; child.stdout.on('data', chunk => { out += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal }));
  });
  await requested; child.kill('SIGINT');
  assert.deepEqual(await closed, { code: 130, signal: null }); assert.equal(out, '');
  assert.equal(await fs.readFile(path, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(directory), ['SYNTHETIC_SECRET-report']);
});
