import { RpcError } from './rpc.js';
import { parseExpectedChain } from './network.js';

export class HistoricalBlockError extends Error {}

export function parseHistoricalBlock(value) {
  try { return parseExpectedChain(value); }
  catch { throw new HistoricalBlockError('Historical block must be a decimal or 0x-hex string from 0 to 2^256-1, without leading zeros (at most 78 characters).'); }
}

export const HISTORICAL_NOTE = 'This single header lookup does not prove historical state access, full-range availability, canonicality, freshness, or archive-node support. Probe outcomes do not affect baseline samples, latency, lag, status, or strict health policy.';

// Validate only the number/hash projection, never retain a provider block object.
export function historicalHeader(value, requested) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.number !== 'string' || value.number.length > 66
    || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)(?![\s\S])/.test(value.number)
    || BigInt(value.number) !== requested
    || typeof value.hash !== 'string' || !/^0x[0-9a-fA-F]{64}(?![\s\S])/.test(value.hash)) {
    throw new RpcError('INVALID_RESULT', 'Invalid historical block number or hash.');
  }
  return { number: requested.toString(), hash: value.hash.toLowerCase() };
}

export async function probeHistoricalBlock({ result, call, ready }, requested, elapsedMs) {
  const probe = { status: 'skipped', attempts: 0, number: null, hash: null, error: null,
    skipReason: null, startedMs: null, finishedMs: null, durationMs: null };
  result.historicalBlock = probe;
  if (!ready) {
    probe.skipReason = result.status === 'mismatch' ? 'network_mismatch' : 'handshake_failed';
    return;
  }
  probe.attempts = 1;
  probe.startedMs = elapsedMs();
  const started = performance.now();
  try {
    const { result: block } = await call('eth_getBlockByNumber', [`0x${requested.toString(16)}`, false]);
    if (block === null) probe.status = 'null';
    else {
      const header = historicalHeader(block, requested);
      probe.status = 'found'; probe.number = header.number; probe.hash = header.hash;
    }
  } catch (error) {
    probe.status = error instanceof RpcError && error.code === 'RPC_ERROR' && error.rpcCode === -32601 ? 'unsupported' : 'error';
    probe.error = error instanceof RpcError ? error.code : 'UNKNOWN_ERROR';
  } finally {
    probe.finishedMs = elapsedMs();
    probe.durationMs = Math.round(performance.now() - started);
  }
}
