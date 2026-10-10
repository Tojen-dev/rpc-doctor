// Quote every field, including numeric text. Quoting protects CSV structure;
// a leading apostrophe separately reduces spreadsheet formula interpretation.
export function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (typeof value === 'string' && (/^[\s\p{Cc}\p{Cf}]*[=+\-@＝＋－＠]/u.test(text)
    || /^[\s\p{Cc}\p{Cf}]*[\t\r\n]/u.test(text))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

const errorMap = (errors) => errors === undefined ? undefined
  : JSON.stringify(Object.fromEntries(Object.keys(errors).sort().map((code) => [code, errors[code]])));

// Fixed projection of the in-memory CLI report, never of URLs or raw responses.
// This order is the public CSV column contract documented in README.md.
const columns = [
  ['endpoint_index', (r, report, index) => index + 1],
  ['endpoint', (r) => r.endpoint],
  ['chain_id', (r) => r.chainId],
  ['status', (r) => r.status],
  ['network_status', (r) => r.networkStatus],
  ['attempts', (r) => r.attempts],
  ['successes', (r) => r.successes],
  ['success_rate_pct', (r) => r.successRate],
  ['latency_sample_count', (r) => r.latencySampleCount],
  ['latency_min_ms', (r) => r.latencyMs.min],
  ['latency_median_ms', (r) => r.latencyMs.median],
  ['latency_p95_ms', (r) => r.latencyMs.p95],
  ['latency_p99_ms', (r) => r.latencyMs.p99],
  ['latency_max_ms', (r) => r.latencyMs.max],
  ['latency_stddev_ms', (r) => r.latencyMs.stddev],
  ['latest_block', (r) => r.latestBlock],
  ['lag_blocks', (r) => r.lagBlocks],
  ['peer_count', (r) => r.peerCount],
  ['handshake_errors', (r) => errorMap(r.chainId === null ? r.errors : {})],
  ['sample_errors', (r) => errorMap(r.chainId === null ? {} : r.errors)],
  ['warmup_attempts', (r) => r.warmup?.attempts],
  ['warmup_successes', (r) => r.warmup?.successes],
  ['warmup_duration_ms', (r) => r.warmup?.durationMs],
  ['warmup_errors', (r) => errorMap(r.warmup?.errors)],
  ['reference_index', (r, report) => report.settings.reference],
  ['lag_status', (r) => r.lagStatus],
  ['expected_chain', (r, report) => report.settings.expectedChain],
  ['lag_threshold_blocks', (r, report) => report.settings.lagThreshold],
  ['samples', (r, report) => report.settings.samples],
  ['timeout_ms', (r, report) => report.settings.timeoutMs],
  ['concurrency', (r, report) => report.settings.concurrency],
  ['warmup_requested', (r, report) => report.settings.warmup],
  ['interval_ms', (r, report) => report.settings.intervalMs],
  ['pacing_wait_ms', (r, report) => report.pacingWaitMs],
  ['started_at', (r, report) => report.startedAt],
  ['generated_at', (r, report) => report.generatedAt],
  ['duration_ms', (r, report) => report.durationMs],
  ['demo', (r, report) => report.demo],
  ['strict_passed', (r, report) => report.healthPolicy?.passed],
  ['strict_max_failures', (r, report) => report.healthPolicy?.maxFailures],
  ['strict_violations', (r, report, index) => report.healthPolicy
    ? JSON.stringify(report.healthPolicy.violations.filter((v) => v.endpointIndex === index + 1).map((v) => v.code)) : undefined],
  ['strict_lag_check', (r, report, index) => report.healthPolicy
    ? r.successes === 0 ? 'no_samples' : report.healthPolicy.uncheckedLagEndpoints.includes(index + 1) ? 'unchecked' : 'compared'
    : undefined],
];

export function formatCsv(report) {
  const selected = report.settings.historicalBlock === undefined ? columns : [...columns,
    ['historical_requested_block', (r, report) => report.settings.historicalBlock],
    ['historical_status', r => r.historicalBlock.status],
    ['historical_attempts', r => r.historicalBlock.attempts],
    ['historical_number', r => r.historicalBlock.number],
    ['historical_hash', r => r.historicalBlock.hash],
    ['historical_error', r => r.historicalBlock.error],
    ['historical_skip_reason', r => r.historicalBlock.skipReason],
    ['historical_started_ms', r => r.historicalBlock.startedMs],
    ['historical_finished_ms', r => r.historicalBlock.finishedMs],
    ['historical_duration_ms', r => r.historicalBlock.durationMs],
    ['historical_phase_started_ms', (r, report) => report.historicalPhase.startedMs],
    ['historical_phase_finished_ms', (r, report) => report.historicalPhase.finishedMs],
    ['historical_phase_duration_ms', (r, report) => report.historicalPhase.durationMs],
  ];
  const rows = [selected.map(([name]) => name),
    ...report.results.map((result, index) => selected.map(([, get]) => get(result, report, index)))];
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
