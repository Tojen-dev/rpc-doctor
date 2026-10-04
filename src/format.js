export function formatTable(report) {
  const reference = report.settings.reference;
  const guarded = report.settings.expectedChain !== undefined;
  const warmed = report.settings.warmup > 0;
  const lagChecks = {
    reference: 'reference (unverified)', compared: 'compared', ahead: 'ahead of reference',
    reference_unavailable: 'reference unavailable', different_chain: 'different chain', no_data: 'no block data',
    reference_mismatch: 'reference wrong chain', network_mismatch: 'wrong chain',
  };
  const headers = ['Endpoint', 'Chain', ...(guarded ? ['Network'] : []), 'Status', 'OK', 'Median', 'p95', 'Block', 'Lag'];
  if (reference !== undefined) headers.push('Lag check');
  if (warmed) headers.push('Warm-up OK', 'Warm-up elapsed');
  const hasObservations = Array.isArray(report.rounds);
  if (hasObservations) headers.push('Observed (ms)');
  const ms = (value) => value === null ? '—' : `${value.toFixed(1)}ms`;
  const rows = report.results.map((r) => [
    r.endpoint, r.chainId ?? '—', ...(guarded ? [r.networkStatus] : []), r.status, `${r.successes}/${r.attempts}`,
    ms(r.latencyMs.median), ms(r.latencyMs.p95), r.latestBlock ?? '—', r.lagBlocks ?? '—',
    ...(reference === undefined ? [] : [lagChecks[r.lagStatus] ?? '—']),
    ...(warmed ? [`${r.warmup.successes}/${r.warmup.attempts}`, `${r.warmup.durationMs}ms`] : []),
    ...(hasObservations ? [r.observations.length
      ? `${r.observations[0].startedMs}–${r.observations.at(-1).finishedMs}` : '—'] : []),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  const errors = report.results.flatMap((r) => Object.entries(r.errors).map(([code, count]) => `  ${r.endpoint}: ${code} × ${count}`));
  const warmupErrors = warmed ? report.results.flatMap((r) => Object.entries(r.warmup.errors).map(([code, count]) => `  ${r.endpoint}: ${code} × ${count}`)) : [];
  return [
    report.demo ? 'RPC Doctor · local demo (synthetic endpoints)' : 'RPC Doctor', '',
    line(headers), line(widths.map((w) => '─'.repeat(w))), ...rows.map(line), '',
    `Samples: ${report.settings.samples} · Timeout: ${report.settings.timeoutMs}ms · Concurrency: ${report.settings.concurrency} · Elapsed: ${report.durationMs}ms`,
    ...(hasObservations ? [`Sampling: ${report.rounds.length} completed rounds; each waits for all accepted endpoints.`,
      `Started: ${report.startedAt}. Observed: first request start–last finish, in elapsed client ms.`,
      'Observation windows include failed attempts and waits between rounds; per-attempt times are in --json.'] : []),
    ...(report.settings.intervalMs > 0
      ? [`Round interval: ${report.settings.intervalMs}ms minimum between starts · Pacing wait: ${report.pacingWaitMs}ms (included in Elapsed, excluded from RPC latency).`]
      : []),
    ...(warmed ? [`Warm-up: ${report.settings.warmup} calls per endpoint after the network guard; included in Elapsed.`,
      'Warm-up OK is successes/attempts; warm-up time and errors are separate from measured samples.'] : []),
    `Lag threshold: ${report.settings.lagThreshold} blocks.`,
    ...(guarded ? [`Expected chain: ${report.settings.expectedChain}. Mismatched endpoints receive no block samples.`] : []),
    ...(reference === undefined
      ? ['Lag is relative to observed same-chain peers; — means no comparison is available.']
      : [`Reference: endpoint ${reference} (${report.results[reference - 1].endpoint}).`,
        'Lag uses only the reference on the same chain; — means not compared. No fallback.',
        'The reference is not checked for freshness; endpoints ahead of it have lag 0.']),
    'Endpoint labels follow input order. URLs are omitted to protect API keys.',
    ...(errors.length ? ['', 'Errors:', ...errors] : []),
    ...(warmupErrors.length ? ['', 'Warm-up errors:', ...warmupErrors] : []),
  ].join('\n');
}
