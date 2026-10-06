import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { csvCell, formatCsv } from '../src/csv.js';
import { main } from '../src/cli.js';
import { parseCsv } from './csv-parser.js';
import { serve } from './helpers.js';

// Independent public contract, not imported from the formatter's column table.
const HEADER = '"endpoint_index","endpoint","chain_id","status","network_status","attempts","successes","success_rate_pct","latency_sample_count","latency_min_ms","latency_median_ms","latency_p95_ms","latency_p99_ms","latency_max_ms","latency_stddev_ms","latest_block","lag_blocks","peer_count","handshake_errors","sample_errors","warmup_attempts","warmup_successes","warmup_duration_ms","warmup_errors","reference_index","lag_status","expected_chain","lag_threshold_blocks","samples","timeout_ms","concurrency","warmup_requested","interval_ms","pacing_wait_ms","started_at","generated_at","duration_ms","demo","strict_passed","strict_max_failures","strict_violations","strict_lag_check"';
const stamp = '2026-10-06T00:00:00.000Z';
function sampleReport() {
  return { schemaVersion: 1, startedAt: stamp, generatedAt: stamp, durationMs: 0,
    settings: { samples: 1, timeoutMs: 1000, concurrency: 1, lagThreshold: 0 },
    results: [{ endpoint: 'Node, "Ж"', chainId: '9007199254740993', latestBlock: '18446744073709551617',
      status: 'healthy', attempts: 1, successes: 1, successRate: 100, latencySampleCount: 1,
      latencyMs: { min: 0, median: 0, p95: 0, p99: 0, max: 0, stddev: 0 },
      lagBlocks: null, peerCount: 0, errors: {} }],
  };
}
function records(text) {
  assert.ok(text.startsWith(HEADER + '\r\n'));
  assert.ok(text.endsWith('\r\n'));
  assert.ok(!text.endsWith('\r\n\r\n'));
  const [headers, ...rows] = parseCsv(text);
  assert.equal(headers.length, 42);
  return rows.map(row => {
    assert.equal(row.length, headers.length);
    return Object.fromEntries(headers.map((header, i) => [header, row[i]]));
  });
}
async function run(args, env = {}) {
  let out = ''; let err = '';
  const code = await main(args, env, { write: s => { out += s; } }, { write: s => { err += s; } });
  return { code, out, err };
}

test('independent test parser handles standard records and malformed quotes', () => {
  assert.deepEqual(parseCsv('a,b,c\r\n"x,y","a""b","a\r\nb"\r\n,,""'),
    [['a', 'b', 'c'], ['x,y', 'a"b', 'a\r\nb'], ['', '', '']]);
  assert.deepEqual(parseCsv('""\r\n'), [['']]);
  assert.throws(() => parseCsv('"unclosed'), /Unclosed/);
  assert.throws(() => parseCsv('"a"b'), /Unexpected/);
});

test('literal CSV contract preserves exact decimal strings, real zeros, unknowns and disabled fields', () => {
  const report = sampleReport();
  const before = structuredClone(report);
  const expected = HEADER + '\r\n' +
    '"1","Node, ""Ж""","9007199254740993","healthy","","1","1","100","1","0","0","0","0","0","0","18446744073709551617","","0","{}","{}","","","","","","","","0","1","1000","1","","","","2026-10-06T00:00:00.000Z","2026-10-06T00:00:00.000Z","0","","","","",""\r\n';
  const out = formatCsv(report);
  assert.equal(out, expected);
  assert.deepEqual(report, before);
  const [row] = records(out);
  assert.equal(row.latest_block, '18446744073709551617');
  assert.equal(row.lag_blocks, '');
  assert.equal(row.latency_stddev_ms, '0');
  assert.equal(row.strict_passed, '');
  assert.equal(row.warmup_errors, '');
});

