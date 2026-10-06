import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { marked } from 'marked';
import { markdownText, formatMarkdown } from '../src/markdown.js';
import { main } from '../src/cli.js';
import { serve } from './helpers.js';
import { htmlText, renderedReport } from './markdown-output.js';

const fixture = async name => JSON.parse(await readFile(new URL(`../examples/reports/${name}-v1.json`, import.meta.url), 'utf8'));
async function run(args, env = {}) {
  let out = ''; let err = '';
  const code = await main(args, env, { write: value => { out += value; } }, { write: value => { err += value; } });
  return { code, out, err };
}

test('literal plain Markdown tables preserve zeros, huge exact integers, unknowns and disabled features', async () => {
  const report = await fixture('mixed');
  report.results = [report.results[0]];
  const r = report.results[0];
  r.endpoint = 'Київ | `node` &lt;';
  r.chainId = '9007199254740993'; r.lagBlocks = '18446744073709551617';
  r.latencyMs = { min: 0, median: 0.25, p95: 1, p99: 1, max: 1, stddev: 0.5 };
  const before = structuredClone(report);
  const out = formatMarkdown(report);
  assert.ok(out.startsWith('# RPC Doctor report\n\n## Measurement summary\n\n'));
  assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'));
  assert.ok(out.includes('| 1 | Київ &#124; &#96;node&#96; &amp;lt&#59; | healthy | 9007199254740993 | Disabled | 2&#47;2 | 100 | 18446744073709551617 | 18446744073709551617 | 1 | Same&#45;chain peers |'));
  const { tables } = renderedReport(out);
  assert.deepEqual(tables[0], [
    ['Setting', 'Value'], ['Started at (UTC)', '2026-10-05T00:00:00.000Z'],
    ['Generated at (UTC)', '2026-10-05T00:00:00.030Z'], ['Elapsed (ms)', '30'], ['Synthetic demo', 'No'],
    ['Endpoints (input order)', '1'], ['Requested measured samples per accepted endpoint', '2'],
    ['Timeout per request (ms)', '1000'], ['Effective concurrency (all RPC phases)', '3'],
    ['Warm-up calls per accepted endpoint', 'Disabled'], ['Minimum interval between round starts (ms)', 'Disabled'],
    ['Actual pacing wait (ms)', 'Disabled'], ['Completed measured rounds', '2'], ['Expected chain ID', 'Disabled'],
    ['Lag threshold (blocks, inclusive)', '3'], ['Reference endpoint index', 'None — same-chain peer maximum'],
  ]);
  assert.deepEqual(tables[2], [
    ['Index', 'n', 'Min (ms)', 'Median (ms)', 'p95 (ms)', 'p99 (ms)', 'Max (ms)', 'Stddev (ms)'],
    ['1', '2', '0', '0.25', '1', '1', '1', '0.5'],
  ]);
  assert.deepEqual(tables[3][1], ['1', 'None', 'None', 'Disabled', 'Disabled', 'Disabled']);
  assert.deepEqual(tables[4][1], ['1', '10', '30']);
  assert.deepEqual(tables[5], [['Round', 'Start (ms)', 'Finish (ms)'], ['1', '10', '20'], ['2', '20', '30']]);
  assert.equal(tables[1][1][1], 'Київ | `node` &lt;');
  assert.match(out, /Disabled\. No strict PASS\/FAIL/);
  assert.deepEqual(report, before, 'formatting never mutates the measured report');
});

