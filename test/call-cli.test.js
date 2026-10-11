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

const to = `0x${'ab'.repeat(20)}`;
const flags = ['--call-to', to, '--call-data', '0xdeadbeef', '--call-block', '0xF'];
const fixture = name => JSON.parse(readFileSync(new URL(`../examples/reports/${name}.json`, import.meta.url)));
const extraColumns = ['call_to', 'call_block', 'call_gas', 'call_value', 'call_input_bytes', 'call_status', 'call_attempts',
  'call_return_bytes', 'call_error', 'call_skip_reason', 'call_started_ms', 'call_finished_ms', 'call_duration_ms',
  'call_phase_started_ms', 'call_phase_finished_ms', 'call_phase_duration_ms'];
async function run(args, env = {}) {
  let out = ''; let err = '';
  const code = await main(args, env, { write: s => { out += s; } }, { write: s => { err += s; } });
  return { code, out, err };
}
async function sandbox(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'rpc-call-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}

test('historical-only formats retain bytes recorded at parent 58b0111', () => {
  for (const [name, hashes] of [
    ['historical-outcomes-v1', ['6127258e0ee2fff371f503564ed0670a1a014bc00ea730895a1877250452038e', '9bdbb17ae64396223bb46f1d49173138f01279a3fb51fdc043c88a2343b6b13e', '2a65b96ad0ed77f1877a6fa9ed795e142ff3afbfe454bd8dc36bc53118efc3df', '2d0f7a06e5579562ee7df83d5ec566fec7eb8858e49912b083e78d25fbf1e0f7']],
    ['historical-skipped-v1', ['aa2dd7fea6d78a8e3c564e2a1bfd0f88fd0098d4d44016d24c6f08e927366ba8', '5f0003ab4e529d8953ceb1a1b689598fe8b7ab120b95f51bc2dc897ec2b785d1', '95874ee02a71294af94df47a878ec6c3117bd79a373a783f835d7d52cb8a8168', '83c29e0c1f57b56c410924a335cc0246241f5509d836b774d7fcbba94abbbbdb']],
  ]) {
    const r = fixture(name);
    assert.deepEqual([formatTable(r), JSON.stringify(r, null, 2), formatCsv(r), formatMarkdown(r)].map(s => createHash('sha256').update(s).digest('hex')), hashes);
  }
});

test('call report columns are independent, ordered, exact and do not mutate the shared base columns', () => {
  for (const [name, count] of [['strict-pass-v1', 42], ['historical-outcomes-v1', 55], ['call-outcomes-v1', 58], ['call-skipped-v1', 71], ['strict-pass-v1', 42]]) {
    const r = fixture(name); const before = structuredClone(r); const csv = parseCsv(formatCsv(r));
    assert.ok(csv.every(row => row.length === count));
    formatTable(r); formatMarkdown(r); assert.deepEqual(r, before);
    if (r.settings.call) assert.deepEqual(csv[0].slice(-16), extraColumns);
  }
  const report = fixture('call-outcomes-v1');
  assert.deepEqual(parseCsv(formatCsv(report)).slice(1).map(row => row.slice(42)), [
    ['success', '0', ''], ['success', '4096', ''], ['unsupported', '', 'RPC_ERROR'], ['error', '', 'RPC_ERROR'], ['error', '', 'INVALID_RESULT'],
  ].map(([status, bytes, error]) => [to, '9007199254740993', '100000', '0', '4096', status, '1', bytes, error, '', '2', '3', '1', '2', '3', '1']));
  const md = renderedReport(formatMarkdown(report));
  assert.deepEqual(md.tables.at(-1).slice(1), [
    ['1', 'success', '1', '0', '—', '—', '2', '3', '1'], ['2', 'success', '1', '4096', '—', '—', '2', '3', '1'],
    ['3', 'unsupported', '1', '—', 'RPC_ERROR', '—', '2', '3', '1'], ['4', 'error', '1', '—', 'RPC_ERROR', '—', '2', '3', '1'],
    ['5', 'error', '1', '—', 'INVALID_RESULT', '—', '2', '3', '1'],
  ]);
  assert.match(formatTable(report), /success; attempts 1; return bytes 0; error —/);
  const skipped = fixture('call-skipped-v1');
  assert.deepEqual(parseCsv(formatCsv(skipped)).slice(1).map(row => row.slice(-16)),
    ['handshake_failed', 'network_mismatch'].map(reason => [`0x${'00'.repeat(20)}`, '0', '100000', '0', '0', 'skipped', '0', '', '', reason, '', '', '', '1', '1', '0']));
  assert.match(formatTable(skipped), /skipped; attempts 0; return bytes —; error —; skip reason handshake_failed/);
});

test('safe projections ignore extras and keep call Markdown text and CSV formulas inert', () => {
  const report = fixture('call-outcomes-v1');
  report.settings.call.input = report.callPhase.raw = report.results[0].call.raw = 'SYNTHETIC_SECRET';
  const attack = '= <img src=x> [x](y) | `tick` https://example.invalid a@example.invalid';
  report.settings.call.to = attack;
  report.results[0].call.error = attack;
  const csv = parseCsv(formatCsv(report));
  assert.equal(csv[1][42], "'" + attack); assert.equal(csv[1][50], "'" + attack);
  const md = renderedReport(formatMarkdown(report));
  assert.equal(md.tables.at(-2)[1][1], attack); assert.equal(md.tables.at(-1)[1][4], attack);
  for (const output of [formatTable(report), formatCsv(report), formatMarkdown(report)]) assert.doesNotMatch(output, /SYNTHETIC_SECRET/);
});

test('triplet syntax, duplicates and boundaries are validated before config/env/RPC/output, even with help/version', async t => {
  const dir = await sandbox(t); const path = join(dir, 'SYNTHETIC_SECRET'); await fs.writeFile(path, 'original');
  const env = Object.defineProperty({}, 'RPC_DOCTOR_ENDPOINTS_JSON', { get() { assert.fail('env read'); } });
  t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  for (const method of ['realpath', 'lstat', 'access', 'open']) t.mock.method(fs, method, () => assert.fail('filesystem access'));
  const bad = [
    ...['--call-to', '--call-data', '--call-block'].flatMap((key, i) => [[key], [key, flags[i * 2 + 1]], [...flags, key, flags[i * 2 + 1]], flags.filter((_, index) => Math.floor(index / 2) !== i)]),
    ...['', '0x', to + '\n', 'SYNTHETIC_SECRET'].map(value => ['--call-to', value, ...flags.slice(2)]),
    ...['', '0x0', '0xzz', '0x00\n', `0x${'ab'.repeat(4097)}`, 'SYNTHETIC_SECRET'].map(value => [...flags.slice(0, 2), '--call-data', value, ...flags.slice(4)]),
    ...['', '0\n', '-1', '+1', '01', '0x01', '1.5', '1e3', 'latest', 'pending', 'safe', 'finalized', 'earliest', '9'.repeat(79), (2n ** 256n).toString()].map(value => [...flags.slice(0, 4), `--call-block=${value}`]),
  ];
  for (const args of bad) for (const extra of [[], ['--help'], ['--version']]) {
    const result = await run([...args, ...extra, '--config', '/missing/SYNTHETIC_SECRET', '--output', path, '--overwrite'], env);
    assert.equal(result.code, 2); assert.equal(result.out, ''); assert.doesNotMatch(result.err, /SYNTHETIC_SECRET|ENOENT|EACCES/);
    assert.match(result.err, /Call |Use --call|Invalid arguments/);
  }
  for (const extra of [['--help'], ['--version']]) {
    const result = await run([...flags, ...extra, '--config', '/missing/SYNTHETIC_SECRET', '--output', path], env);
    assert.equal(result.code, 0); assert.equal(result.err, '');
    assert.match(result.out, extra[0] === '--help' ? /--call-to/ : /^0\.1\.0\n$/);
  }
  assert.equal(await fs.readFile(path, 'utf8'), 'original'); assert.deepEqual(await fs.readdir(dir), ['SYNTHETIC_SECRET']);
});

test('call remains CLI-only with no config overrides or extra transaction options', async t => {
  const dir = await sandbox(t); const config = join(dir, 'config.json');
  t.mock.method(globalThis, 'fetch', () => assert.fail('RPC'));
  for (const key of ['call', 'callTo', 'callData', 'callBlock']) {
    await fs.writeFile(config, JSON.stringify({ [key]: 'SYNTHETIC_SECRET' }));
    const result = await run([...flags, '--config', config, '--output', join(dir, 'report'), 'http://127.0.0.1']);
    assert.equal(result.code, 2); assert.equal(result.out, ''); assert.match(result.err, /Config must be an object/);
    assert.deepEqual(await fs.readdir(dir), ['config.json']);
  }
  for (const key of ['--call-from', '--call-value', '--call-gas', '--call-method', '--state-override']) {
    const result = await run([...flags, key, '1']); assert.equal(result.code, 2); assert.match(result.err, /Invalid arguments/);
  }
});

for (const format of [undefined, '--json', '--csv', '--markdown']) {
  test(`${format ?? 'table'} saves complete call reports on health 0/1 and preserves old output on file error 2`, async t => {
    const dir = await sandbox(t); const path = join(dir, 'report');
    let now = 0; let trace = []; let failure = false;
    const RealDate = Date;
    t.mock.method(globalThis, 'Date', class extends RealDate {
      constructor(...args) { super(...(args.length ? args : ['2026-10-11T00:00:00.000Z'])); }
    });
    t.mock.method(performance, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const req = JSON.parse(init.body); trace.push(req); now += 10;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id,
        ...(req.method === 'eth_call' || (failure && req.method === 'eth_blockNumber')
          ? { error: { code: 3, message: 'SYNTHETIC_SECRET', data: '0xfeedbeef' } }
          : { result: req.method === 'eth_getBlockByNumber' ? null : '0x1' }) }));
    });
    const args = [...flags, '--historical-block', '0', '--samples', '1', '--strict', ...(format ? [format] : []), 'http://127.0.0.1'];
    for (const fail of [false, true]) {
      failure = fail; now = 0; trace = [];
      const result = await run(args); const expectedTrace = trace;
      assert.equal(result.code, fail ? 1 : 0); assert.equal(result.err, '');
      assert.equal(trace.length, 4); assert.deepEqual(trace[3].params, [{ to, input: '0xdeadbeef', gas: '0x186a0', value: '0x0' }, '0xf']);
      now = 0; trace = [];
      const saved = await run([...args, '--output', path, ...(fail ? ['--overwrite'] : [])]);
      assert.deepEqual(saved, { code: fail ? 1 : 0, out: '', err: '' });
      assert.deepEqual(await fs.readFile(path), Buffer.from(result.out)); assert.deepEqual(trace, expectedTrace);
      assert.doesNotMatch(result.out, /SYNTHETIC_SECRET|deadbeef|feedbeef/);
      if (format === '--json') {
        const report = JSON.parse(result.out); assert.equal(report.results[0].call.status, 'error'); assert.equal(report.healthPolicy.passed, !fail);
      } else if (format === '--markdown') renderedReport(result.out);
      else if (format === '--csv') assert.equal(parseCsv(result.out)[0].length, 71);
    }
    const old = await fs.readFile(path);
    t.mock.method(fs, 'rename', () => { throw new Error('SYNTHETIC_SECRET'); });
    trace = [];
    const failed = await run([...args, '--output', path, '--overwrite']);
    assert.equal(failed.code, 2); assert.equal(failed.out, ''); assert.equal(trace.length, 4);
    assert.match(failed.err, /Report file operation failed/); assert.doesNotMatch(failed.err, /SYNTHETIC_SECRET/);
    assert.deepEqual(await fs.readFile(path), old); assert.deepEqual(await fs.readdir(dir), ['report']);
  });
}

