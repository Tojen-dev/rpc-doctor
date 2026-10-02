import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExpectedChain } from '../src/network.js';
import { benchmark } from '../src/benchmark.js';
import { serve, reply } from './helpers.js';

const LARGE_ID = 9007199254740993n;
const MAX_ID = (1n << 256n) - 1n;

async function fakeNetworks(t, definitions) {
  const calls = definitions.map(() => []);
  const urls = await Promise.all(definitions.map(async ({ chain, blocks = [16n, 17n] }, index) => {
    let sample = 0;
    const server = await serve((req, res) => {
      calls[index].push(req.method);
      const value = req.method === 'eth_chainId' ? chain : blocks[sample++];
      if (value === null) res.writeHead(503).end('SYNTHETIC_SECRET');
      else reply(res, typeof value === 'bigint' ? `0x${value.toString(16)}` : value);
    });
    t.after(server.close);
    return `${server.url}/SYNTHETIC_SECRET`;
  }));
  return { urls, calls };
}

test('expected IDs parse decimal/hex exactly through the uint256 boundary', () => {
  for (const [text, expected] of [
    ['0', 0n], ['0x0', 0n], ['1', 1n], ['0xAb', 171n],
    [LARGE_ID.toString(), LARGE_ID], ['0x20000000000001', LARGE_ID],
    [MAX_ID.toString(), MAX_ID], [`0x${'f'.repeat(64)}`, MAX_ID],
  ]) assert.equal(parseExpectedChain(text), expected);
  assert.notEqual(parseExpectedChain('9007199254740992'), parseExpectedChain('9007199254740993'));
});

test('invalid expected IDs are bounded, string-only, and rejected without RPC or reflected input', async (t) => {
  let requests = 0;
  const server = await serve((req, res) => { requests++; reply(res, '0x1'); });
  t.after(server.close);
  for (const expectedChain of [
    null, true, false, 0, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1n, [], {},
    '', ' 1', '1\n', '01', '0x01', '0x00', '0X1', '+1', '-1', '1.0', '1e2', '0x', '0xg',
    (MAX_ID + 1n).toString(), `0x1${'0'.repeat(64)}`, '9'.repeat(1000), 'SYNTHETIC_SECRET\x1b',
  ]) {
    await assert.rejects(benchmark([server.url], { expectedChain }), (error) => {
      assert.match(error.message, /^Expected chain must be/);
      assert.equal(error.message.includes('SYNTHETIC_SECRET'), false);
      assert.equal(error.message.includes(server.url), false);
      return true;
    });
  }
  assert.equal(requests, 0);
});

for (const [expectedChain, concurrency] of [[LARGE_ID.toString(), 1], ['0x20000000000001', 3]]) {
  test(`guard distinguishes adjacent large IDs and handshake failures with concurrency ${concurrency}`, async (t) => {
    const { urls, calls } = await fakeNetworks(t, [
      { chain: LARGE_ID - 1n }, { chain: LARGE_ID, blocks: [2n ** 80n, 2n ** 80n + 1n] },
      { chain: null }, { chain: 'invalid' },
    ]);
    const labels = ['Wrong network', 'Accepted node', 'Offline node', 'Invalid node'];
    const report = await benchmark(urls, { expectedChain, concurrency, samples: 2, labels });
    assert.equal(report.settings.expectedChain, LARGE_ID.toString());
    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(report.results.map((r) => r.endpoint), labels);
    assert.deepEqual(report.results.map((r) => [r.chainId, r.networkStatus, r.status]), [
      [(LARGE_ID - 1n).toString(), 'mismatch', 'mismatch'], [LARGE_ID.toString(), 'match', 'healthy'],
      [null, 'unknown', 'unreachable'], [null, 'unknown', 'unreachable'],
    ]);
    assert.deepEqual(calls, [['eth_chainId'], ['eth_chainId', 'eth_blockNumber', 'eth_blockNumber'], ['eth_chainId'], ['eth_chainId']]);
    const [mismatch, accepted, offline, invalid] = report.results;
    assert.equal(mismatch.attempts, 0);
    assert.equal(mismatch.successes, 0);
    assert.equal(mismatch.latestBlock, null);
    assert.equal(mismatch.lagBlocks, null);
    assert.equal(mismatch.peerCount, 0);
    assert.deepEqual(mismatch.latencyMs, { min: null, median: null, p95: null, max: null });
    assert.deepEqual(mismatch.errors, {});
    assert.equal(accepted.latestBlock, (2n ** 80n + 1n).toString());
    assert.equal(accepted.peerCount, 0);
    assert.equal(accepted.lagBlocks, null);
    assert.deepEqual(offline.errors, { HTTP_ERROR: 1 });
    assert.deepEqual(invalid.errors, { INVALID_RESULT: 1 });
    assert.equal(JSON.stringify(report).includes('SYNTHETIC_SECRET'), false);
  });
}

