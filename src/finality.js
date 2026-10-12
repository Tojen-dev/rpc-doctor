import { RpcError } from './rpc.js';

export class FinalityProbeError extends Error {}

export const FINALITY_OUTCOMES = 'found means a structurally valid number/hash; null means no block returned. unsupported means method_unavailable (-32601), not proven tag rejection. invalid_params (-32602) and other RPC errors leave tag support unknown. Provider messages are never interpreted. skipped means no attempt; unavailable values differ from zero.';
export const FINALITY_NOTE = 'These sequential provider observations are not atomic and do not prove actual safety, finality, canonicality, freshness or network-state agreement. No cross-tag or head comparison is made. Finality probes do not affect baseline samples, latency, lag, status or strict health policy.';

// Validate only the retained header projection; never keep the block or extras.
export function finalityHeader(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.number !== 'string' || value.number.length > 66
    || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)(?![\s\S])/.test(value.number)
    || typeof value.hash !== 'string' || !/^0x[0-9a-fA-F]{64}(?![\s\S])/.test(value.hash)) {
    throw new RpcError('INVALID_RESULT', 'Invalid finality block number or hash.');
  }
  return { number: BigInt(value.number).toString(), hash: value.hash.toLowerCase() };
}

async function probeTag({ result, call, ready }, tag, elapsedMs) {
  const probe = { status: 'skipped', attempts: 0, number: null, hash: null, error: null,
    rpcErrorKind: null, skipReason: null, startedMs: null, finishedMs: null, durationMs: null };
  if (!ready) {
    probe.skipReason = result.status === 'mismatch' ? 'network_mismatch' : 'handshake_failed';
    return probe;
  }
  probe.attempts = 1;
  probe.startedMs = elapsedMs();
  const started = performance.now();
  try {
    const { result: block } = await call('eth_getBlockByNumber', [tag, false]);
    if (block === null) probe.status = 'null';
    else {
      const header = finalityHeader(block);
      probe.status = 'found'; probe.number = header.number; probe.hash = header.hash;
    }
  } catch (error) {
    probe.error = error instanceof RpcError ? error.code : 'UNKNOWN_ERROR';
    if (probe.error === 'RPC_ERROR') {
      probe.rpcErrorKind = error.rpcCode === -32601 ? 'method_unavailable'
        : error.rpcCode === -32602 ? 'invalid_params' : 'other';
    }
    probe.status = probe.rpcErrorKind === 'method_unavailable' ? 'unsupported' : 'error';
  } finally {
    probe.finishedMs = elapsedMs();
    probe.durationMs = Math.round(performance.now() - started);
  }
  return probe;
}

export async function probeFinality(probe, elapsedMs) {
  // A failed safe request must not suppress finalized. A worker owns both calls.
  const safe = await probeTag(probe, 'safe', elapsedMs);
  const finalized = await probeTag(probe, 'finalized', elapsedMs);
  probe.result.finality = { safe, finalized };
}