test('real CLI demo accepts maximum calldata and empty input, preserving measured and historical outcomes', () => {
  for (const [extra, expected] of [[[], 0], [['--strict'], 1], [['--strict', '--max-failures', '1', '--lag-threshold', '6'], 0], [['--expected-chain', '2'], 1]]) {
    const r = spawnSync(process.execPath, ['bin/rpc-doctor.js', '--demo', '--samples', '3', '--historical-block', '0', '--call-to', to,
      '--call-data', extra.length ? '0x' : `0x${'ff'.repeat(4096)}`, '--call-block', '0', '--json', ...extra], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, expected, r.stderr); assert.equal(r.stderr, ''); const report = JSON.parse(r.stdout);
    assert.deepEqual(report.results.map(r => r.call.status), extra.includes('--expected-chain') ? ['skipped', 'skipped', 'skipped'] : ['success', 'success', 'error']);
    if (!extra.includes('--expected-chain')) {
      assert.deepEqual(report.results.map(r => r.call.returnBytes), [0, 2, null]);
      assert.deepEqual(report.results.map(r => r.historicalBlock.status), ['found', 'null', 'unsupported']);
      assert.deepEqual(report.results.map(r => r.successes), [3, 3, 2]);
    }
    assert.equal(report.settings.call.block, '0');
  }
});
