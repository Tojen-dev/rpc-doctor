import { rpcCall, parseQuantity, validateEndpoint } from './rpc.js';
import { endpointLabels } from './labels.js';

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

async function probe(url, label, samples, timeoutMs) {
  const result = {
    endpoint: label, chainId: null, latestBlock: null,
    attempts: 0, successes: 0, errors: {}, latencyMs: latencyStats([]),
    successRate: 0, lagBlocks: null, peerCount: 0, status: 'unreachable',
  };
  const recordError = (error) => {
    const code = error.code ?? 'UNKNOWN_ERROR';
    result.errors[code] = (result.errors[code] ?? 0) + 1;
  };
  try {
    const { result: chainId } = await rpcCall(url, 'eth_chainId', [], { timeoutMs });
    result.chainId = parseQuantity(chainId).toString();
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

export function addPeerComparison(results) {
  const groups = new Map();
  for (const result of results) {
    if (result.chainId === null || result.latestBlock === null) continue;
    const group = groups.get(result.chainId) ?? [];
    group.push(result);
    groups.set(result.chainId, group);
  }
  for (const group of groups.values()) {
    const tip = group.reduce((max, item) => BigInt(item.latestBlock) > max ? BigInt(item.latestBlock) : max, 0n);
    for (const result of group) {
      result.peerCount = group.length - 1;
      if (group.length > 1) {
        const lag = tip - BigInt(result.latestBlock);
        result.lagBlocks = lag.toString();
        if (lag > 3n && result.status === 'healthy') result.status = 'degraded';
      }
    }
  }
  return results;
}

export async function benchmark(endpoints, { samples = 5, timeoutMs = 5000, concurrency = 4, labels } = {}) {
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
      results[index] = await probe(urls[index], names[index], samples, timeoutMs);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    settings: { samples, timeoutMs, concurrency: workerCount, lagThreshold: 3 },
    results: addPeerComparison(results),
  };
}