test('independent mixed and failure tables keep partial failures, phases and unknowns observable', async () => {
  const mixed = renderedReport(formatMarkdown(await fixture('mixed'))).tables;
  assert.deepEqual(mixed[1].slice(1), [
    ['1', 'Primary', 'healthy', '1', 'Disabled', '2/2', '100', '18446744073709551617', '0', '1', 'Same-chain peers'],
    ['2', 'Partial', 'degraded', '1', 'Disabled', '1/2', '50', '18446744073709551612', '5', '1', 'Same-chain peers'],
    ['3', 'Other chain', 'healthy', '8453', 'Disabled', '2/2', '100', '18446744073709551617', '—', '0', 'Same-chain peers'],
  ]);
  assert.deepEqual(mixed[3][2], ['2', 'None', 'HTTP_ERROR: 1', 'Disabled', 'Disabled', 'Disabled']);
  const failed = renderedReport(formatMarkdown(await fixture('failure'))).tables;
  assert.deepEqual(failed[1].slice(1), [
    ['1', 'Handshake failed', 'unreachable', '—', 'Disabled', '0/0', '0', '—', '—', '0', 'Same-chain peers'],
    ['2', 'Samples failed', 'unreachable', '1', 'Disabled', '0/2', '0', '—', '—', '0', 'Same-chain peers'],
  ]);
  assert.deepEqual(failed[2].slice(1), [['1', '0', '—', '—', '—', '—', '—', '—'], ['2', '0', '—', '—', '—', '—', '—', '—']]);
  assert.deepEqual(failed[3].slice(1), [
    ['1', 'INVALID_RESULT: 1', 'None', 'Disabled', 'Disabled', 'Disabled'],
    ['2', 'None', 'TIMEOUT: 2', 'Disabled', 'Disabled', 'Disabled'],
  ]);
  assert.deepEqual(failed[4].slice(1), [['1', '—', '—'], ['2', '10', '30']]);
});

test('independent strict failure tables include every reason, skipped warm-up, pacing and unchecked lag', async () => {
  const report = await fixture('strict-fail');
  const { tables, html } = renderedReport(formatMarkdown(report));
  assert.equal(Object.fromEntries(tables[0])['Actual pacing wait (ms)'], '90');
  assert.deepEqual(tables[3].slice(1), [
    ['1', 'None', 'None', '0/0', '0', 'None'], ['2', 'None', 'RPC_ERROR: 1', '0/1', '5', 'RATE_LIMITED: 1'],
  ]);
  assert.deepEqual(tables[6].slice(1), [
    ['Result', 'FAIL'], ['Maximum failed measured calls per endpoint (inclusive)', '0'], ['Maximum known lag (blocks, inclusive)', '3'],
  ]);
  assert.deepEqual(tables[7].slice(1), [
    ['1', 'NETWORK_MISMATCH', 'Reference rejected by the guard.'],
    ['2', 'MEASURED_FAILURES', 'One failed measured call exceeds zero.'],
    ['2', 'WARMUP_FAILURES', 'One warm-up call failed.'],
    ['2', 'REFERENCE_MISMATCH', 'The selected reference is on the wrong chain.'],
  ]);
  assert.deepEqual(tables[8], [['Unchecked lag endpoint index', 'Endpoint'], ['2', 'Warm-up and sample errors']]);
  assert.match(html, /A policy pass does not establish freshness, trust, or uptime/);
  assert.match(html, /Full per-attempt blocks, errors, and timing details are available with --json/);
  const pass = renderedReport(formatMarkdown(await fixture('strict-pass')));
  assert.deepEqual(pass.tables[6][1], ['Result', 'PASS']);
  assert.match(pass.html, /Violations: None/);
});

