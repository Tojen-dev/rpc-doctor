import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../src/config.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rpc-doctor-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'SYNTHETIC_SECRET.json') };
}

test('loads named URLs and entire-URL environment references with safe labels and settings', async (t) => {
  const { path } = await fixture(t);
  await writeFile(path, JSON.stringify({
    endpoints: [
      { label: '  Primary\n\x1b\u202e node ', urlEnv: 'PRIMARY_RPC_URL' },
      { label: 'Резервний вузол', url: 'http://127.0.0.1:8545' },
    ], samples: 100, timeout: 60000,
  }));
  const result = await loadConfig(path, { PRIMARY_RPC_URL: 'https://rpc.example/SYNTHETIC_SECRET' });
  assert.deepEqual(result, {
    endpoints: ['https://rpc.example/SYNTHETIC_SECRET', 'http://127.0.0.1:8545/'],
    labels: ['Primary node', 'Резервний вузол'], samples: 100, timeoutMs: 60000,
  });
  await writeFile(path, '{}');
  assert.deepEqual(await loadConfig(path, {}), {});
  await writeFile(path, '{"samples":1,"timeout":1}');
  assert.deepEqual(await loadConfig(path, {}), { samples: 1, timeoutMs: 1 });
});

test('rejects invalid structures, types, unknown fields, URLs and labels with static errors', async (t) => {
  const { path } = await fixture(t);
  const endpoint = { label: 'Primary', url: 'https://rpc.example' };
  const configs = [
    null, [], 1, true, 'SYNTHETIC_SECRET',
    { SYNTHETIC_SECRET: true }, { timeoutMs: 200 }, { labels: ['Primary'] },
    ...[null, '1', false, 0, -1, 1.5, 101].map((samples) => ({ samples })),
    ...[null, '100', false, 0, -1, 1.5, 60001].map((timeout) => ({ timeout })),
    ...[null, {}, [], 'SYNTHETIC_SECRET'].map((endpoints) => ({ endpoints })),
    { endpoints: Array.from({ length: 21 }, (_, i) => ({ label: `Node ${i}`, url: `https://rpc.example/${i}` })) },
    ...[null, [], 'SYNTHETIC_SECRET', {}, { url: endpoint.url }, { label: 'Primary' },
      { ...endpoint, urlEnv: 'PRIMARY_RPC_URL' }, { ...endpoint, SYNTHETIC_SECRET: true },
      ...[null, 1, false, {}].map((url) => ({ ...endpoint, url })),
      ...[null, 1, '', '\n\u202e', 'x'.repeat(65), 'https://rpc.example/SYNTHETIC_SECRET']
        .map((label) => ({ ...endpoint, label })),
      ...['file:///SYNTHETIC_SECRET', 'https://user:SYNTHETIC_SECRET@rpc.example',
        'https://rpc.example/#SYNTHETIC_SECRET', 'SYNTHETIC_SECRET', '']
        .map((url) => ({ ...endpoint, url })),
      ...[null, 1, '', '${SYNTHETIC_SECRET}', 'SYNTHETIC_SECRET\n', '1INVALID']
        .map((urlEnv) => ({ label: 'Primary', urlEnv })),
    ].map((entry) => ({ endpoints: [entry] })),
    { endpoints: [endpoint, { label: 'Duplicate', url: `${endpoint.url}/` }] },
  ];
  for (const config of configs) {
    await writeFile(path, JSON.stringify(config));
    await assert.rejects(loadConfig(path, {}), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.message.includes('SYNTHETIC_SECRET'), false);
      assert.equal(error.message.includes(path), false);
      assert.doesNotMatch(error.message, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      return true;
    });
  }
  await writeFile(path, '{"__proto__":{"SYNTHETIC_SECRET":true}}');
  await assert.rejects(loadConfig(path, {}), ConfigError);
  assert.equal(Object.prototype.SYNTHETIC_SECRET, undefined);
});

test('environment references must exist as own non-empty string values and resolve to valid URLs', async (t) => {
  const { path } = await fixture(t);
  await writeFile(path, JSON.stringify({ endpoints: [{ label: 'Private node', urlEnv: 'SYNTHETIC_SECRET_ENV' }] }));
  for (const env of [{}, { SYNTHETIC_SECRET_ENV: '' }, { SYNTHETIC_SECRET_ENV: '  ' },
    { SYNTHETIC_SECRET_ENV: null }, { SYNTHETIC_SECRET_ENV: 123 },
    Object.create({ SYNTHETIC_SECRET_ENV: 'https://rpc.example' }),
    { SYNTHETIC_SECRET_ENV: 'https://user:SYNTHETIC_SECRET@rpc.example' },
  ]) {
    await assert.rejects(loadConfig(path, env), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.message.includes('SYNTHETIC_SECRET'), false);
      return true;
    });
  }
});

test('enforces the byte limit, strict UTF-8 JSON, and regular files with redacted read errors', async (t) => {
  const { directory, path } = await fixture(t);
  for (const contents of [
    '{"SYNTHETIC_SECRET":', '', '// SYNTHETIC_SECRET\n{}',
    '{"samples":1,}', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
    '{}'.padEnd(64 * 1024 + 1), JSON.stringify({ label: '🛰'.repeat(20000) }),
  ]) {
    await writeFile(path, contents);
    await assert.rejects(loadConfig(path, {}), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.message.includes('SYNTHETIC_SECRET'), false);
      assert.equal(error.message.includes(directory), false);
      return true;
    });
  }
  await writeFile(path, '{}'.padEnd(64 * 1024));
  assert.deepEqual(await loadConfig(path, {}), {});
  for (const invalidPath of [directory, join(directory, 'MISSING_SYNTHETIC_SECRET.json')]) {
    await assert.rejects(loadConfig(invalidPath, {}), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.message.includes(directory), false);
      assert.equal(error.message.includes('SYNTHETIC_SECRET'), false);
      return true;
    });
  }
});

test('accepts twenty endpoints and validates the shipped secret-free example without requests', async (t) => {
  const { path } = await fixture(t);
  await writeFile(path, JSON.stringify({ endpoints: Array.from({ length: 20 }, (_, i) => ({
    label: `Node ${i + 1}`, url: `https://rpc.example/${i}`,
  })) }));
  const result = await loadConfig(path, {});
  assert.equal(result.endpoints.length, 20);
  assert.equal(result.labels[19], 'Node 20');
  const examplePath = new URL('../examples/rpc-doctor.json', import.meta.url);
  const example = await loadConfig(examplePath, { PRIMARY_RPC_URL: 'https://rpc.example' });
  assert.deepEqual(example.labels, ['Primary node', 'Local node']);
  assert.equal(example.samples, 10);
  assert.equal(example.timeoutMs, 3000);
  assert.match(await readFile(examplePath, 'utf8'), /"urlEnv": "PRIMARY_RPC_URL"/);
});
