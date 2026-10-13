import { RpcError } from './rpc.js';

export class SyncingProbeError extends Error {}

export const SYNCING_OUTCOMES = 'not_syncing means the provider returned false; syncing means a validated progress object. Only valid matching-ID -32601 is unsupported. Other failures leave sync state unknown, never false. skipped means no attempt; unavailable values differ from zero and false.';
export const SYNCING_NOTE = 'This is one provider observation, not proof of complete synchronization, trusted freshness, canonicality or consensus-client readiness. Height order is descriptive only: nondecreasing means starting <= current <= highest; out_of_order is retained without guessing client behavior. No percentage, completion inference or comparison with measured/finality heads is made. Sync state does not affect baseline metrics, status or strict health policy.';

export function syncingProgress(value) {
  const fields = ['startingBlock', 'currentBlock', 'highestBlock'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || fields.some(key => !Object.hasOwn(value, key) || typeof value[key] !== 'string' || value[key].length > 66
      || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)(?![\s\S])/.test(value[key]))) {
    throw new RpcError('INVALID_RESULT', 'Invalid syncing progress quantities.');
  }
  const [starting, current, highest] = fields.map(key => BigInt(value[key]));
  return {
    startingBlock: starting.toString(), currentBlock: current.toString(), highestBlock: highest.toString(),
    // The API supplies an estimated highest block, without a normative ordering
    // constraint. Preserve all structurally valid counters, even unusual orders.
    heightOrder: starting <= current && current <= highest ? 'nondecreasing' : 'out_of_order',
  };
}

export async function probeSyncing({ result, call, ready }, elapsedMs) {
  const probe = { status: 'skipped', attempts: 0, isSyncing: null, startingBlock: null, currentBlock: null,
    highestBlock: null, heightOrder: null, error: null, skipReason: null,
    startedMs: null, finishedMs: null, durationMs: null };
  result.syncing = probe;
  if (!ready) {
    probe.skipReason = result.status === 'mismatch' ? 'network_mismatch' : 'handshake_failed';
    return;
  }
  probe.attempts = 1;
  probe.startedMs = elapsedMs();
  const started = performance.now();
  try {
    const { result: state } = await call('eth_syncing', []);
    if (state === false) { probe.status = 'not_syncing'; probe.isSyncing = false; }
    else {
      const progress = syncingProgress(state);
      probe.status = 'syncing'; probe.isSyncing = true;
      Object.assign(probe, progress);
    }
  } catch (error) {
    probe.status = error instanceof RpcError && error.code === 'RPC_ERROR' && error.rpcCode === -32601 ? 'unsupported' : 'error';
    probe.error = error instanceof RpcError ? error.code : 'UNKNOWN_ERROR';
  } finally {
    probe.finishedMs = elapsedMs();
    probe.durationMs = Math.round(performance.now() - started);
  }
}
