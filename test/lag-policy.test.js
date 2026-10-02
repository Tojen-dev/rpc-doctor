import test from 'node:test';
import assert from 'node:assert/strict';
import { addPeerComparison, benchmark } from '../src/benchmark.js';
import { serve, reply } from './helpers.js';

const HEIGHT = 10n ** 30n;
const row = (height, chainId = '1') => ({ chainId, latestBlock: height.toString(), status: 'healthy' });

async function fakeEndpoints(t, definitions) {
  return Promise.all(definitions.map(async ({ chain = 1n, blocks }) => {
    let sample = 0;
    const server = await serve((req, res) => {
      const value = req.method === 'eth_chainId' ? chain : blocks[sample++];
      if (value === null) res.writeHead(503).end('SYNTHETIC_SECRET');
      else reply(res, typeof value === 'bigint' ? `0x${value.toString(16)}` : value);
    });
    t.after(server.close);
    return `${server.url}/SYNTHETIC_SECRET`;
  }));
}

test('peer maximum respects zero, exact threshold, and exact large block differences', () => {
  const zero = addPeerComparison([row(HEIGHT), row(HEIGHT), row(HEIGHT - 1n)], { lagThreshold: 0 });
  assert.deepEqual(zero.map((r) => [r.lagBlocks, r.status]), [['0', 'healthy'], ['0', 'healthy'], ['1', 'degraded']]);
  const boundary = addPeerComparison([row(HEIGHT), row(HEIGHT - 3n), row(HEIGHT - 4n)], { lagThreshold: 3 });
  assert.deepEqual(boundary.map((r) => [r.lagBlocks, r.status]), [['0', 'healthy'], ['3', 'healthy'], ['4', 'degraded']]);
  const large = addPeerComparison([row(HEIGHT), row(HEIGHT - 9007199254740991n), row(HEIGHT - 9007199254740992n)],
    { lagThreshold: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(large.map((r) => [r.lagBlocks, r.status]),
    [['0', 'healthy'], ['9007199254740991', 'healthy'], ['9007199254740992', 'degraded']]);
  assert.ok(large.every((r) => !Object.hasOwn(r, 'lagStatus')));
});

test('reference follows input index, does not use the maximum, and leaves itself unverified', () => {
  const results = addPeerComparison([row(HEIGHT + 100n), row(HEIGHT - 1n), row(HEIGHT)], { reference: 3, lagThreshold: 1 });
  assert.deepEqual(results.map((r) => [r.lagBlocks, r.lagStatus, r.status, r.peerCount]), [
    ['0', 'ahead', 'healthy', 2], ['1', 'compared', 'healthy', 2], [null, 'reference', 'healthy', 2],
  ]);
  for (const options of [{}, { reference: 1 }]) {
    const [single] = addPeerComparison([row(HEIGHT)], options);
    assert.equal(single.lagBlocks, null);
    assert.equal(single.peerCount, 0);
    assert.equal(single.status, 'healthy');
    assert.equal(single.lagStatus, options.reference ? 'reference' : undefined);
  }
});

test('reference never compares other chains, even when they have their own peers', () => {
  const results = addPeerComparison([row(HEIGHT), row(HEIGHT + 100n, '2'), row(HEIGHT - 100n, '2')], { reference: 1 });
  assert.deepEqual(results.map((r) => [r.lagBlocks, r.lagStatus, r.status, r.peerCount]), [
    [null, 'reference', 'healthy', 0], [null, 'different_chain', 'degraded', 1], [null, 'different_chain', 'degraded', 1],
  ]);
});

test('loopback probes preserve partial failures, labels, and exact reference comparisons', async (t) => {
  const urls = await fakeEndpoints(t, [
    { blocks: [null, HEIGHT] }, { blocks: [HEIGHT - 3n, HEIGHT - 3n] },
    { blocks: [HEIGHT - 4n, HEIGHT - 4n] }, { blocks: [HEIGHT + 1n, HEIGHT + 2n] },
    { chain: 2n, blocks: [HEIGHT, HEIGHT] }, { blocks: [null, HEIGHT] },
  ]);
  const labels = ['Partial ref', 'Boundary', 'Behind', 'Ahead', 'Other chain', 'Partial peer'];
  const report = await benchmark(urls, { samples: 2, reference: 1, lagThreshold: 3, labels });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.settings.reference, 1);
  assert.equal(report.settings.lagThreshold, 3);
  assert.deepEqual(report.results.map((r) => r.endpoint), labels);
  assert.deepEqual(report.results.map((r) => [r.lagBlocks, r.lagStatus, r.status, r.successes]), [
    [null, 'reference', 'degraded', 1], ['3', 'compared', 'healthy', 2],
    ['4', 'compared', 'degraded', 2], ['0', 'ahead', 'healthy', 2],
    [null, 'different_chain', 'degraded', 2], ['0', 'compared', 'degraded', 1],
  ]);
  assert.equal(report.results[3].latestBlock, (HEIGHT + 2n).toString());
  for (const index of [0, 5]) {
    assert.deepEqual(report.results[index].errors, { HTTP_ERROR: 1 });
    assert.equal(report.results[index].attempts, 2);
    assert.equal(report.results[index].successRate, 50);
    assert.notEqual(report.results[index].latencyMs.median, null);
  }
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_SECRET'), false);
});

for (const [name, definition, error, attempts] of [
  ['failed handshake', { chain: null, blocks: [] }, 'HTTP_ERROR', 0],
  ['failed block samples', { blocks: [null, null] }, 'HTTP_ERROR', 2],
  ['unusable block values', { blocks: ['invalid', 'invalid'] }, 'INVALID_RESULT', 2],
]) {
  test(`reference with ${name} preserves successful peers without fallback`, async (t) => {
    const urls = await fakeEndpoints(t, [definition, { blocks: [HEIGHT, HEIGHT] }, { blocks: [HEIGHT + 1n, HEIGHT + 1n] }]);
    const report = await benchmark(urls, { samples: 2, reference: 1 });
    const [reference, ...peers] = report.results;
    assert.equal(reference.status, 'unreachable');
    assert.equal(reference.lagStatus, 'no_data');
    assert.equal(reference.attempts, attempts);
    assert.deepEqual(reference.errors, { [error]: attempts || 1 });
    for (const peer of peers) {
      assert.equal(peer.lagBlocks, null);
      assert.equal(peer.lagStatus, 'reference_unavailable');
      assert.equal(peer.status, 'degraded');
      assert.equal(peer.attempts, 2);
      assert.equal(peer.successes, 2);
      assert.deepEqual(peer.errors, {});
      assert.notEqual(peer.latencyMs.median, null);
    }
  });
}

test('invalid lag policies fail before any RPC request', async (t) => {
  let requests = 0;
  const server = await serve((req, res) => { requests++; reply(res, '0x1'); });
  t.after(server.close);
  for (const lagThreshold of [null, false, '3', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, [], {}]) {
    await assert.rejects(benchmark([server.url], { lagThreshold }), /Lag threshold must be an integer/);
  }
  for (const reference of [null, false, '1', 0, -1, 1.5, 2, 21, Infinity, NaN, [], {}]) {
    await assert.rejects(benchmark([server.url], { reference }), /Reference must be an endpoint index/);
  }
  assert.equal(requests, 0);
});
