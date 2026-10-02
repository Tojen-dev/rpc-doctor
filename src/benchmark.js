import { rpcCall, parseQuantity, validateEndpoint } from './rpc.js';
import { endpointLabels } from './labels.js';
import { parseExpectedChain } from './network.js';

export function latencyStats(values) {
  if (values.length === 0) return { min: null, median: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const round = (n) => Math.round(n * 100) / 100;
  return {
    min: round(sorted[0]),
    median: round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2),
    p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    max: round(sorted.at(-1)),
  };
}

async function probe(url, label, samples, timeoutMs, expectedChain) {
  const result = {
    endpoint: label, chainId: null, latestBlock: null,
    attempts: 0, successes: 0, errors: {}, latencyMs: latencyStats([]),
    successRate: 0, lagBlocks: null, peerCount: 0, status: 'unreachable',
    ...(expectedChain === undefined ? {} : { networkStatus: 'unknown' }),
  };
  const recordError = (error) => {
    const code = error.code ?? 'UNKNOWN_ERROR';
    result.errors[code] = (result.errors[code] ?? 0) + 1;
  };
  try {
    const { result: chainId } = await rpcCall(url, 'eth_chainId', [], { timeoutMs });
    const observed = parseQuantity(chainId);
    result.chainId = observed.toString();
    if (expectedChain !== undefined) {
      result.networkStatus = observed === expectedChain ? 'match' : 'mismatch';
      if (result.networkStatus === 'mismatch') {
        result.status = 'mismatch';
        return result;
      }
    }
  } catch (error) {
    recordError(error);
    return result;
  }
  const latencies = [];
  for (let i = 0; i < samples; i++) {
    result.attempts++;
    try {
      const { result: block, durationMs } = await rpcCall(url, 'eth_blockNumber', [], { timeoutMs });
      const height = parseQuantity(block);
      if (result.latestBlock === null || height > BigInt(result.latestBlock)) {
        result.latestBlock = height.toString();
      }
      result.successes++;
      latencies.push(durationMs);
    } catch (error) { recordError(error); }
  }
  result.latencyMs = latencyStats(latencies);
  result.successRate = Math.round(result.successes / samples * 10000) / 100;
  result.status = result.successes === samples ? 'healthy' : result.successes > 0 ? 'degraded' : 'unreachable';
  return result;
}

export function addPeerComparison(results, { lagThreshold = 3, reference } = {}) {
  const threshold = BigInt(lagThreshold);
  const groups = new Map();
  for (const result of results) {
    result.lagBlocks = null;
    result.peerCount = 0;
    if (result.status === 'mismatch' || result.chainId === null || result.latestBlock === null) continue;
    const group = groups.get(result.chainId) ?? [];
    group.push(result);
    groups.set(result.chainId, group);
  }
  for (const group of groups.values()) {
    const tip = group.reduce((max, item) => BigInt(item.latestBlock) > max ? BigInt(item.latestBlock) : max, 0n);
    for (const result of group) {
      result.peerCount = group.length - 1;
      if (reference === undefined && group.length > 1) {
        const lag = tip - BigInt(result.latestBlock);
        result.lagBlocks = lag.toString();
        if (lag > threshold && result.status === 'healthy') result.status = 'degraded';
      }
    }
  }
  if (reference !== undefined) {
    const baseline = results[reference - 1];
    const usable = (result) => result.chainId !== null && result.latestBlock !== null;
    for (const result of results) {
      if (result.status === 'mismatch') result.lagStatus = 'network_mismatch';
      else if (!usable(result)) result.lagStatus = 'no_data';
      else if (result === baseline) result.lagStatus = 'reference';
      else if (baseline.status === 'mismatch') result.lagStatus = 'reference_mismatch';
      else if (!usable(baseline)) result.lagStatus = 'reference_unavailable';
      else if (result.chainId !== baseline.chainId) result.lagStatus = 'different_chain';
      else {
        const delta = BigInt(baseline.latestBlock) - BigInt(result.latestBlock);
        result.lagBlocks = (delta < 0n ? 0n : delta).toString();
        result.lagStatus = delta < 0n ? 'ahead' : 'compared';
        if (delta > threshold && result.status === 'healthy') result.status = 'degraded';
      }
      if (['reference_unavailable', 'reference_mismatch', 'different_chain'].includes(result.lagStatus) && result.status === 'healthy') {
        result.status = 'degraded';
      }
    }
  }
  return results;
}

export async function benchmark(endpoints, {
  samples = 5, timeoutMs = 5000, concurrency = 4, labels, lagThreshold = 3, reference, expectedChain,
} = {}) {
  if (!Array.isArray(endpoints) || endpoints.length < 1 || endpoints.length > 20) {
    throw new Error('Provide between 1 and 20 endpoints.');
  }
  if (!Number.isInteger(samples) || samples < 1 || samples > 100) {
    throw new Error('Samples must be an integer from 1 to 100.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new Error('Timeout must be an integer from 1 to 60000 ms.');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
    throw new Error('Concurrency must be an integer from 1 to 20.');
  }
  if (!Number.isSafeInteger(lagThreshold) || lagThreshold < 0) {
    throw new Error('Lag threshold must be an integer from 0 to 9007199254740991.');
  }
  if (reference !== undefined && (!Number.isInteger(reference) || reference < 1 || reference > endpoints.length)) {
    throw new Error('Reference must be an endpoint index from 1 to the selected endpoint count.');
  }
  const expected = expectedChain === undefined ? undefined : parseExpectedChain(expectedChain);
  const names = endpointLabels(labels, endpoints.length);
  const urls = endpoints.map(validateEndpoint);
  if (new Set(urls).size !== urls.length) throw new Error('Duplicate endpoints are not allowed.');
  const started = performance.now();
  const results = new Array(urls.length);
  const workerCount = Math.min(concurrency, urls.length);
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const index = next++;
      results[index] = await probe(urls[index], names[index], samples, timeoutMs, expected);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    settings: {
      samples, timeoutMs, concurrency: workerCount, lagThreshold,
      ...(reference === undefined ? {} : { reference }),
      ...(expected === undefined ? {} : { expectedChain: expected.toString() }),
    },
    results: addPeerComparison(results, { lagThreshold, reference }),
  };
}
