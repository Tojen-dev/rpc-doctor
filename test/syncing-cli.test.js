import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { main } from '../src/cli.js';
import { formatTable } from '../src/format.js';
import { formatCsv } from '../src/csv.js';
import { formatMarkdown } from '../src/markdown.js';
import { parseCsv } from './csv-parser.js';
import { renderedReport } from './markdown-output.js';

const fixture = name => JSON.parse(readFileSync(new URL(`../examples/reports/${name}.json`, import.meta.url)));
const run = async (args, env = {}) => { let out = ''; let err = ''; const code = await main(args, env, { write: s => { out += s; } }, { write: s => { err += s; } }); return { code, out, err }; };
const sandbox = async t => { const dir = await fs.mkdtemp(join(tmpdir(), 'rpc-syncing-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; };
const address = `0x${'ab'.repeat(20)}`;
const extraColumns = ['status', 'attempts', 'is_syncing', 'starting_block', 'current_block', 'highest_block', 'height_order', 'error', 'skip_reason', 'started_ms', 'finished_ms', 'duration_ms', 'phase_started_ms', 'phase_finished_ms', 'phase_duration_ms'].map(k => `syncing_${k}`);

test('old finality-only and all-probe fixture bytes remain identical in all formats', () => {
  const hashes = {
    'finality-outcomes-v1': ['f8223817e0e1f57d152ddbcaa192ed2de552575d1e87603fa1aba7a3e93643aa', '70540fa371f39194053da15ba452adeb57c2a2c4bfc6cfdec2b481a00f83754a', '749e3768b62dda5fe0e47e4af2eda4067fcece74303daf4be0d6b465a9867831', '5bb55c5a5d3a102bccfd41faf9cfe763dc0e37b0097cafa159cbe89a9fdde9b5'],
    'finality-skipped-v1': ['4563ad5545b2f73bacf1f7481c3de4dd797148cae6e4687304448e2f86e23032', '64c7523a413dc1ff24b5b9305729302c6d626f135e8597746265a5443be346be', '1f92889ed59692575e7bc48d943bcf62d70fd78a5c5b4406cbe2379340a5943d', '77d7290529536bf8cddec2f26ec5812c467a7990f51638da612f9bc770975e3e'],
  };
  for (const [name, expected] of Object.entries(hashes)) assert.deepEqual([formatTable, r => JSON.stringify(r, null, 2), formatCsv, formatMarkdown].map(f => createHash('sha256').update(f(fixture(name))).digest('hex')), expected);
});

test('all 32 combinations append syncing last, preserve earlier CSV columns and do not mutate reports', () => {
  for (let mask = 0; mask < 32; mask++) {
    const report = fixture('syncing-skipped-v1');
    for (const [bit, name, phase] of [[1, 'historicalBlock', 'historicalPhase'], [2, 'call', 'callPhase'], [4, 'logs', 'logsPhase'], [8, 'finality', 'finalityPhase'], [16, 'syncing', 'syncingPhase']]) {
      if (!(mask & bit)) { delete report.settings[name]; delete report[phase]; report.results.forEach(r => delete r[name]); }
    }
    const before = structuredClone(report); const text = formatCsv(report); const csv = parseCsv(text);
    assert.ok(csv.every(row => row.length === 42 + (mask & 1 ? 13 : 0) + (mask & 2 ? 16 : 0) + (mask & 4 ? 16 : 0) + (mask & 8 ? 23 : 0) + (mask & 16 ? 15 : 0)));
    assert.ok(text.endsWith('\r\n')); assert.doesNotMatch(text, /(?<!\r)\n/);
    if (mask & 16) {
      assert.deepEqual(csv[0].slice(-15), extraColumns);
      const off = structuredClone(report); delete off.settings.syncing; delete off.syncingPhase; off.results.forEach(r => delete r.syncing);
      assert.deepEqual(csv.map(row => row.slice(0, -15)), parseCsv(formatCsv(off)));
    }
    formatTable(report); renderedReport(formatMarkdown(report)); assert.deepEqual(report, before);
  }
});

test('independent sync fixture formats distinguish false, true, zero, large counters, unusual order and unknowns', () => {
  const report = fixture('syncing-outcomes-v1'); const csv = parseCsv(formatCsv(report));
  assert.deepEqual(csv.slice(1).map(r => r.slice(-15)), [
    ['not_syncing', 'false', '', '', '', '', ''], ['syncing', 'true', '0', '0', '0', 'nondecreasing', ''],
    ['syncing', 'true', '0', '9007199254740993', (2n ** 256n - 1n).toString(), 'nondecreasing', ''],
    ['syncing', 'true', '5', '3', '2', 'out_of_order', ''], ['unsupported', '', '', '', '', '', 'RPC_ERROR'], ['error', '', '', '', '', '', 'INVALID_RESULT'],
  ].map(([status, syncing, start, current, highest, order, error]) => [status, '1', syncing, start, current, highest, order, error, '', '2', '3', '1', '2', '3', '1']));
  const rows = renderedReport(formatMarkdown(report)).tables.at(-1);
  assert.deepEqual(rows[1], ['1', 'not_syncing', '1', 'false', '—', '—', '—', '—', '—', '—', '2', '3', '1']);
  assert.deepEqual(rows[2].slice(3, 8), ['true', '0', '0', '0', 'nondecreasing']); assert.equal(rows[3][5], '9007199254740993'); assert.equal(rows[4][7], 'out_of_order'); assert.equal(rows[5][3], '—');
  assert.match(formatTable(report), /not_syncing; attempts 1; is syncing false; starting —/);
  const skipped = fixture('syncing-skipped-v1');
  assert.deepEqual(parseCsv(formatCsv(skipped)).slice(1).map(r => r.slice(-15)), ['handshake_failed', 'network_mismatch'].map(reason => ['skipped', '0', '', '', '', '', '', '', reason, '', '', '', '1', '1', '0']));
  assert.match(formatTable(skipped), /skipped; attempts 0; is syncing —/);
});

test('sync format projections omit extras and keep dynamic Markdown/CSV text inert', () => {
  const report = fixture('syncing-outcomes-v1'); report.syncingPhase.raw = report.results[0].syncing.raw = 'SYNTHETIC_SECRET';
  const attack = '= <img src=x> [x](y) | `tick` https://example.invalid a@example.invalid';
  report.results[0].syncing.heightOrder = attack; report.results[0].syncing.error = attack;
  const csv = parseCsv(formatCsv(report)); assert.equal(csv[1][48], "'" + attack); assert.equal(csv[1][49], "'" + attack);
  const md = renderedReport(formatMarkdown(report)); assert.equal(md.tables.at(-1)[1][7], attack); assert.equal(md.tables.at(-1)[1][8], attack);
  for (const output of [formatTable(report), formatCsv(report), formatMarkdown(report)]) assert.doesNotMatch(output, /SYNTHETIC_SECRET/);
});

test('bad/repeated syncing flags precede config/env/output/RPC even with help/version', async t => {
  const dir = await sandbox(t); const path = join(dir, 'SYNTHETIC_SECRET'); await fs.writeFile(path, 'original');
  const env = Object.defineProperty({}, 'RPC_DOCTOR_ENDPOINTS_JSON', { get() { assert.fail('env read'); } });
  t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  for (const method of ['realpath', 'lstat', 'access', 'open']) t.mock.method(fs, method, () => assert.fail('filesystem access'));
  for (const args of [['--syncing', '--syncing'], ['--no-syncing'], ...['', 'true', 'false', '0', '1', 'SYNTHETIC_SECRET'].map(v => [`--syncing=${v}`])]) {
    for (const extra of [[], ['--help'], ['--version']]) {
      const r = await run([...args, ...extra, '--config', '/missing/SYNTHETIC_SECRET', '--output', path, '--overwrite'], env);
      assert.equal(r.code, 2); assert.equal(r.out, ''); assert.match(r.err, /Use --syncing|Invalid arguments/); assert.doesNotMatch(r.err, /SYNTHETIC_SECRET|ENOENT|EACCES/);
    }
  }
  for (const extra of [['--help'], ['--version']]) {
    const r = await run(['--syncing', ...extra, '--config', '/missing/SYNTHETIC_SECRET', '--output', path], env);
    assert.equal(r.code, 0); assert.equal(r.err, ''); assert.match(r.out, extra[0] === '--help' ? /--syncing/ : /^0\.1\.0\n$/);
  }
  assert.equal(await fs.readFile(path, 'utf8'), 'original'); assert.deepEqual(await fs.readdir(dir), ['SYNTHETIC_SECRET']);
});

test('sync configuration equivalents remain unknown fields despite a CLI override', async t => {
  const dir = await sandbox(t); const config = join(dir, 'config.json'); t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  for (const key of ['syncing', 'syncState', 'sync-state', 'isSyncing', 'eth_syncing']) {
    await fs.writeFile(config, JSON.stringify({ [key]: 'SYNTHETIC_SECRET' }));
    const r = await run(['--syncing', '--config', config, '--output', join(dir, 'report'), 'http://127.0.0.1']);
    assert.equal(r.code, 2); assert.equal(r.out, ''); assert.match(r.err, /Config must be an object/); assert.doesNotMatch(r.err, /SYNTHETIC_SECRET/); assert.deepEqual(await fs.readdir(dir), ['config.json']);
  }
});

for (const format of [undefined, '--json', '--csv', '--markdown']) test(`${format ?? 'table'} atomic syncing output keeps health 0/1 reports and preserves old files on error 2`, async t => {
  const dir = await sandbox(t); const path = join(dir, 'report'); let now = 0; let trace = []; let failure = false; let outcome;
  const RealDate = Date;
  t.mock.method(globalThis, 'Date', class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-10-13T00:00:00.000Z'])); } });
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const req = JSON.parse(init.body); trace.push(req); now += 10;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id,
      ...(req.method === 'eth_syncing' ? outcome : failure && req.method === 'eth_blockNumber' ? { error: { code: -32602, message: 'SYNTHETIC_SECRET' } }
        : { result: req.method === 'eth_getBlockByNumber' ? null : req.method === 'eth_call' ? '0x' : req.method === 'eth_getLogs' ? [] : '0x1' }) }));
  });
  const args = ['--syncing', '--finality', '--logs-from', '0', '--logs-to', '0', '--historical-block', '0', '--call-to', address, '--call-data', '0x', '--call-block', '0', '--samples', '1', ...(format ? [format] : []), 'http://127.0.0.1'];
  let exists = false;
  for (const value of [{ result: false }, { result: { startingBlock: '0x0', currentBlock: '0x0', highestBlock: '0x0' } }, { error: { code: -32601, message: 'SYNTHETIC_SECRET' } }, { result: true }]) {
    outcome = value;
    for (const strict of [false, true]) for (const fail of [false, true]) {
      failure = fail; now = 0; trace = []; const input = [...args, ...(strict ? ['--strict'] : [])]; const r = await run(input); const expectedTrace = trace;
      assert.equal(r.code, fail ? 1 : 0); assert.equal(r.err, ''); assert.equal(trace.length, 8); assert.equal(trace.at(-1).method, 'eth_syncing'); assert.deepEqual(trace.at(-1).params, []);
      now = 0; trace = [];
      assert.deepEqual(await run([...input, '--output', path, ...(exists ? ['--overwrite'] : [])]), { code: fail ? 1 : 0, out: '', err: '' }); exists = true;
      assert.deepEqual(await fs.readFile(path), Buffer.from(r.out)); assert.deepEqual(trace, expectedTrace); assert.doesNotMatch(r.out, /SYNTHETIC_SECRET/);
      if (format === '--json') { const p = JSON.parse(r.out); assert.equal(p.results[0].syncing.attempts, 1); if (strict) assert.equal(p.healthPolicy.passed, !fail); }
      if (format === '--csv') assert.equal(parseCsv(r.out)[0].length, 125);
      if (format === '--markdown') renderedReport(r.out);
    }
  }
  const old = await fs.readFile(path); trace = [];
  const refused = await run([...args, '--output', path]); assert.equal(refused.code, 2); assert.equal(trace.length, 0);
  t.mock.method(fs, 'rename', () => { throw new Error('SYNTHETIC_SECRET'); });
  const r = await run([...args, '--output', path, '--overwrite']);
  assert.equal(r.code, 2); assert.equal(r.out, ''); assert.equal(trace.length, 8); assert.match(r.err, /Report file operation failed/); assert.doesNotMatch(r.err, /SYNTHETIC_SECRET/);
  assert.deepEqual(await fs.readFile(path), old); assert.deepEqual(await fs.readdir(dir), ['report']);
});