test('CSV cells escape separators, quotes and line breaks with independent literal expectations', () => {
  for (const [input, output] of [
    ['a,b', '"a,b"'], ['a"b', '"a""b"'], ['a\r\nb', '"a\r\nb"'], ['a\nb', '"a\nb"'],
    ['a\rb', '"a\rb"'], ['', '""'], [null, '""'], [undefined, '""'], [0, '"0"'],
    [false, '"false"'], [' Київ 🛰 ', '" Київ 🛰 "'], ['plain",=1', '"plain"",=1"'],
  ]) {
    assert.equal(csvCell(input), output);
    assert.deepEqual(parseCsv(output), [[input == null ? '' : String(input)]]);
  }
});

test('dangerous text prefixes receive an apostrophe before CSV quoting, including whitespace/control prefixes', () => {
  for (const text of ['=1+1', '+SUM(1)', '-1', '@SUM(1)', '＝1', '＋1', '－1', '＠1',
    '  =1', '\t=1', '\r-1', '\n@1', '\u0000+1', '\u001b=1', '\u200e=1', '\u00a0\u202f=1',
    ' \ttext', '\rtext', '\ntext', '=1";=2']) {
    assert.deepEqual(parseCsv(csvCell(text)), [[`'${text}`]]);
    assert.ok(csvCell(text).startsWith('"\''));
  }
  assert.equal(csvCell('=1";=2'), '"\'=1"";=2"');
  assert.equal(csvCell("'=1"), '"\'=1"', 'an existing apostrophe is not duplicated');
  assert.equal(csvCell('A=1'), '"A=1"');
  // Protection is centralized for every selected string cell, not just labels.
  const report = sampleReport();
  report.results[0].status = '\u200e=1';
  report.generatedAt = '  +1';
  const [row] = records(formatCsv(report));
  assert.equal(row.status, "'\u200e=1");
  assert.equal(row.generated_at, "'  +1");
});

test('error maps and strict reasons preserve order/phase without exporting arbitrary report properties', () => {
  const report = sampleReport();
  const row = report.results[0];
  row.errors = { TIMEOUT: 1, HTTP_ERROR: 2 };
  row.warmup = { attempts: 2, successes: 1, durationMs: 0, errors: { RPC_ERROR: 1 } };
  report.healthPolicy = { passed: false, maxFailures: 0, uncheckedLagEndpoints: [1],
    violations: [{ endpointIndex: 1, code: 'MEASURED_FAILURES', message: 'SYNTHETIC_SECRET' }] };
  report.url = row.url = row.headers = 'SYNTHETIC_SECRET';
  let out = formatCsv(report);
  let [parsed] = records(out);
  assert.equal(parsed.handshake_errors, '{}');
  assert.equal(parsed.sample_errors, '{"HTTP_ERROR":2,"TIMEOUT":1}');
  assert.equal(parsed.warmup_errors, '{"RPC_ERROR":1}');
  assert.equal(parsed.warmup_duration_ms, '0');
  assert.equal(parsed.strict_passed, 'false');
  assert.equal(parsed.strict_violations, '["MEASURED_FAILURES"]');
  assert.equal(parsed.strict_lag_check, 'unchecked');
  assert.doesNotMatch(out, /SYNTHETIC_SECRET/);
  row.chainId = null;
  row.errors = { INVALID_RESULT: 1 };
  [parsed] = records(formatCsv(report));
  assert.equal(parsed.handshake_errors, '{"INVALID_RESULT":1}');
  assert.equal(parsed.sample_errors, '{}');
});