test('dynamic text survives GFM literally without links, images, HTML, headings, lists or table injection', async () => {
  const attacks = [
    'Київ 🛰 | pipe \\ `code` **bold** _em_ ~~del~~',
    '[link](/relative) ![image](data:x) [id]: /target',
    '<img src=x onerror=alert(1)> <script>alert(1)</script>',
    '<https://example.invalid/a> <public@example.invalid>',
    'https://example.invalid www.example.invalid public@example.invalid ftp://example.invalid',
    '&lt; &#60; &#x3c; &amp; &#38;lt; &#x26;lt; &copy;',
    '\n# heading\r\n- list\t> quote\u0000\u001b\u200e\u2028\u2029\u202e',
    '[x] task\n1. list\n---\n```html\n<iframe>\n```',
  ];
  for (const attack of attacks) {
    const expected = attack.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim();
    const paragraph = marked.parse(markdownText(attack), { gfm: true });
    assert.match(paragraph, /^<p>[^]*<\/p>\n$/);
    assert.equal(htmlText(paragraph.slice(3, -5)), expected);
    assert.doesNotMatch(paragraph.slice(3, -5), /<[^>]*>/);
    const report = await fixture('strict-fail');
    report.results[1].endpoint = attack;
    report.results[1].status = attack;
    report.results[1].errors = { [attack]: 1 };
    report.latencyNotes = [attack]; report.healthPolicy.notes = [attack];
    report.healthPolicy.violations[0].code = attack;
    report.healthPolicy.violations[0].message = attack;
    report.startedAt = attack; report.settings.expectedChain = attack;
    const { tables, html } = renderedReport(formatMarkdown(report));
    assert.equal(tables[1][2][1], expected); assert.equal(tables[1][2][2], expected);
    assert.equal(tables[3][2][2], `${attack}: 1`.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim());
    assert.equal(tables[7][1][1], expected); assert.equal(tables[7][1][2], expected);
    assert.equal(tables[8][1][1], expected); assert.equal(tables[0][1][1], expected);
    assert.equal(Object.fromEntries(tables[0])['Expected chain ID'], expected);
    assert.ok(html.split(paragraph.trim()).length >= 3, 'both latency and policy notes render literally');
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.equal((html.match(/<h2>/g) ?? []).length, 6);
  }
  for (const [value, expected] of [[null, '—'], [undefined, '—'], [0, '0'], [false, 'false'], ['', '']]) {
    assert.equal(markdownText(value), expected);
  }
  assert.equal(markdownText('|`\\[]()<>&'), '&#124;&#96;&#92;&#91;&#93;&#40;&#41;&#60;&#62;&amp;');
});

test('explicit projection omits extra properties at every level and retains zero pacing', async () => {
  const report = await fixture('strict-fail');
  for (const object of [report, report.settings, ...report.results, report.results[1].latencyMs,
    report.results[1].warmup, ...report.rounds, ...report.results[1].observations,
    report.healthPolicy, ...report.healthPolicy.violations]) {
    object.url = 'SYNTHETIC_SECRET'; object.headers = { Authorization: 'SYNTHETIC_SECRET' };
    object.rawProviderMessage = 'SYNTHETIC_SECRET';
  }
  report.pacingWaitMs = 0;
  const out = formatMarkdown(report);
  assert.doesNotMatch(out, /SYNTHETIC/);
  assert.equal(Object.fromEntries(renderedReport(out).tables[0])['Actual pacing wait (ms)'], '0');
});

test('CLI label normalization precedes Markdown escaping and preserves displayed public names', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const { id } = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x0' }));
  });
  for (const [label, expected] of [
    ['  Київ | `🛰`\r\nnode\t ', 'Київ | `🛰` node'], ['public@example.invalid', 'public@example.invalid'],
    ['[link](/x) ![x](y) <b> &lt;', '[link](/x) ![x](y) <b> &lt;'], ['-1', '-1'],
  ]) {
    const result = await run(['--markdown', '--samples', '1', '--expected-chain', '0', `--label=${label}`, 'http://127.0.0.1']);
    assert.equal(result.code, 0, result.err);
    const { tables } = renderedReport(result.out);
    assert.equal(tables[1][1][1], expected);
    assert.equal(tables[1][1][3], '0'); assert.equal(tables[1][1][7], '0');
    assert.equal(tables[1][1][8], '—');
  }
});

