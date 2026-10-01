import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmark, latencyStats, addPeerComparison } from '../src/benchmark.js';
import { serve, reply } from './helpers.js';

test('calculates interpolated median and nearest-rank p95 from successes', () => {
  assert.deepEqual(latencyStats([4, 1, 3, 2]), { min: 1, median: 2.5, p95: 4, max: 4 });
  assert.deepEqual(latencyStats([]), { min: null, median: null, p95: null, max: null });
});

test('never compares heights across networks and keeps single-peer lag unknown', () => {
  const results = [
    { chainId: '1', latestBlock: '9007199254741000', status: 'healthy' },
    { chainId: '1', latestBlock: '9007199254740995', status: 'healthy' },
    { chainId: '8453', latestBlock: '9999999999999999', lagBlocks: null, status: 'healthy' },
  ];
  addPeerComparison(results);
  assert.equal(results[0].lagBlocks, '0');
  assert.equal(results[1].lagBlocks, '5');
  assert.equal(results[1].status, 'degraded');
  assert.equal(results[2].lagBlocks, null);
});

test('records partial failures separately and excludes secrets from reports', async (t) => {
  let count = 0;
  const server = await serve((req, res) => {
    if (req.method === 'eth_chainId') return reply(res, '0x1');
    if (count++ === 0) return res.writeHead(503).end('SECRET');
    reply(res, '0x10');
  });
  t.after(server.close);
  const report = await benchmark([`${server.url}/SECRET?key=SECRET`], { samples: 3 });
  const row = report.results[0];
  assert.equal(row.attempts, 3);
  assert.equal(row.successes, 2);
  assert.equal(row.successRate, 66.67);
  assert.equal(row.status, 'degraded');
  assert.equal(row.errors.HTTP_ERROR, 1);
  assert.equal(JSON.stringify(report).includes('SECRET'), false);
});

test('a chain handshake failure is reported without inventing samples', async (t) => {
  const server = await serve((req, res) => reply(res, 'garbage'));
  t.after(server.close);
  const { results } = await benchmark([server.url]);
  assert.equal(results[0].chainId, null);
  assert.equal(results[0].attempts, 0);
  assert.equal(results[0].status, 'unreachable');
  assert.equal(results[0].errors.INVALID_RESULT, 1);
});

test('validates configuration before any network request', async () => {
  await assert.rejects(benchmark([]), /between 1 and 20/);
  await assert.rejects(benchmark(['https://example.com'], { samples: 0 }), /Samples/);
  await assert.rejects(benchmark(['https://example.com'], { timeoutMs: Infinity }), /Timeout/);
  await assert.rejects(benchmark(['https://example.com', 'https://example.com/']), /Duplicate/);
});

test('validates label arrays and string values before any RPC request', async (t) => {
  let requests = 0;
  const server = await serve((req, res) => { requests++; reply(res, '0x1'); });
  t.after(server.close);
  for (const labels of [null, 'Primary', [], ['First', 'Extra'], [null], [1], [{}], [true], new Array(1)]) {
    await assert.rejects(benchmark([server.url], { labels }), /^(Error: )?(Provide |Labels )/);
  }
  assert.equal(requests, 0);
});

test('label length counts Unicode code points after normalization', async (t) => {
  const server = await serve((req, res) => reply(res, '0x1'));
  t.after(server.close);
  const name = '🛰'.repeat(64);
  const report = await benchmark([server.url], { samples: 1, labels: [`  ${name}\t `] });
  assert.equal(report.results[0].endpoint, name);
  await assert.rejects(benchmark([server.url], { labels: ['🛰'.repeat(65)] }), /Labels must contain/);
});
