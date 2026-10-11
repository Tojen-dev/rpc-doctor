import { RpcError } from './rpc.js';
import { parseExpectedChain } from './network.js';

export class CallProbeError extends Error {}
export const CALL_MAX_BYTES = 4096;
export const CALL_GAS = 100000;
export const CALL_NOTE = 'This bounded eth_call does not prove contract presence, ABI correctness, safety, canonicality, finality, freshness, archive support, or equal state across endpoints. The omitted sender uses the provider default; sender-dependent behavior may differ. Gas is capped at 100000 and value is zero. No signing or transaction submission occurs. Probe outcomes do not affect baseline metrics or strict health policy.';

const isData = value => typeof value === 'string' && value.length <= 2 + CALL_MAX_BYTES * 2
  && /^0x(?:[0-9a-fA-F]{2})*(?![\s\S])/.test(value);

export function parseCallOptions({ callTo, callData, callBlock } = {}) {
  const count = [callTo, callData, callBlock].filter(v => v !== undefined).length;
  if (count === 0) return undefined;
  if (count !== 3) throw new CallProbeError('Use --call-to, --call-data and --call-block together, once each.');
  if (typeof callTo !== 'string' || !/^0x[0-9a-fA-F]{40}(?![\s\S])/.test(callTo)) {
    throw new CallProbeError('Call target must be a 20-byte 0x-hex address.');
  }
  if (!isData(callData)) throw new CallProbeError('Call data must be 0x plus an even number of hex digits, at most 4096 bytes (empty 0x allowed).');
  let block;
  try { block = parseExpectedChain(callBlock); }
  catch { throw new CallProbeError('Call block must be a decimal or 0x-hex string from 0 to 2^256-1, without leading zeros (at most 78 characters).'); }
  return { to: callTo.toLowerCase(), input: callData.toLowerCase(), block };
}

export function callReturnBytes(value) {
  if (!isData(value)) throw new RpcError('INVALID_RESULT', 'Expected even 0x-hex call return data of at most 4096 bytes.');
  return (value.length - 2) / 2;
}

export async function probeCall({ result, call, ready }, request, elapsedMs) {
  const probe = { status: 'skipped', attempts: 0, returnBytes: null, error: null,
    skipReason: null, startedMs: null, finishedMs: null, durationMs: null };
  result.call = probe;
  if (!ready) {
    probe.skipReason = result.status === 'mismatch' ? 'network_mismatch' : 'handshake_failed';
    return;
  }
  probe.attempts = 1;
  probe.startedMs = elapsedMs();
  const started = performance.now();
  try {
    const { result: data } = await call('eth_call', [
      { to: request.to, input: request.input, gas: `0x${CALL_GAS.toString(16)}`, value: '0x0' },
      `0x${request.block.toString(16)}`,
    ]);
    probe.returnBytes = callReturnBytes(data);
    probe.status = 'success';
  } catch (error) {
    probe.status = error instanceof RpcError && error.code === 'RPC_ERROR' && error.rpcCode === -32601 ? 'unsupported' : 'error';
    probe.error = error instanceof RpcError ? error.code : 'UNKNOWN_ERROR';
  } finally {
    probe.finishedMs = elapsedMs();
    probe.durationMs = Math.round(performance.now() - started);
  }
}