test('Markdown conflicts precede help/version/config/environment/RPC and safe invalid flags leak nothing', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; assert.fail('unexpected RPC'); });
  const env = Object.defineProperty({}, 'RPC_DOCTOR_ENDPOINTS_JSON', { get() { assert.fail('unexpected env read'); } });
  for (const flags of [['--markdown', '--json'], ['--json', '--markdown'], ['--markdown', '--csv'], ['--csv', '--markdown'], ['--markdown', '--json', '--csv']]) {
    for (const extra of [[], ['--help'], ['--version']]) {
      const result = await run([...flags, '--config', '/missing/SYNTHETIC_SECRET', ...extra], env);
      assert.equal(result.code, 2); assert.equal(result.out, '');
      assert.equal(result.err, flags.length === 3 ? 'RPC Doctor: Use either --csv or --json, not both.\n'
        : 'RPC Doctor: Use --markdown without --json or --csv.\n');
    }
  }
  for (const flag of ['--markdown=true', '--markdown=false', '--markdown=SYNTHETIC_SECRET', '--no-markdown']) {
    const result = await run([flag, 'http://127.0.0.1/SYNTHETIC_SECRET']);
    assert.deepEqual(result, { code: 2, out: '', err: 'RPC Doctor: Invalid arguments. Use --help for available options.\n' });
  }
  const help = await run(['--markdown', '--help', '--config', '/missing/SYNTHETIC_SECRET'], env);
  assert.equal(help.code, 0); assert.match(help.out, /--markdown/); assert.equal(help.err, '');
  const version = await run(['--markdown', '--version', '--config', '/missing/SYNTHETIC_SECRET'], env);
  assert.deepEqual(version, { code: 0, out: '0.1.0\n', err: '' });
  for (const args of [[], ['--samples', '0'], ['--max-failures', '0'], ['--config', '/missing/SYNTHETIC_SECRET'],
    ['--label', 'https://SYNTHETIC_SECRET.invalid'], ['--demo', '--config', '/missing/SYNTHETIC_SECRET']]) {
    const result = await run(['--markdown', ...args, ...(args.length ? ['http://127.0.0.1/SYNTHETIC_SECRET'] : [])]);
    assert.equal(result.code, 2); assert.equal(result.out, ''); assert.doesNotMatch(result.err, /SYNTHETIC_SECRET/);
  }
  const dir = await mkdtemp(join(tmpdir(), 'rpc-markdown-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ endpoints: [{ url: 'http://127.0.0.1' }], markdown: true }));
  const config = await run(['--markdown', '--config', path]);
  assert.equal(config.code, 2); assert.equal(config.out, '');
  assert.equal(calls, 0, 'Markdown remains CLI-only');
});

test('Markdown runtime failure stays exit 2 with no fabricated report', async t => {
  t.mock.method(performance, 'now', () => { throw new Error('SYNTHETIC_SECRET'); });
  assert.deepEqual(await run(['--markdown', 'http://127.0.0.1']),
    { code: 2, out: '', err: 'RPC Doctor: Unable to complete the check.\n' });
});

test('real CLI demos print full Markdown for default, strict PASS, strict FAIL and no usable endpoints', () => {
  for (const [flags, code, result] of [[[], 0, undefined], [['--strict'], 1, 'FAIL'],
    [['--strict', '--max-failures', '1', '--lag-threshold', '6'], 0, 'PASS'],
    [['--expected-chain', '2'], 1, undefined]]) {
    const processResult = spawnSync(process.execPath, ['bin/rpc-doctor.js', '--demo', '--markdown', '--samples', '3', ...flags], { encoding: 'utf8', timeout: 10000 });
    assert.equal(processResult.status, code, processResult.stderr); assert.equal(processResult.stderr, '');
    const { tables, html } = renderedReport(processResult.stdout);
    assert.equal(Object.fromEntries(tables[0])['Synthetic demo'], 'Yes — local synthetic endpoints');
    assert.deepEqual(tables[1].slice(1).map(r => r[1]), ['RPC 1', 'RPC 2', 'RPC 3']);
    assert.deepEqual(tables[1].slice(1).map(r => r[5]), flags.includes('--expected-chain') ? ['0/0', '0/0', '0/0'] : ['3/3', '3/3', '2/3']);
    if (result) assert.deepEqual(tables[6][1], ['Result', result]);
    assert.match(html, /Endpoint URLs, credentials, headers, and raw provider messages are omitted/);
    assert.doesNotMatch(processResult.stdout, /127\.0\.0\.1|http:/);
  }
  const invalid = spawnSync(process.execPath, ['bin/rpc-doctor.js', '--markdown', '--json'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2); assert.equal(invalid.stdout, '');
});

test('Markdown preserves SIGINT exit 130 with no fabricated partial report', { timeout: 10000 }, async t => {
  let started;
  const requested = new Promise(resolve => { started = resolve; });
  const server = await serve(() => started()); t.after(server.close);
  const child = spawn(process.execPath, ['bin/rpc-doctor.js', '--markdown', server.url], { timeout: 10000 });
  t.after(() => child.kill());
  let out = ''; child.stdout.on('data', chunk => { out += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal }));
  });
  await requested; child.kill('SIGINT');
  assert.deepEqual(await closed, { code: 130, signal: null }); assert.equal(out, '');
});
