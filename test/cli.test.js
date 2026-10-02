import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { main } from '../src/cli.js';
import { serve, reply } from './helpers.js';

async function run(args, env = {}) {
  let out = '';
  let err = '';
  const code = await main(args, env, { write: (s) => { out += s; } }, { write: (s) => { err += s; } });
  return { code, out, err };
}

test('help and version do not need network access', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /--label <name>/);
  assert.match(help.out, /--concurrency <n>/);
  assert.match(help.out, /--lag-threshold <n>/);
  assert.match(help.out, /--reference <n>/);
  assert.equal((await run(['--version'])).out, '0.1.0\n');
  assert.equal((await run([])).code, 2);
});

test('rejects invalid input without exposing endpoint credentials', async () => {
  for (const args of [['--SECRET'], ['--samples', '1.5'], ['--samples', '0', 'https://example.com'],
    ['https://user:SECRET@example.com'], ['--demo', 'https://example.com/SECRET']]) {
    const result = await run(args);
    assert.equal(result.code, 2);
    assert.equal((result.out + result.err).includes('SECRET'), false);
  }
  assert.equal((await run([], { RPC_DOCTOR_ENDPOINTS_JSON: 'SECRET' })).code, 2);
  assert.equal((await run([], { RPC_DOCTOR_ENDPOINTS_JSON: '{}' })).code, 2);
});

test('accepts environment input and emits machine-readable JSON only', async (t) => {
  const server = await serve((req, res) => reply(res, req.method === 'eth_chainId' ? '0x2105' : '0x10'));
  t.after(server.close);
  const result = await run(['--json', '--samples', '2'], { RPC_DOCTOR_ENDPOINTS_JSON: JSON.stringify([server.url]) });
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  assert.equal(JSON.parse(result.out).results[0].chainId, '8453');
  assert.equal(JSON.parse(result.out).results[0].endpoint, 'RPC 1');
});

test('returns a nonzero exit code when all endpoints fail', async (t) => {
  const server = await serve((req, res) => res.writeHead(503).end());
  t.after(server.close);
  const result = await run(['--json', server.url]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.out).results[0].status, 'unreachable');
});

