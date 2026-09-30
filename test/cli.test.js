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
  assert.equal((await run(['--help'])).code, 0);
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
});

test('table output reports partial failures without claiming overall failure', async () => {
  const result = await run(['--demo', '--samples', '3']);
  assert.equal(result.code, 0);
  assert.match(result.out, /synthetic endpoints/);
  assert.match(result.out, /RATE_LIMITED/);
  assert.match(result.out, /Median/);
});
