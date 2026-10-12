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

const address = `0x${'ab'.repeat(20)}`; const topic = `0x${'11'.repeat(32)}`;
const pair = ['--logs-from', '0', '--logs-to', '0x63'];
const filters = ['--logs-address', address, '--logs-topic0', topic];
const fixture = name => JSON.parse(readFileSync(new URL(`../examples/reports/${name}.json`, import.meta.url)));
const extraColumns = ['logs_from_block', 'logs_to_block', 'logs_address', 'logs_topic0', 'logs_status', 'logs_attempts',
  'logs_count', 'logs_removed_count', 'logs_error', 'logs_skip_reason', 'logs_started_ms', 'logs_finished_ms', 'logs_duration_ms',
  'logs_phase_started_ms', 'logs_phase_finished_ms', 'logs_phase_duration_ms'];
async function run(args, env = {}) {
  let out = ''; let err = '';
  const code = await main(args, env, { write: s => { out += s; } }, { write: s => { err += s; } });
  return { code, out, err };
}
async function sandbox(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'rpc-logs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}

test('call-only and historical+call output bytes match parent cff3efe', () => {
  for (const [name, hashes] of [
    ['call-outcomes-v1', ['4cd072de843ecb29305e41a2dc1cbedac01f4b45f00a866af63e2f9863448e5a', '8e3cc36391b49e1d3fc2cf4be8f87fbb083e10f6388c05b251432b26c75b729b', '24c5be50afa6f690cc287c1f6b2815af36a437e45f75360c8a97153e6547a2c2', '9a800bc5fc7586deaa6568d8d554dc9799c52a3b75fd954258b900468e8c2cf0']],
    ['call-skipped-v1', ['dd961f5e47d164e18bf8b5b2e77d47d3a1182fd36bee0dc49e11967dc7851866', 'ab8cb2945dd114ee38c21fb24795610cf14809866b58d310f094cde252dec757', '3e67c7b161671277b8f7cf5f8d2046ce064a7bea3ff56975a01bda46e8eba814', '4bef0a3cb7d679ce6d3499722f7f30619f1ea976ffe898f5dfbc4b0b56d2fb07']],
  ]) {
    const r = fixture(name);
    assert.deepEqual([formatTable(r), JSON.stringify(r, null, 2), formatCsv(r), formatMarkdown(r)].map(s => createHash('sha256').update(s).digest('hex')), hashes);
  }
});

test('all eight optional-probe combinations preserve CSV prefix/order/CRLF and do not mutate reports', () => {
  for (const h of [false, true]) for (const c of [false, true]) for (const l of [false, true]) {
    const report = fixture('logs-skipped-v1');
    for (const [enabled, setting, phase, result] of [[h, 'historicalBlock', 'historicalPhase', 'historicalBlock'], [c, 'call', 'callPhase', 'call'], [l, 'logs', 'logsPhase', 'logs']]) {
      if (!enabled) { delete report.settings[setting]; delete report[phase]; report.results.forEach(r => delete r[result]); }
    }
    const before = structuredClone(report); const text = formatCsv(report); const csv = parseCsv(text);
    assert.ok(csv.every(row => row.length === 42 + Number(h) * 13 + Number(c) * 16 + Number(l) * 16));
    assert.ok(text.endsWith('\r\n')); assert.doesNotMatch(text, /(?<!\r)\n/);
    if (l) assert.deepEqual(csv[0].slice(-16), extraColumns);
    formatTable(report); renderedReport(formatMarkdown(report)); assert.deepEqual(report, before);
  }
  assert.equal(parseCsv(formatCsv(fixture('strict-pass-v1')))[0].length, 42);
});

test('independent log formats retain exact range, counts, removed counts and unavailable values', () => {
  const report = fixture('logs-outcomes-v1');
  assert.deepEqual(parseCsv(formatCsv(report)).slice(1).map(row => row.slice(-16)), [
    ['success', '0', '0', '', '3', '1'], ['success', '1000', '2', '', '3', '1'], ['unsupported', '', '', 'RPC_ERROR', '3', '1'], ['error', '', '', 'TIMEOUT', '1002', '1000'],
  ].map(([status, count, removed, error, finish, duration]) => ['9007199254740993', '9007199254741092', address, topic, status, '1', count, removed, error, '', '2', finish, duration, '2', '1002', '1000']));
  assert.deepEqual(renderedReport(formatMarkdown(report)).tables.at(-1).slice(1), [
    ['1', 'success', '1', '0', '0', '—', '—', '2', '3', '1'], ['2', 'success', '1', '1000', '2', '—', '—', '2', '3', '1'],
    ['3', 'unsupported', '1', '—', '—', 'RPC_ERROR', '—', '2', '3', '1'], ['4', 'error', '1', '—', '—', 'TIMEOUT', '—', '2', '1002', '1000'],
  ]);
  assert.match(formatTable(report), /success; attempts 1; logs 0; removed 0; error —/);
  const skipped = fixture('logs-skipped-v1');
  assert.deepEqual(parseCsv(formatCsv(skipped)).slice(1).map(row => row.slice(-16)),
    ['handshake_failed', 'network_mismatch'].map(reason => ['0', '0', '', '', 'skipped', '0', '', '', '', reason, '', '', '', '1', '1', '0']));
  const md = renderedReport(formatMarkdown(skipped));
  assert.deepEqual(md.tables.at(-2).slice(1, 5), [['From block (decimal, inclusive)', '0'], ['To block (decimal, inclusive)', '0'], ['Address (public filter)', 'Any'], ['Topic0 (public filter)', 'Any']]);
  assert.match(formatTable(skipped), /skipped; attempts 0; logs —; removed —; error —; skip reason handshake_failed/);
});

test('log format projection discards extras and keeps dynamic Markdown and CSV text inert', () => {
  const report = fixture('logs-outcomes-v1');
  report.settings.logs.raw = report.logsPhase.raw = report.results[0].logs.raw = 'SYNTHETIC_SECRET';
  const attack = '= <img src=x> [x](y) | `tick` https://example.invalid a@example.invalid';
  report.settings.logs.address = attack; report.results[0].logs.error = attack;
  const csv = parseCsv(formatCsv(report)); assert.equal(csv[1][44], "'" + attack); assert.equal(csv[1][50], "'" + attack);
  const md = renderedReport(formatMarkdown(report)); assert.equal(md.tables.at(-2)[3][1], attack); assert.equal(md.tables.at(-1)[1][5], attack);
  for (const output of [formatTable(report), formatCsv(report), formatMarkdown(report)]) assert.doesNotMatch(output, /SYNTHETIC_SECRET/);
});

test('invalid/repeated ranges and filters precede config/env/output/RPC including help/version', async t => {
  const dir = await sandbox(t); const path = join(dir, 'SYNTHETIC_SECRET'); await fs.writeFile(path, 'original');
  const env = Object.defineProperty({}, 'RPC_DOCTOR_ENDPOINTS_JSON', { get() { assert.fail('env read'); } });
  t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  for (const method of ['realpath', 'lstat', 'access', 'open']) t.mock.method(fs, method, () => assert.fail('filesystem access'));
  const flags = [...pair, ...filters];
  const bad = [
    ...['--logs-from', '--logs-to', '--logs-address', '--logs-topic0'].flatMap((key, i) => [[key], [key, flags[i * 2 + 1]], [...flags, `${key}=${flags[i * 2 + 1]}`]]),
    ['--logs-from', '1', '--logs-to', '0'], ['--logs-from', '0', '--logs-to', '100'],
    ...['', '0\n', '-1', '+1', '01', '0x01', '1.5', '1e3', 'latest', 'pending', 'safe', 'finalized', 'earliest', '9'.repeat(79), (2n ** 256n).toString(), 'SYNTHETIC_SECRET'].flatMap(value => [
      [`--logs-from=${value}`, '--logs-to', '0'], ['--logs-from', '0', `--logs-to=${value}`],
    ]),
    ...['', '0x', address + '\n', '[]', 'SYNTHETIC_SECRET'].map(value => [...pair, '--logs-address', value]),
    ...['', '0x', topic + '\n', `["${topic}"]`, 'SYNTHETIC_SECRET'].map(value => [...pair, '--logs-topic0', value]),
  ];
  for (const args of bad) for (const extra of [[], ['--help'], ['--version']]) {
    const r = await run([...args, ...extra, '--config', '/missing/SYNTHETIC_SECRET', '--output', path, '--overwrite'], env);
    assert.equal(r.code, 2); assert.equal(r.out, ''); assert.doesNotMatch(r.err, /SYNTHETIC_SECRET|ENOENT|EACCES/);
    assert.match(r.err, /Log |Use --logs|Use each log|Invalid arguments/);
  }
  for (const extra of [['--help'], ['--version']]) {
    const r = await run([...flags, ...extra, '--config', '/missing/SYNTHETIC_SECRET', '--output', path], env);
    assert.equal(r.code, 0); assert.equal(r.err, ''); assert.match(r.out, extra[0] === '--help' ? /--logs-from/ : /^0\.1\.0\n$/);
  }
  assert.equal(await fs.readFile(path, 'utf8'), 'original'); assert.deepEqual(await fs.readdir(dir), ['SYNTHETIC_SECRET']);
});

test('log configuration equivalents are rejected even with valid CLI overrides', async t => {
  const dir = await sandbox(t); const config = join(dir, 'config.json');
  t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  for (const key of ['logs', 'logsFrom', 'logsTo', 'logsAddress', 'logsTopic0', 'logs-from', 'logs-to', 'logs-address', 'logs-topic0']) {
    await fs.writeFile(config, JSON.stringify({ [key]: 'SYNTHETIC_SECRET' }));
    const r = await run([...pair, ...filters, '--config', config, '--output', join(dir, 'report'), 'http://127.0.0.1']);
    assert.equal(r.code, 2); assert.equal(r.out, ''); assert.match(r.err, /Config must be an object/); assert.doesNotMatch(r.err, /SYNTHETIC_SECRET/);
    assert.deepEqual(await fs.readdir(dir), ['config.json']);
  }
});

for (const format of [undefined, '--json', '--csv', '--markdown']) test(`${format ?? 'table'} atomic output includes logs on health 0/1 and preserves prior file on error 2`, async t => {
  const dir = await sandbox(t); const path = join(dir, 'report'); let now = 0; let trace = []; let failure = false;
  const RealDate = Date;
  t.mock.method(globalThis, 'Date', class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-10-12T00:00:00.000Z'])); } });
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const req = JSON.parse(init.body); trace.push(req); now += 10;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id,
      ...(req.method === 'eth_getLogs' || (failure && req.method === 'eth_blockNumber')
        ? { error: { code: -32005, message: 'SYNTHETIC_SECRET', data: 'SYNTHETIC_SECRET' } }
        : { result: req.method === 'eth_getBlockByNumber' ? null : req.method === 'eth_call' ? '0x' : '0x1' }) }));
  });
  const args = [...pair, ...filters, '--historical-block', '0', '--call-to', address, '--call-data', '0x', '--call-block', '0', '--samples', '1', '--strict', ...(format ? [format] : []), 'http://127.0.0.1'];
  for (const fail of [false, true]) {
    failure = fail; now = 0; trace = []; const r = await run(args); const expectedTrace = trace;
    assert.equal(r.code, fail ? 1 : 0); assert.equal(r.err, ''); assert.equal(trace.length, 5);
    assert.deepEqual(trace[4].params, [{ fromBlock: '0x0', toBlock: '0x63', address, topics: [topic] }]);
    now = 0; trace = [];
    assert.deepEqual(await run([...args, '--output', path, ...(fail ? ['--overwrite'] : [])]), { code: fail ? 1 : 0, out: '', err: '' });
    assert.deepEqual(await fs.readFile(path), Buffer.from(r.out)); assert.deepEqual(trace, expectedTrace); assert.doesNotMatch(r.out, /SYNTHETIC_SECRET/);
    if (format === '--json') { const report = JSON.parse(r.out); assert.equal(report.results[0].logs.status, 'error'); assert.equal(report.healthPolicy.passed, !fail); }
    if (format === '--csv') assert.equal(parseCsv(r.out)[0].length, 87);
    if (format === '--markdown') renderedReport(r.out);
  }
  const old = await fs.readFile(path); trace = [];
  t.mock.method(fs, 'rename', () => { throw new Error('SYNTHETIC_SECRET'); });
  const r = await run([...args, '--output', path, '--overwrite']);
  assert.equal(r.code, 2); assert.equal(r.out, ''); assert.equal(trace.length, 5); assert.match(r.err, /Report file operation failed/); assert.doesNotMatch(r.err, /SYNTHETIC_SECRET/);
  assert.deepEqual(await fs.readFile(path), old); assert.deepEqual(await fs.readdir(dir), ['report']);
});
