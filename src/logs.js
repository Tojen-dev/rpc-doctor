import { RpcError } from './rpc.js';
import { parseExpectedChain } from './network.js';

export class LogsProbeError extends Error {}
export const LOGS_NOTE = 'This bounded eth_getLogs probe does not prove completeness, provider honesty, canonicality, finality, archive support, or identical forks. A numeric range does not pin block hashes; a provider may silently omit logs. Counts describe only the validated response, including any removed entries. Probe outcomes do not affect baseline metrics or strict health policy.';

const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}(?![\s\S])/.test(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}(?![\s\S])/.test(value);
const quantity = value => typeof value === 'string' && value.length <= 66
  && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)(?![\s\S])/.test(value);
const data = value => typeof value === 'string' && value.length <= 8194
  && /^0x(?:[0-9a-fA-F]{2})*(?![\s\S])/.test(value);

export function parseLogsOptions({ logsFrom, logsTo, logsAddress, logsTopic0 } = {}) {
  if ([logsFrom, logsTo, logsAddress, logsTopic0].every(v => v === undefined)) return undefined;
  if (logsFrom === undefined || logsTo === undefined) {
    throw new LogsProbeError('Use --logs-from and --logs-to together; optional log filters require this pair.');
  }
  let from; let to;
  try { from = parseExpectedChain(logsFrom); to = parseExpectedChain(logsTo); }
  catch { throw new LogsProbeError('Log bounds must be decimal or 0x-hex strings from 0 to 2^256-1, without leading zeros (at most 78 characters).'); }
  if (to < from || to - from >= 100n) throw new LogsProbeError('Log range must be ordered from <= to and contain at most 100 blocks, inclusive.');
  if (logsAddress !== undefined && !address(logsAddress)) throw new LogsProbeError('Log address must be a single 20-byte 0x-hex address.');
  if (logsTopic0 !== undefined && !hash(logsTopic0)) throw new LogsProbeError('Log topic0 must be a single 32-byte 0x-hex value.');
  return { from, to, address: logsAddress?.toLowerCase(), topic0: logsTopic0?.toLowerCase() };
}

// Validate the entire bounded response before exposing any count. Never retain logs.
export function logCounts(value, request) {
  const invalid = () => new RpcError('INVALID_RESULT', 'Invalid or oversized log result, or log outside the requested filter.');
  if (!Array.isArray(value) || value.length > 1000) throw invalid();
  let removedCount = 0;
  for (const log of value) {
    if (!log || typeof log !== 'object' || Array.isArray(log)
      || typeof log.removed !== 'boolean' || !quantity(log.logIndex) || !quantity(log.transactionIndex)
      || !quantity(log.blockNumber) || !hash(log.transactionHash) || !hash(log.blockHash)
      || !address(log.address) || !data(log.data) || !Array.isArray(log.topics)
      || log.topics.length > 4 || !log.topics.every(hash)
      || (Object.hasOwn(log, 'blockTimestamp') && !quantity(log.blockTimestamp))) throw invalid();
    const block = BigInt(log.blockNumber);
    if (block < request.from || block > request.to
      || (request.address !== undefined && log.address.toLowerCase() !== request.address)
      || (request.topic0 !== undefined && log.topics[0]?.toLowerCase() !== request.topic0)) throw invalid();
    if (log.removed) removedCount++;
  }
  return { logCount: value.length, removedCount };
}

export async function probeLogs({ result, call, ready }, request, elapsedMs) {
  const probe = { status: 'skipped', attempts: 0, logCount: null, removedCount: null, error: null,
    skipReason: null, startedMs: null, finishedMs: null, durationMs: null };
  result.logs = probe;
  if (!ready) {
    probe.skipReason = result.status === 'mismatch' ? 'network_mismatch' : 'handshake_failed';
    return;
  }
  probe.attempts = 1;
  probe.startedMs = elapsedMs();
  const started = performance.now();
  try {
    const { result: logs } = await call('eth_getLogs', [{
      fromBlock: `0x${request.from.toString(16)}`, toBlock: `0x${request.to.toString(16)}`,
      ...(request.address === undefined ? {} : { address: request.address }),
      ...(request.topic0 === undefined ? {} : { topics: [request.topic0] }),
    }]);
    const counts = logCounts(logs, request);
    probe.logCount = counts.logCount; probe.removedCount = counts.removedCount;
    probe.status = 'success';
  } catch (error) {
    probe.status = error instanceof RpcError && error.code === 'RPC_ERROR' && error.rpcCode === -32601 ? 'unsupported' : 'error';
    probe.error = error instanceof RpcError ? error.code : 'UNKNOWN_ERROR';
  } finally {
    probe.finishedMs = elapsedMs();
    probe.durationMs = Math.round(performance.now() - started);
  }
}