const big = '0x20000000000001';
for (const [name, plans, flags, statuses, expectedCode] of [
  ['healthy and mixed chains', [{}, { chain: '0x2105' }], [], ['healthy', 'healthy'], 0],
  ['partial sample failure', [{ blocks: [null, big] }, {}], [], ['degraded', 'healthy'], 0],
  ['failed handshake and all failed samples', [{ chain: null }, { blocks: [null, null] }], [], ['unreachable', 'unreachable'], 1],
  ['mismatch', [{ chain: '0x2' }], ['--expected-chain', '1'], ['mismatch'], 1],
  ['enabled warm-up skipped by mismatch', [{ chain: '0x2' }], ['--expected-chain', '1', '--warmup', '2', '--strict'], ['mismatch'], 1],
  ['unavailable reference', [{ chain: null }, {}], ['--reference', '1', '--strict'], ['unreachable', 'degraded'], 1],
  ['warm-up errors', [{ blocks: [null, big, big] }], ['--warmup', '1', '--strict'], ['degraded'], 1],
  ['strict pass with partial failure', [{ blocks: [null, big] }], ['--strict', '--max-failures', '1'], ['degraded'], 0],
  ['usable reference strict pass', [{}, {}], ['--reference', '1', '--strict'], ['healthy', 'healthy'], 0],
  ['strict fail despite usable data', [{ blocks: [null, big] }], ['--strict'], ['degraded'], 1],
  ['positive and zero wait', [{}], ['--interval', '1', '--warmup', '0'], ['healthy'], 0],
]) {
  test(`CSV CLI matches the same JSON fake-run: ${name}`, async (t) => {
    let now = 0; let indices; let calls;
    t.mock.method(performance, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const index = Number(new URL(url).pathname.slice(1));
      const request = JSON.parse(options.body);
      calls.push({ index, ...request }); now += 10;
      const plan = plans[index];
      const result = request.method === 'eth_chainId' ? ('chain' in plan ? plan.chain : '0x1')
        : (plan.blocks ?? [big, big])[indices[index]++];
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        ...(result === null ? { error: { code: -32000, message: 'SYNTHETIC_SECRET' } } : { result }),
      }));
    });
    const env = { RPC_DOCTOR_ENDPOINTS_JSON: JSON.stringify(plans.map((_, i) => `http://127.0.0.1/${i}?key=SYNTHETIC_SECRET`)) };
    const runs = [];
    for (const format of ['--json', '--csv']) {
      now = 0; indices = plans.map(() => 0); calls = [];
      const result = await run(['--samples', '2', '--concurrency', '2', ...flags, format], env);
      assert.equal(result.code, expectedCode, result.err);
      assert.equal(result.err, '');
      assert.doesNotMatch(result.out, /SYNTHETIC_SECRET|127\.0\.0\.1/);
      runs.push({ ...result, calls });
    }
    assert.deepEqual(runs[0].calls, runs[1].calls);
    const report = JSON.parse(runs[0].out);
    const rows = records(runs[1].out);
    assert.equal(rows.length, plans.length);
    assert.deepEqual(rows.map(r => r.status), statuses);
    const cell = value => value == null ? '' : String(value);
    rows.forEach((row, i) => {
      const source = report.results[i];
      assert.equal(row.endpoint_index, String(i + 1));
      for (const [column, key] of [['endpoint', 'endpoint'], ['chain_id', 'chainId'], ['latest_block', 'latestBlock'], ['lag_blocks', 'lagBlocks'], ['status', 'status'], ['network_status', 'networkStatus'], ['attempts', 'attempts'], ['successes', 'successes'], ['success_rate_pct', 'successRate'], ['latency_sample_count', 'latencySampleCount'], ['peer_count', 'peerCount'], ['lag_status', 'lagStatus']]) assert.equal(row[column], cell(source[key]), column);
      for (const metric of ['min', 'median', 'p95', 'p99', 'max', 'stddev']) assert.equal(row[`latency_${metric}_ms`], cell(source.latencyMs[metric]));
      assert.deepEqual(JSON.parse(row.handshake_errors), source.chainId === null ? source.errors : {});
      assert.deepEqual(JSON.parse(row.sample_errors), source.chainId === null ? {} : source.errors);
      assert.equal(row.warmup_attempts, cell(source.warmup?.attempts));
      assert.equal(row.warmup_successes, cell(source.warmup?.successes));
      assert.equal(row.warmup_duration_ms, cell(source.warmup?.durationMs));
      assert.deepEqual(row.warmup_errors ? JSON.parse(row.warmup_errors) : undefined, source.warmup?.errors);
      for (const [column, key] of [['samples', 'samples'], ['timeout_ms', 'timeoutMs'], ['concurrency', 'concurrency'], ['reference_index', 'reference'], ['expected_chain', 'expectedChain'], ['lag_threshold_blocks', 'lagThreshold'], ['warmup_requested', 'warmup'], ['interval_ms', 'intervalMs']]) assert.equal(row[column], cell(report.settings[key]), column);
      assert.equal(row.pacing_wait_ms, cell(report.pacingWaitMs));
      assert.equal(row.duration_ms, cell(report.durationMs));
      assert.equal(row.strict_passed, cell(report.healthPolicy?.passed));
      assert.equal(row.strict_max_failures, cell(report.healthPolicy?.maxFailures));
      assert.deepEqual(row.strict_violations ? JSON.parse(row.strict_violations) : undefined,
        report.healthPolicy?.violations.filter(v => v.endpointIndex === i + 1).map(v => v.code));
      assert.equal(row.strict_lag_check, !report.healthPolicy ? '' : !source.successes ? 'no_samples' : source.lagBlocks === null ? 'unchecked' : 'compared');
      assert.ok(Number.isFinite(Date.parse(row.started_at)));
      assert.ok(Number.isFinite(Date.parse(row.generated_at)));
    });
  });
}