test('zero and maximum uint256 expected IDs survive the full loopback comparison', async (t) => {
  for (const id of [0n, MAX_ID]) {
    const { urls, calls } = await fakeNetworks(t, [{ chain: id }]);
    const report = await benchmark(urls, { expectedChain: `0x${id.toString(16)}`, samples: 1 });
    assert.equal(report.settings.expectedChain, id.toString());
    assert.equal(report.results[0].networkStatus, 'match');
    assert.equal(report.results[0].status, 'healthy');
    assert.deepEqual(calls, [['eth_chainId', 'eth_blockNumber']]);
  }
});

for (const [chain, lagStatus, status] of [[2n, 'reference_mismatch', 'mismatch'], [null, 'reference_unavailable', 'unreachable']]) {
  test(`${status} reference has no fallback and preserves matching peers`, async (t) => {
    const { urls, calls } = await fakeNetworks(t, [
      { chain }, { chain: 1n, blocks: [10n, 10n] }, { chain: 1n, blocks: [20n, 20n] },
    ]);
    const report = await benchmark(urls, { expectedChain: '1', reference: 1, samples: 2 });
    assert.equal(report.results[0].status, status);
    assert.deepEqual(calls[0], ['eth_chainId']);
    for (const peer of report.results.slice(1)) {
      assert.equal(peer.networkStatus, 'match');
      assert.equal(peer.status, 'degraded');
      assert.equal(peer.lagStatus, lagStatus);
      assert.equal(peer.lagBlocks, null);
      assert.equal(peer.peerCount, 1);
      assert.equal(peer.successes, 2);
      assert.deepEqual(peer.errors, {});
    }
  });
}

test('matching reference and partial samples keep ordinary lag policy while rejecting other networks', async (t) => {
  const { urls, calls } = await fakeNetworks(t, [
    { chain: 2n }, { chain: 1n, blocks: [20n, 20n] }, { chain: 1n, blocks: [null, 17n] },
    { chain: 1n, blocks: [null, null] },
  ]);
  const report = await benchmark(urls, { expectedChain: '0x1', reference: 2, samples: 2 });
  assert.deepEqual(report.results.map((r) => [r.networkStatus, r.lagStatus, r.lagBlocks, r.status]), [
    ['mismatch', 'network_mismatch', null, 'mismatch'], ['match', 'reference', null, 'healthy'],
    ['match', 'compared', '3', 'degraded'], ['match', 'no_data', null, 'unreachable'],
  ]);
  assert.equal(report.results[1].peerCount, 1);
  assert.equal(report.results[2].successes, 1);
  assert.deepEqual(report.results[2].errors, { HTTP_ERROR: 1 });
  assert.deepEqual(calls[0], ['eth_chainId']);
});

test('without the guard mixed networks are sampled and no network fields are added', async (t) => {
  const { urls, calls } = await fakeNetworks(t, [{ chain: LARGE_ID }, { chain: 1n }]);
  const report = await benchmark(urls, { samples: 1 });
  assert.equal(Object.hasOwn(report.settings, 'expectedChain'), false);
  assert.ok(report.results.every((r) => !Object.hasOwn(r, 'networkStatus') && r.status === 'healthy'));
  assert.deepEqual(report.results.map((r) => [r.peerCount, r.lagBlocks]), [[0, null], [0, null]]);
  assert.deepEqual(calls, [['eth_chainId', 'eth_blockNumber'], ['eth_chainId', 'eth_blockNumber']]);
});
