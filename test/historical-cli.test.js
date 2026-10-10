import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { main } from '../src/cli.js';
import { formatTable } from '../src/format.js';
import { formatCsv } from '../src/csv.js';
import { formatMarkdown } from '../src/markdown.js';
import { parseCsv } from './csv-parser.js';
import { renderedReport } from './markdown-output.js';

const hash = `0x${'ab'.repeat(32)}`;
const fixture = name => JSON.parse(readFileSync(new URL(`../examples/reports/${name}.json`, import.meta.url)));
async function run(args, env = {}) {
  let out = ''; let err = '';
  const code = await main(args, env, { write: s => { out += s; } }, { write: s => { err += s; } });
  return { code, out, err };
}
async function sandbox(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'rpc-historical-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
const extraColumns = ['historical_requested_block', 'historical_status', 'historical_attempts', 'historical_number',
  'historical_hash', 'historical_error', 'historical_skip_reason', 'historical_started_ms', 'historical_finished_ms',
  'historical_duration_ms', 'historical_phase_started_ms', 'historical_phase_finished_ms', 'historical_phase_duration_ms'];

test('no-flag formats match pre-item-20 bytes for the fixed independent strict-pass fixture', () => {
  const report = fixture('strict-pass-v1');
  const outputs = [formatTable(report), JSON.stringify(report, null, 2), formatCsv(report), formatMarkdown(report)];
  // Recorded from parent 05ec6b9 before adding the optional probe.
  assert.deepEqual(outputs.map(out => createHash('sha256').update(out).digest('hex')), [
    '8929f415dd17477d50902899d6b1bfa4a13a2f5afc34acf79827795d4f5c731c',
    '7f02ad0e527fcedc76dcc6bd7a0736e7f32089c582c98c39a7513e09a46cd506',
    '18352e45d215e7be4277baf89f06e9a57300833be34b58e7077ce7698815f57c',
    '6efd44012db99f769455f4c21b7b275b42bc263360e3b8f31e186191399871ea',
  ]);
  assert.equal(parseCsv(outputs[2])[0].length, 42);
});

test('independent optional CSV and Markdown tables preserve exact numbers, nulls, zero and skipped reasons', () => {
  const report = fixture('historical-outcomes-v1');
  const csv = parseCsv(formatCsv(report));
  assert.equal(csv[0].length, 55); assert.deepEqual(csv[0].slice(42), extraColumns);
  assert.deepEqual(csv.slice(1).map(r => r.slice(42)), [
    ['9007199254740993', 'found', '1', '9007199254740993', hash, '', '', '2', '3', '1', '2', '1002', '1000'],
    ['9007199254740993', 'null', '1', '', '', '', '', '2', '3', '1', '2', '1002', '1000'],
    ['9007199254740993', 'unsupported', '1', '', '', 'RPC_ERROR', '', '2', '3', '1', '2', '1002', '1000'],
    ['9007199254740993', 'error', '1', '', '', 'TIMEOUT', '', '2', '1002', '1000', '2', '1002', '1000'],
  ]);
  const md = renderedReport(formatMarkdown(report));
  assert.deepEqual(md.tables.at(-2).slice(1), [
    ['Requested block (decimal)', '9007199254740993'], ['Phase start (ms from run start)', '2'],
    ['Phase finish (ms from run start)', '1002'], ['Phase elapsed (ms)', '1000'],
  ]);
  assert.deepEqual(md.tables.at(-1).slice(1), [
    ['1', 'found', '1', '9007199254740993', hash, '—', '—', '2', '3', '1'],
    ['2', 'null', '1', '—', '—', '—', '—', '2', '3', '1'],
    ['3', 'unsupported', '1', '—', '—', 'RPC_ERROR', '—', '2', '3', '1'],
    ['4', 'error', '1', '—', '—', 'TIMEOUT', '—', '2', '1002', '1000'],
  ]);
  assert.match(md.html, /does not prove historical state access/);
  const skipped = fixture('historical-skipped-v1');
  assert.deepEqual(parseCsv(formatCsv(skipped)).slice(1).map(r => r.slice(42)), [
    ['0', 'skipped', '0', '', '', '', 'handshake_failed', '', '', '', '1', '1', '0'],
    ['0', 'skipped', '0', '', '', '', 'network_mismatch', '', '', '', '1', '1', '0'],
  ]);
  const table = formatTable(skipped);
  assert.match(table, /Historical block: 0/); assert.match(table, /skipped; attempts 0; number —; hash —; error —; skip reason handshake_failed/);
  assert.match(table, /skip reason network_mismatch/);
  const before = structuredClone(report);
  formatTable(report); formatMarkdown(report); formatCsv(report);
  assert.deepEqual(report, before);
});

test('new report projection ignores arbitrary extras and keeps Markdown dynamic text inert', () => {
  const report = fixture('historical-outcomes-v1');
  report.historicalPhase.url = report.results[0].historicalBlock.raw = 'SYNTHETIC_SECRET';
  const attack = '<img src=x> [x](y) | `tick` https://example.invalid a@example.invalid';
  report.results[0].historicalBlock.hash = attack;
  const csv = parseCsv(formatCsv(report));
  assert.equal(csv[1][46], attack);
  const md = renderedReport(formatMarkdown(report));
  assert.equal(md.tables.at(-1)[1][4], attack);
  for (const out of [formatTable(report), formatCsv(report), formatMarkdown(report)]) assert.doesNotMatch(out, /SYNTHETIC_SECRET/);
});

test('invalid or repeated historical input precedes help/version, config/env/RPC and output filesystem actions', async t => {
  const dir = await sandbox(t); const path = join(dir, 'SYNTHETIC_SECRET'); await fs.writeFile(path, 'original');
  const env = Object.defineProperty({}, 'RPC_DOCTOR_ENDPOINTS_JSON', { get() { assert.fail('env read'); } });
  t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  for (const method of ['realpath', 'lstat', 'access', 'open']) t.mock.method(fs, method, () => assert.fail('output FS access'));
  for (const args of [['--historical-block'], ['--historical-block', '1', '--historical-block', '2'],
    ...['', '0\n', '0x01', '01', '-1', '+1', '1.5', 'latest', 'pending', 'safe', 'finalized', 'earliest', '1e3', 'SYNTHETIC_SECRET', '9'.repeat(79), (2n ** 256n).toString()].map(v => [`--historical-block=${v}`])]) {
    for (const extra of [[], ['--help'], ['--version']]) {
      const result = await run([...args, ...extra, '--config', '/missing/SYNTHETIC_SECRET', '--output', path, '--overwrite'], env);
      assert.equal(result.code, 2); assert.equal(result.out, ''); assert.doesNotMatch(result.err, /SYNTHETIC_SECRET|ENOENT|EACCES/);
    }
  }
  for (const extra of [['--help'], ['--version']]) {
    const result = await run(['--historical-block', '0xA', ...extra, '--config', '/missing/SYNTHETIC_SECRET', '--output', path], env);
    assert.equal(result.code, 0); assert.equal(result.err, '');
    assert.match(result.out, extra[0] === '--help' ? /--historical-block/ : /^0\.1\.0\n$/);
  }
  for (const flags of [['--json', '--csv'], ['--markdown', '--json'], ['--overwrite']]) {
    const result = await run(['--historical-block', '0', ...flags], env);
    assert.equal(result.code, 2); assert.equal(result.out, '');
  }
  assert.equal(await fs.readFile(path, 'utf8'), 'original'); assert.deepEqual(await fs.readdir(dir), ['SYNTHETIC_SECRET']);
});

test('historical option remains CLI-only even when CLI supplies a valid override', async t => {
  const dir = await sandbox(t); const config = join(dir, 'config.json');
  await fs.writeFile(config, '{"historicalBlock":"0"}');
  t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  const result = await run(['--historical-block', '1', '--config', config, '--output', join(dir, 'report'), 'http://127.0.0.1']);
  assert.equal(result.code, 2); assert.equal(result.out, ''); assert.match(result.err, /Config must be an object/);
  assert.deepEqual(await fs.readdir(dir), ['config.json']);
});

for (const format of [undefined, '--json', '--csv', '--markdown']) {
  test(`${format ?? 'table'} with historical probe preserves file bytes, health codes and complete RPC trace`, async t => {
    const dir = await sandbox(t); const path = join(dir, 'report');
    let now = 0; let calls = []; let failure = false;
    const RealDate = Date;
    t.mock.method(globalThis, 'Date', class extends RealDate {
      constructor(...args) { super(...(args.length ? args : ['2026-10-10T00:00:00.000Z'])); }
    });
    t.mock.method(performance, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const req = JSON.parse(options.body); calls.push(req); now += 10;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...(req.method === 'eth_getBlockByNumber'
        ? { error: { code: -32601, message: 'SYNTHETIC_SECRET' } }
        : failure && req.method === 'eth_blockNumber' ? { error: { code: -32000, message: 'SYNTHETIC_SECRET' } } : { result: '0x1' }) }));
    });
    for (const fail of [false, true]) {
      failure = fail; now = 0; calls = [];
      const args = ['--historical-block', '0xF', '--samples', '1', '--strict', ...(format ? [format] : []), 'http://127.0.0.1'];
      const result = await run(args); const expectedCalls = calls;
      assert.equal(result.code, fail ? 1 : 0); assert.equal(result.err, '');
      assert.equal(calls.length, 3); assert.deepEqual(calls[2].params, ['0xf', false]);
      now = 0; calls = [];
      const saved = await run([...args, '--output', path, ...(fail ? ['--overwrite'] : [])]);
      assert.deepEqual(saved, { code: fail ? 1 : 0, out: '', err: '' });
      assert.deepEqual(await fs.readFile(path), Buffer.from(result.out)); assert.deepEqual(calls, expectedCalls);
      assert.doesNotMatch(result.out, /SYNTHETIC_SECRET/);
      if (format === '--json') {
        const report = JSON.parse(result.out);
        assert.equal(report.results[0].historicalBlock.status, 'unsupported'); assert.equal(report.healthPolicy.passed, !fail);
      } else if (format === '--markdown') renderedReport(result.out);
      else if (format === '--csv') assert.equal(parseCsv(result.out)[0].length, 55);
    }
  });
}

test('real CLI historical demos cover found/null/unsupported, strict exits and mismatch skips', () => {
  for (const [flags, expectedCode] of [[[], 0], [['--strict'], 1], [['--strict', '--max-failures', '1', '--lag-threshold', '6'], 0], [['--expected-chain', '2'], 1]]) {
    const r = spawnSync(process.execPath, ['bin/rpc-doctor.js', '--demo', '--samples', '3', '--historical-block', '0', '--json', ...flags], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, expectedCode, r.stderr); assert.equal(r.stderr, '');
    const report = JSON.parse(r.stdout);
    assert.deepEqual(report.results.map(r => r.historicalBlock.status), flags.includes('--expected-chain') ? ['skipped', 'skipped', 'skipped'] : ['found', 'null', 'unsupported']);
    assert.equal(report.settings.historicalBlock, '0');
  }
});