test('CLI normalizes newline/control labels before escaping Unicode, commas, quotes and formula prefixes', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const { id } = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x1' }));
  });
  for (const [label, expected] of [['  Київ, "🛰"\r\nnode\t ', 'Київ, "🛰" node'], ['\t\u200e =1+1', "'=1+1"], [' +1', "'+1"], ['-1', "'-1"], ['@x', "'@x"], ['＝1', "'＝1"]]) {
    const result = await run(['--csv', '--samples', '1', `--label=${label}`, 'http://127.0.0.1']);
    assert.equal(result.code, 0, result.err);
    assert.equal(records(result.out)[0].endpoint, expected);
  }
});

test('CSV preserves nonzero pacing, warm-up, concurrency and aggregate timings from the same fake run', async (t) => {
  let now = 0; let calls = []; let nextTimer = 0;
  const timers = new Map();
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = ++nextTimer; timers.set(id, { callback, due: now + delay }); return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = JSON.parse(options.body); calls.push({ url, ...request }); now += 10;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: big }));
  });
  const outputs = []; const requests = [];
  for (const format of ['--json', '--csv']) {
    now = 0; calls = [];
    const running = run([format, '--samples', '2', '--warmup', '1', '--concurrency', '1', '--interval', '100', '--strict', 'http://127.0.0.1/first', 'http://127.0.0.1/second']);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(timers.size, 1, 'RPC timers cleared; only the pacing wait remains');
    const [id, timer] = [...timers][0]; timers.delete(id); now = timer.due; timer.callback();
    const result = await running;
    assert.equal(result.code, 0, result.err);
    assert.equal(timers.size, 0);
    outputs.push(result.out); requests.push(calls);
  }
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].length, 8);
  const report = JSON.parse(outputs[0]);
  assert.equal(report.pacingWaitMs, 80);
  assert.equal(report.durationMs, 160);
  for (const row of records(outputs[1])) {
    assert.equal(row.pacing_wait_ms, '80'); assert.equal(row.interval_ms, '100');
    assert.equal(row.duration_ms, '160'); assert.equal(row.concurrency, '1');
    assert.equal(row.warmup_duration_ms, '10'); assert.equal(row.warmup_attempts, '1');
    assert.equal(row.latency_median_ms, '10'); assert.equal(row.latency_sample_count, '2');
    assert.equal(row.strict_passed, 'true'); assert.equal(row.strict_violations, '[]');
  }
});

