import { rpcCall, parseQuantity, validateEndpoint } from './rpc.js';
import { endpointLabels } from './labels.js';
import { parseExpectedChain } from './network.js';
import { parseHistoricalBlock, probeHistoricalBlock } from './historical.js';

const LATENCY_NOTES = [
  'Latency n counts successful measured calls only; failed attempts remain in Errors.',
  'Stddev is population standard deviation (divisor n): n=0 is unavailable; n=1 gives 0ms, which does not establish stability.',
  'Short samples cannot reliably estimate tails. Nearest-rank p99 equals max for 0 < n < 100; even n=100 does not establish a reliable tail estimate.',
];

export function latencyStats(values) {
  if (values.length === 0) return { min: null, median: null, p95: null, max: null, stddev: null, p99: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const round = (n) => Math.round(n * 100) / 100;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  // Center before squaring to avoid subtracting two large, nearly equal sums.
  // Use all unrounded successes and the population divisor n, not n - 1.
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    min: round(sorted[0]),
    median: round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2),
    p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    max: round(sorted.at(-1)),
    stddev: round(Math.sqrt(variance)),
    p99: round(sorted[Math.ceil(sorted.length * 0.99) - 1]),
  };
}

function recordError(error, errors) {
  const code = error.code ?? 'UNKNOWN_ERROR';
  errors[code] = (errors[code] ?? 0) + 1;
  return code;
}

async function prepareProbe(url, label, { timeoutMs, expectedChain, warmup }, nextRequestId) {
  const result = {
    endpoint: label, chainId: null, latestBlock: null,
    attempts: 0, successes: 0, errors: {}, latencyMs: latencyStats([]),
    latencySampleCount: 0,
    successRate: 0, lagBlocks: null, peerCount: 0, status: 'unreachable',
    observations: [],
    ...(expectedChain === undefined ? {} : { networkStatus: 'unknown' }),
    ...(warmup === 0 ? {} : { warmup: { attempts: 0, successes: 0, errors: {}, durationMs: 0 } }),
  };
  const call = (method, params = []) => rpcCall(url, method, params, { timeoutMs, id: nextRequestId() });
  const probe = { result, call, latencies: [], ready: false };
  try {
    const { result: chainId } = await call('eth_chainId');
    const observed = parseQuantity(chainId);
    result.chainId = observed.toString();
    if (expectedChain !== undefined) {
      result.networkStatus = observed === expectedChain ? 'match' : 'mismatch';
      if (result.networkStatus === 'mismatch') {
        result.status = 'mismatch';
        return probe;
      }
    }
  } catch (error) {
    recordError(error, result.errors);
    return probe;
  }
  if (warmup > 0) {
    const started = performance.now();
    for (let i = 0; i < warmup; i++) {
      result.warmup.attempts++;
      try {
        const { result: block } = await call('eth_blockNumber');
        parseQuantity(block);
        result.warmup.successes++;
      } catch (error) { recordError(error, result.warmup.errors); }
    }
    result.warmup.durationMs = Math.round(performance.now() - started);
  }
  probe.ready = true;
  return probe;
}

async function sampleProbe({ result, call, latencies }, round, elapsedMs) {
  const observation = { round, startedMs: elapsedMs(), finishedMs: null, block: null, error: null };
  result.attempts++;
  try {
    const { result: block, durationMs } = await call('eth_blockNumber');
    const height = parseQuantity(block);
    observation.block = height.toString();
    if (result.latestBlock === null || height > BigInt(result.latestBlock)) {
      result.latestBlock = observation.block;
    }
    result.successes++;
    latencies.push(durationMs);
  } catch (error) {
    observation.error = recordError(error, result.errors);
  } finally {
    observation.finishedMs = elapsedMs();
    result.observations.push(observation);
  }
}

