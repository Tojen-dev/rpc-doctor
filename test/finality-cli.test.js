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
const sandbox = async t => { const dir = await fs.mkdtemp(join(tmpdir(), 'rpc-finality-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; };
const address = `0x${'ab'.repeat(20)}`;
const extraColumns = ['safe', 'finalized'].flatMap(tag => ['status', 'attempts', 'number', 'hash', 'error', 'rpc_error_kind', 'skip_reason', 'started_ms', 'finished_ms', 'duration_ms'].map(k => `finality_${tag}_${k}`)).concat(['finality_phase_started_ms', 'finality_phase_finished_ms', 'finality_phase_duration_ms']);

test('pre-finality log-only and all-probe report bytes remain identical in every format', () => {
  const hashes = {
    'logs-outcomes-v1': ['8c0dd3e37207d8d101ff1c10543972565a689ec35baf854ba96783976e787497', '9b84e9e23fdbe99e374bd40c33bf40f1c4f8991d27f641ad74129c7889467640', '3c71d7d20ae108010a3f658afe4f0755dfc8a0e346e4c1df215c8dcd6f6d2d47', '4aae7fe634bfa5d5582f2867da21beffed8c23f83aac9f86e2203fe8f3636416'],
    'logs-skipped-v1': ['ab9857cfe4a047a7cdd7384bc459f214dfd9705070c70fdebed02cc0e1d04061', '955f123bc3672abf1c0d91e244bacc37e8e65e75381378c7942b0797b3f1c995', '1cce572f05be09067a7fcb6a206e100ba9879b1051de674003dd203bfe8555e2', '587a7eb596a2973df79063cf19deca356962e2510e9603301e6573640a056aa1'],
  };
  for (const [name, expected] of Object.entries(hashes)) assert.deepEqual([formatTable, r => JSON.stringify(r, null, 2), formatCsv, formatMarkdown].map(f => createHash('sha256').update(f(fixture(name))).digest('hex')), expected);
});

test('all sixteen optional combinations append finality last, retain previous CSV bytes, and do not mutate reports', () => {
  for (let mask = 0; mask < 16; mask++) {
    const report = fixture('finality-skipped-v1');
    for (const [bit, setting, phase, result] of [[1, 'historicalBlock', 'historicalPhase', 'historicalBlock'], [2, 'call', 'callPhase', 'call'], [4, 'logs', 'logsPhase', 'logs'], [8, 'finality', 'finalityPhase', 'finality']]) {
      if (!(mask & bit)) { delete report.settings[setting]; delete report[phase]; report.results.forEach(r => delete r[result]); }
    }
    const before = structuredClone(report); const text = formatCsv(report); const csv = parseCsv(text);
    assert.ok(csv.every(row => row.length === 42 + (mask & 1 ? 13 : 0) + (mask & 2 ? 16 : 0) + (mask & 4 ? 16 : 0) + (mask & 8 ? 23 : 0)));
    assert.ok(text.endsWith('\r\n')); assert.doesNotMatch(text, /(?<!\r)\n/);
    if (mask & 8) {
      assert.deepEqual(csv[0].slice(-23), extraColumns);
      const without = structuredClone(report); delete without.settings.finality; delete without.finalityPhase; without.results.forEach(r => delete r.finality);
      assert.deepEqual(csv.map(row => row.slice(0, -23)), parseCsv(formatCsv(without)));
    }
    formatTable(report); renderedReport(formatMarkdown(report)); assert.deepEqual(report, before);
  }
});

test('independent fixtures retain exact numbers, distinct null/error kinds, zeros and skipped timings in formats', () => {
  const report = fixture('finality-outcomes-v1'); const csv = parseCsv(formatCsv(report));
  assert.deepEqual(csv[1].slice(-23), ['found', '1', '0', `0x${'ab'.repeat(32)}`, '', '', '', '2', '3', '1', 'found', '1', '9007199254740993', `0x${'ab'.repeat(32)}`, '', '', '', '3', '4', '1', '2', '4', '2']);
  assert.deepEqual(csv[2].slice(-23), ['null', '1', '', '', '', '', '', '2', '3', '1', 'error', '1', '', '', 'RPC_ERROR', 'invalid_params', '', '3', '4', '1', '2', '4', '2']);
  const rows = renderedReport(formatMarkdown(report)).tables.at(-1);
  assert.deepEqual(rows[1], ['1', 'safe', 'found', '1', '0', `0x${'ab'.repeat(32)}`, '—', '—', '—', '2', '3', '1']);
  assert.equal(rows[2][4], '9007199254740993'); assert.equal(rows[4][7], 'invalid_params'); assert.equal(rows[5][7], 'method_unavailable'); assert.equal(rows[6][7], 'other');
  assert.match(formatTable(report), /safe: found; attempts 1; number 0/);
  const skipped = fixture('finality-skipped-v1');
  assert.deepEqual(parseCsv(formatCsv(skipped)).slice(1).map(r => r.slice(-23)), ['handshake_failed', 'network_mismatch'].map(reason => [
    'skipped', '0', '', '', '', '', reason, '', '', '', 'skipped', '0', '', '', '', '', reason, '', '', '', '1', '1', '0',
  ]));
  assert.match(formatTable(skipped), /safe: skipped; attempts 0; number —/);
});

test('finality formatters project known fields and escape all dynamic Markdown/CSV text', () => {
  const report = fixture('finality-outcomes-v1');
  report.finalityPhase.raw = report.results[0].finality.raw = report.results[0].finality.safe.raw = 'SYNTHETIC_SECRET';
  const attack = '= <img src=x> [x](y) | `tick` https://example.invalid a@example.invalid';
  report.results[0].finality.safe.rpcErrorKind = attack; report.results[0].finality.finalized.hash = attack;
  const csv = parseCsv(formatCsv(report)); assert.equal(csv[1][47], "'" + attack); assert.equal(csv[1][55], "'" + attack);
  const md = renderedReport(formatMarkdown(report)); assert.equal(md.tables.at(-1)[1][7], attack); assert.equal(md.tables.at(-1)[2][5], attack);
  for (const output of [formatTable(report), formatCsv(report), formatMarkdown(report)]) assert.doesNotMatch(output, /SYNTHETIC_SECRET/);
});

test('invalid/repeated finality flags precede config/env/output/RPC even with help/version', async t => {
  const dir = await sandbox(t); const path = join(dir, 'SYNTHETIC_SECRET'); await fs.writeFile(path, 'original');
  const env = Object.defineProperty({}, 'RPC_DOCTOR_ENDPOINTS_JSON', { get() { assert.fail('env read'); } });
  t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  for (const method of ['realpath', 'lstat', 'access', 'open']) t.mock.method(fs, method, () => assert.fail('filesystem access'));
  for (const args of [['--finality', '--finality'], ['--no-finality'], ...['', 'true', 'false', '0', '1', 'safe', 'SYNTHETIC_SECRET'].map(v => [`--finality=${v}`])]) {
    for (const extra of [[], ['--help'], ['--version']]) {
      const r = await run([...args, ...extra, '--config', '/missing/SYNTHETIC_SECRET', '--output', path, '--overwrite'], env);
      assert.equal(r.code, 2); assert.equal(r.out, ''); assert.match(r.err, /Use --finality|Invalid arguments/); assert.doesNotMatch(r.err, /SYNTHETIC_SECRET|ENOENT|EACCES/);
    }
  }
  for (const extra of [['--help'], ['--version']]) {
    const r = await run(['--finality', ...extra, '--config', '/missing/SYNTHETIC_SECRET', '--output', path], env);
    assert.equal(r.code, 0); assert.equal(r.err, ''); assert.match(r.out, extra[0] === '--help' ? /--finality/ : /^0\.1\.0\n$/);
  }
  assert.equal(await fs.readFile(path, 'utf8'), 'original'); assert.deepEqual(await fs.readdir(dir), ['SYNTHETIC_SECRET']);
});

test('finality configuration equivalents are rejected despite CLI override, before output/RPC', async t => {
  const dir = await sandbox(t); const config = join(dir, 'config.json');
  t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  for (const key of ['finality', 'finalityTags', 'finality-tags', 'safe', 'finalized']) {
    await fs.writeFile(config, JSON.stringify({ [key]: 'SYNTHETIC_SECRET' }));
    const r = await run(['--finality', '--config', config, '--output', join(dir, 'report'), 'http://127.0.0.1']);
    assert.equal(r.code, 2); assert.equal(r.out, ''); assert.match(r.err, /Config must be an object/); assert.doesNotMatch(r.err, /SYNTHETIC_SECRET/);
    assert.deepEqual(await fs.readdir(dir), ['config.json']);
  }
});

for (const format of [undefined, '--json', '--csv', '--markdown']) test(`${format ?? 'table'} finality atomic output preserves complete health 0/1 reports and old file on error 2`, async t => {
  const dir = await sandbox(t); const path = join(dir, 'report'); let now = 0; let trace = []; let failure = false;
  const RealDate = Date;
  t.mock.method(globalThis, 'Date', class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-10-12T00:00:00.000Z'])); } });
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const req = JSON.parse(init.body); trace.push(req); now += 10;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id,
      ...(req.params[0] === 'safe' || (failure && req.method === 'eth_blockNumber')
        ? { error: { code: -32602, message: 'SYNTHETIC_SECRET', data: 'SYNTHETIC_SECRET' } }
        : { result: req.method === 'eth_getBlockByNumber' ? null : req.method === 'eth_call' ? '0x' : req.method === 'eth_getLogs' ? [] : '0x1' }) }));
  });
  const args = ['--finality', '--logs-from', '0', '--logs-to', '0', '--historical-block', '0', '--call-to', address, '--call-data', '0x', '--call-block', '0', '--samples', '1', ...(format ? [format] : []), 'http://127.0.0.1'];
  let exists = false;
  for (const strict of [false, true]) for (const fail of [false, true]) {
    failure = fail; now = 0; trace = []; const input = [...args, ...(strict ? ['--strict'] : [])];
    const r = await run(input); const expectedTrace = trace;
    assert.equal(r.code, fail ? 1 : 0); assert.equal(r.err, ''); assert.equal(trace.length, 7);
    assert.deepEqual(trace.slice(-2).map(r => r.params), [['safe', false], ['finalized', false]]);
    now = 0; trace = [];
    assert.deepEqual(await run([...input, '--output', path, ...(exists ? ['--overwrite'] : [])]), { code: fail ? 1 : 0, out: '', err: '' }); exists = true;
    assert.deepEqual(await fs.readFile(path), Buffer.from(r.out)); assert.deepEqual(trace, expectedTrace); assert.doesNotMatch(r.out, /SYNTHETIC_SECRET/);
    if (format === '--json') { const report = JSON.parse(r.out); assert.equal(report.results[0].finality.safe.rpcErrorKind, 'invalid_params'); assert.equal(report.results[0].finality.finalized.status, 'null'); if (strict) assert.equal(report.healthPolicy.passed, !fail); }
    if (format === '--csv') assert.equal(parseCsv(r.out)[0].length, 110);
    if (format === '--markdown') renderedReport(r.out);
  }
  const old = await fs.readFile(path); trace = [];
  const noOverwrite = await run([...args, '--output', path]); assert.equal(noOverwrite.code, 2); assert.equal(trace.length, 0);
  t.mock.method(fs, 'rename', () => { throw new Error('SYNTHETIC_SECRET'); });
  const r = await run([...args, '--output', path, '--overwrite']);
  assert.equal(r.code, 2); assert.equal(r.out, ''); assert.equal(trace.length, 7); assert.match(r.err, /Report file operation failed/); assert.doesNotMatch(r.err, /SYNTHETIC_SECRET/);
  assert.deepEqual(await fs.readFile(path), old); assert.deepEqual(await fs.readdir(dir), ['report']);
});