test('format conflicts and invalid CSV flags fail before config reads or RPC; help/version still work', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; assert.fail('unexpected RPC'); });
  for (const flags of [['--csv', '--json'], ['--json', '--csv']]) {
    for (const extra of [[], ['--help'], ['--version']]) {
      const result = await run([...flags, '--config', '/missing/SYNTHETIC_SECRET', ...extra]);
      assert.equal(result.code, 2);
      assert.equal(result.out, '');
      assert.equal(result.err, 'RPC Doctor: Use either --csv or --json, not both.\n');
    }
  }
  for (const flag of ['--csv=true', '--csv=false', '--csv=SYNTHETIC_SECRET', '--no-csv']) {
    const result = await run([flag, 'http://127.0.0.1/SYNTHETIC_SECRET']);
    assert.equal(result.code, 2); assert.equal(result.out, '');
    assert.equal(result.err, 'RPC Doctor: Invalid arguments. Use --help for available options.\n');
  }
  const help = await run(['--csv', '--help', '--config', '/missing/SYNTHETIC_SECRET']);
  assert.equal(help.code, 0); assert.match(help.out, /--csv/); assert.equal(help.err, '');
  const version = await run(['--csv', '--version', '--config', '/missing/SYNTHETIC_SECRET']);
  assert.equal(version.code, 0); assert.equal(version.out, '0.1.0\n');
  const missing = await run(['--csv']);
  assert.equal(missing.code, 2); assert.equal(missing.out, '');
  for (const args of [['--samples', '0'], ['--max-failures', '0'], ['--label', 'https://SYNTHETIC_SECRET.invalid'], ['--config', '/missing/SYNTHETIC_SECRET']]) {
    const result = await run(['--csv', ...args, 'http://127.0.0.1/SYNTHETIC_SECRET']);
    assert.equal(result.code, 2); assert.equal(result.out, '');
    assert.doesNotMatch(result.err, /SYNTHETIC_SECRET/);
  }
  assert.equal(calls, 0);
});

test('CSV runtime errors remain sanitized exit 2 without a fabricated header', async (t) => {
  t.mock.method(performance, 'now', () => { throw new Error('SYNTHETIC_SECRET'); });
  const result = await run(['--csv', 'http://127.0.0.1']);
  assert.equal(result.code, 2); assert.equal(result.out, '');
  assert.equal(result.err, 'RPC Doctor: Unable to complete the check.\n');
});

test('demo CSV emits only complete records for default and strict outcomes', () => {
  for (const strict of [[], ['--strict']]) {
    const result = spawnSync(process.execPath, ['bin/rpc-doctor.js', '--demo', '--csv', '--samples', '3', ...strict], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, strict.length ? 1 : 0, result.stderr);
    assert.equal(result.stderr, '');
    const rows = records(result.stdout);
    assert.deepEqual(rows.map(r => r.endpoint), ['RPC 1', 'RPC 2', 'RPC 3']);
    assert.deepEqual(rows.map(r => r.successes), ['3', '3', '2']);
    assert.equal(rows[2].sample_errors, '{"RATE_LIMITED":1}');
    assert.equal(rows[0].demo, 'true');
    assert.equal(rows[0].strict_passed, strict.length ? 'false' : '');
    assert.doesNotMatch(result.stdout, /RPC Doctor|Errors:|Strict policy:|http:/);
  }
});

test('CSV mode preserves SIGINT exit 130', { timeout: 10000 }, async (t) => {
  let started;
  const requested = new Promise(resolve => { started = resolve; });
  const server = await serve(() => started());
  t.after(server.close);
  const child = spawn(process.execPath, ['bin/rpc-doctor.js', '--csv', server.url], { timeout: 10000 });
  t.after(() => child.kill());
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal }));
  });
  await requested;
  child.kill('SIGINT');
  assert.deepEqual(await closed, { code: 130, signal: null });
});