// Each phase owns at most one sequential operation per worker. Await the whole
// pool before reusing it so preparation and successive rounds cannot overlap.
async function runPhase(items, concurrency, operation) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function waitForRound(previousStart, intervalMs) {
  const started = performance.now();
  let remaining = previousStart + intervalMs - started;
  if (remaining <= 0) return 0;
  do {
    // Recheck the monotonic deadline after waking; round offsets are rounded
    // for reporting only and must never shorten the requested interval.
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(remaining)));
    remaining = previousStart + intervalMs - performance.now();
  } while (remaining > 0);
  return performance.now() - started;
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
  samples = 5, timeoutMs = 5000, concurrency = 4, labels, lagThreshold = 3, reference, expectedChain, warmup = 0,
  intervalMs = 0, historicalBlock,
} = {}) {
  if (!Array.isArray(endpoints) || endpoints.length < 1 || endpoints.length > 20) {
    throw new Error('Provide between 1 and 20 endpoints.');
  }
  if (!Number.isInteger(samples) || samples < 1 || samples > 100) {
    throw new Error('Samples must be an integer from 1 to 100.');
  }
  if (!Number.isInteger(warmup) || warmup < 0 || warmup > 20) {
    throw new Error('Warm-up must be an integer from 0 to 20.');
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 60000) {
    throw new Error('Interval must be an integer from 0 to 60000 ms.');
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
  const historical = historicalBlock === undefined ? undefined : parseHistoricalBlock(historicalBlock);
  const names = endpointLabels(labels, endpoints.length);
  const urls = endpoints.map(validateEndpoint);
  if (new Set(urls).size !== urls.length) throw new Error('Duplicate endpoints are not allowed.');
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const elapsedMs = () => Math.round(performance.now() - started);
  const probes = new Array(urls.length);
  const workerCount = Math.min(concurrency, urls.length);
  let requestId = 0;
  const nextRequestId = () => ++requestId;
  await runPhase(urls, workerCount, async (url, index) => {
    probes[index] = await prepareProbe(url, names[index], {
      timeoutMs, expectedChain: expected, warmup,
    }, nextRequestId);
  });
  const accepted = probes.filter((probe) => probe.ready);
  const rounds = [];
  let previousStart;
  let pacingWaitMs = 0;
  for (let round = 1; accepted.length > 0 && round <= samples; round++) {
    if (round > 1 && intervalMs > 0) pacingWaitMs += await waitForRound(previousStart, intervalMs);
    previousStart = performance.now();
    const startedMs = Math.round(previousStart - started);
    await runPhase(accepted, workerCount, (probe) => sampleProbe(probe, round, elapsedMs));
    rounds.push({ round, startedMs, finishedMs: elapsedMs() });
  }
  for (const { result, latencies } of accepted) {
    result.latencyMs = latencyStats(latencies);
    result.latencySampleCount = latencies.length;
    result.successRate = Math.round(result.successes / samples * 10000) / 100;
    result.status = result.successes === samples ? 'healthy' : result.successes > 0 ? 'degraded' : 'unreachable';
    if (result.status === 'healthy' && warmup > 0 && result.warmup.successes < result.warmup.attempts) {
      result.status = 'degraded';
    }
  }
  let historicalPhase;
  if (historical !== undefined) {
    const phaseStarted = performance.now();
    historicalPhase = { startedMs: Math.round(phaseStarted - started), finishedMs: null, durationMs: null };
    await runPhase(probes, workerCount, probe => probeHistoricalBlock(probe, historical, elapsedMs));
    historicalPhase.finishedMs = elapsedMs();
    historicalPhase.durationMs = Math.round(performance.now() - phaseStarted);
  }
  return {
    schemaVersion: 1,
    startedAt,
    generatedAt: new Date().toISOString(),
    durationMs: elapsedMs(),
    settings: {
      samples, timeoutMs, concurrency: workerCount, lagThreshold,
      ...(reference === undefined ? {} : { reference }),
      ...(expected === undefined ? {} : { expectedChain: expected.toString() }),
      ...(warmup === 0 ? {} : { warmup }),
      ...(intervalMs === 0 ? {} : { intervalMs }),
      ...(historical === undefined ? {} : { historicalBlock: historical.toString() }),
    },
    ...(intervalMs === 0 ? {} : { pacingWaitMs: Math.round(pacingWaitMs) }),
    ...(historicalPhase === undefined ? {} : { historicalPhase }),
    latencyNotes: [...LATENCY_NOTES],
    rounds,
    results: addPeerComparison(probes.map((probe) => probe.result), { lagThreshold, reference }),
  };
}