test('demo CLI exits, shows peer lag, and labels its synthetic data', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/rpc-doctor.js', '--demo', '--json', '--samples', '3'], { timeout: 10000 });
    let out = '';
    let err = '';
    child.stdout.on('data', (data) => { out += data; });
    child.stderr.on('data', (data) => { err += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
  assert.equal(result.code, 0, result.err);
  const report = JSON.parse(result.out);
  assert.equal(report.demo, true);
  assert.equal(report.results[1].lagBlocks, '6');
  assert.equal(report.results[2].errors.RATE_LIMITED, 1);
  assert.deepEqual(report.results.map((r) => r.endpoint), ['RPC 1', 'RPC 2', 'RPC 3']);
});

test('table output reports partial failures without claiming overall failure', async () => {
  const result = await run(['--demo', '--samples', '3']);
  assert.equal(result.code, 0);
  assert.match(result.out, /synthetic endpoints/);
  assert.match(result.out, /RATE_LIMITED/);
  assert.match(result.out, /Median/);
  assert.match(result.out, /^RPC 1\s/m);
  assert.match(result.out, /^RPC 2\s/m);
  assert.match(result.out, /^RPC 3\s/m);
});

test('labels preserve positional URL order when probes complete out of order in table and JSON', async (t) => {
  let firstGate;
  let releaseFirst;
  let completed;
  const first = await serve(async (req, res) => {
    if (req.method === 'eth_chainId') await firstGate;
    else completed.push('first');
    reply(res, req.method === 'eth_chainId' ? '0x1' : '0x10');
  });
  t.after(first.close);
  const second = await serve((req, res) => {
    if (req.method === 'eth_blockNumber') {
      completed.push('second');
      releaseFirst();
    }
    reply(res, req.method === 'eth_chainId' ? '0x1' : '0x20');
  });
  t.after(second.close);
  for (const format of [[], ['--json']]) {
    firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    completed = [];
    const result = await run([
      ...format, '--samples', '1', '--label', 'Primary node', first.url,
      '--label', 'Резервний вузол', second.url,
    ], { RPC_DOCTOR_ENDPOINTS_JSON: 'ignored invalid environment input' });
    assert.equal(result.code, 0, result.err);
    assert.equal(result.err, '');
    assert.deepEqual(completed, ['second', 'first']);
    if (format.length) {
      assert.deepEqual(JSON.parse(result.out).results.map((r) => [r.endpoint, r.latestBlock]),
        [['Primary node', '16'], ['Резервний вузол', '32']]);
    } else {
      assert.match(result.out, /^Primary node\s+1\s+degraded\s+1\/1.*\s16\s+16$/m);
      assert.match(result.out, /^Резервний вузол\s+1\s+healthy\s+1\/1.*\s32\s+0$/m);
      assert.ok(result.out.indexOf('Primary node') < result.out.indexOf('Резервний вузол'));
    }
    assert.equal((result.out + result.err).includes(first.url), false);
    assert.equal((result.out + result.err).includes(second.url), false);
  }
});

test('environment URLs use sanitized labels in both reports and error rows without exposing secrets', async (t) => {
  const server = await serve((req, res) => res.writeHead(503).end('SYNTHETIC_SECRET'));
  t.after(server.close);
  const endpoint = `${server.url}/SYNTHETIC_SECRET?key=SYNTHETIC_SECRET`;
  const label = '  Backup\n\t\r\x00\x1b\x7f\x85\u202e\u2066\u2028\u2029 node  ';
  for (const format of [[], ['--json']]) {
    const result = await run([...format, '--label', label], {
      RPC_DOCTOR_ENDPOINTS_JSON: JSON.stringify([endpoint]),
    });
    assert.equal(result.code, 1);
    assert.equal(result.err, '');
    assert.equal(result.out.includes('SYNTHETIC_SECRET'), false);
    assert.equal(result.out.includes(server.url), false);
    // Reports contain ordinary formatting newlines, but never injected controls.
    assert.doesNotMatch(result.out.replace(/\n/g, ''), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    if (format.length) {
      const row = JSON.parse(result.out).results[0];
      assert.equal(row.endpoint, 'Backup node');
      assert.equal(row.status, 'unreachable');
      assert.deepEqual(row.errors, { HTTP_ERROR: 1 });
    } else {
      assert.match(result.out, /^Backup node\s+—\s+unreachable/m);
      assert.match(result.out, /^  Backup node: HTTP_ERROR × 1$/m);
    }
  }
});

test('invalid label counts and values fail before requests without echoing user input', async (t) => {
  let requests = 0;
  const server = await serve((req, res) => { requests++; reply(res, '0x1'); });
  t.after(server.close);
  const endpoint = `${server.url}/SYNTHETIC_SECRET?key=SYNTHETIC_SECRET`;
  const cases = [
    ['--label'],
    ['--label', 'Only one', endpoint, `${server.url}/second`],
    ['--label', 'First', '--label', 'Extra', endpoint],
    ['--label', '', endpoint],
    ['--label', ' \n\x00\u202e ', endpoint],
    ['--label', `SYNTHETIC_SECRET${'x'.repeat(64)}`, endpoint],
    ['--label', endpoint, endpoint],
    ['--label', endpoint.replace('://', ':'), endpoint],
    ['--label', endpoint.replace('://', ':\\\\'), endpoint],
    ['--label', `Provider ${endpoint}`, endpoint],
    ['--label', 'https:\t//example.invalid/SYNTHETIC_SECRET', endpoint],
    ['--label', 'www.example.invalid/SYNTHETIC_SECRET', endpoint],
  ];
  for (const args of cases) {
    const result = await run(args);
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.match(result.err, /^RPC Doctor: (Invalid arguments\.|Provide |Labels )/);
    assert.equal(result.err.includes('SYNTHETIC_SECRET'), false);
    assert.equal(result.err.includes(server.url), false);
    assert.doesNotMatch(result.err.trimEnd(), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  }
  const envResult = await run(['--label', 'Only one'], {
    RPC_DOCTOR_ENDPOINTS_JSON: JSON.stringify([endpoint, `${server.url}/second`]),
  });
  assert.equal(envResult.code, 2);
  assert.match(envResult.err, /exactly one --label per endpoint/);
  assert.equal(requests, 0);
});

test('demo accepts three explicit labels in table and JSON', async () => {
  for (const format of [[], ['--json']]) {
    const result = await run(['--demo', '--samples', '1', ...format,
      '--label', 'Fast', '--label', 'Behind', '--label', 'Limited']);
    assert.equal(result.code, 0, result.err);
    if (format.length) {
      assert.deepEqual(JSON.parse(result.out).results.map((r) => r.endpoint), ['Fast', 'Behind', 'Limited']);
    } else {
      assert.match(result.out, /^Fast\s/m);
      assert.match(result.out, /^Behind\s/m);
      assert.match(result.out, /^Limited\s/m);
    }
  }
  assert.equal((await run(['--demo', '--label', 'Only one'])).code, 2);
});

test('CLI rejects malformed or out-of-range concurrency without requests or input disclosure', async (t) => {
  let requests = 0;
  const server = await serve((req, res) => { requests++; reply(res, '0x1'); });
  t.after(server.close);
  for (const value of ['', '0', '-1', '21', '1.5', '1e1', '0x2', ' 2', '2\n', 'NaN', 'Infinity', 'SYNTHETIC_SECRET\x1b']) {
    const result = await run(['--concurrency', value, `${server.url}/SYNTHETIC_SECRET`]);
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.match(result.err, /^RPC Doctor: (Concurrency |Invalid arguments\.)/);
    assert.equal(result.err.includes('SYNTHETIC_SECRET'), false);
    assert.equal(result.err.includes(server.url), false);
    assert.doesNotMatch(result.err.trimEnd(), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  }
  assert.equal((await run(['--concurrency'])).code, 2);
  assert.equal(requests, 0);
});

test('demo supports concurrency in table and JSON while preserving failures and exit codes', async () => {
  const table = await run(['--demo', '--samples', '3', '--concurrency', '1']);
  assert.equal(table.code, 0, table.err);
  assert.match(table.out, /Concurrency: 1/);
  assert.match(table.out, /RATE_LIMITED/);
  const json = await run(['--demo', '--samples', '3', '--concurrency', '20', '--json']);
  assert.equal(json.code, 0, json.err);
  const report = JSON.parse(json.out);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.settings.concurrency, 3);
  assert.deepEqual(report.results.map((r) => r.endpoint), ['RPC 1', 'RPC 2', 'RPC 3']);
  assert.deepEqual(report.results[2].errors, { RATE_LIMITED: 1 });
});

test('CLI rejects invalid lag policies before RPC without disclosing values', async (t) => {
  let requests = 0;
  const server = await serve((req, res) => { requests++; reply(res, '0x1'); });
  t.after(server.close);
  for (const option of ['--lag-threshold', '--reference']) {
    for (const value of ['', '-1', '1.5', '1e1', '0x2', ' 2', '2\n', 'NaN', 'Infinity', '9007199254740992', 'SYNTHETIC_SECRET\x1b']) {
      const result = await run([option, value, `${server.url}/SYNTHETIC_SECRET`]);
      assert.equal(result.code, 2);
      assert.equal(result.out, '');
      assert.match(result.err, /^RPC Doctor: (Lag threshold |Reference |Invalid arguments\.)/);
      assert.equal(result.err.includes('SYNTHETIC_SECRET'), false);
      assert.equal(result.err.includes(server.url), false);
      assert.doesNotMatch(result.err.trimEnd(), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    }
    assert.equal((await run([option])).code, 2);
  }
  for (const value of ['0', '2', '21']) assert.equal((await run(['--reference', value, server.url])).code, 2);
  assert.equal(requests, 0);
});

test('demo applies lag threshold and reference policy in table/JSON', async () => {
  const peer = await run(['--demo', '--samples', '1', '--lag-threshold', '6', '--json']);
  assert.equal(peer.code, 0, peer.err);
  const report = JSON.parse(peer.out);
  assert.equal(report.settings.lagThreshold, 6);
  assert.equal(Object.hasOwn(report.settings, 'reference'), false);
  assert.equal(report.results[1].status, 'healthy');
  assert.ok(report.results.every((r) => !Object.hasOwn(r, 'lagStatus')));
  const table = await run(['--demo', '--samples', '1', '--reference', '2', '--lag-threshold', '0']);
  assert.equal(table.code, 0, table.err);
  assert.match(table.out, /Lag threshold: 0 blocks/);
  assert.match(table.out, /Reference: endpoint 2 \(RPC 2\)/);
  assert.match(table.out, /^RPC 1\s+1\s+healthy.*\s0\s+ahead of reference$/m);
  assert.match(table.out, /^RPC 2\s+1\s+healthy.*\s—\s+reference \(unverified\)$/m);
  const reference = await run(['--demo', '--samples', '1', '--reference', '1', '--lag-threshold', '0', '--json']);
  assert.equal(reference.code, 0, reference.err);
  const selected = JSON.parse(reference.out);
  assert.equal(selected.settings.reference, 1);
  assert.equal(selected.results[1].lagBlocks, '6');
  assert.equal(selected.results[1].status, 'degraded');
});

test('unavailable reference leaves successful results usable with explicit table/JSON reasons', async (t) => {
  const failed = await serve((req, res) => res.writeHead(503).end('SYNTHETIC_SECRET'));
  t.after(failed.close);
  const good = await serve((req, res) => reply(res, '0x1'));
  t.after(good.close);
  for (const format of [[], ['--json']]) {
    const result = await run(['--reference', '1', '--samples', '1', ...format,
      '--label', 'Reference node', '--label', 'Successful node', `${failed.url}/SYNTHETIC_SECRET`, good.url]);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.err, '');
    assert.equal(result.out.includes('SYNTHETIC_SECRET'), false);
    assert.equal(result.out.includes(failed.url), false);
    assert.equal(result.out.includes(good.url), false);
    if (format.length) {
      const [, row] = JSON.parse(result.out).results;
      assert.equal(row.endpoint, 'Successful node');
      assert.equal(row.status, 'degraded');
      assert.equal(row.lagBlocks, null);
      assert.equal(row.lagStatus, 'reference_unavailable');
      assert.equal(row.successes, 1);
    } else {
      assert.match(result.out, /^Successful node\s+1\s+degraded\s+1\/1.*reference unavailable$/m);
      assert.match(result.out, /No fallback/);
    }
  }
  assert.equal((await run(['--reference', '1', failed.url])).code, 1);
});
