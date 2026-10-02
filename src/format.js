export function formatTable(report) {
  const reference = report.settings.reference;
  const lagChecks = {
    reference: 'reference (unverified)', compared: 'compared', ahead: 'ahead of reference',
    reference_unavailable: 'reference unavailable', different_chain: 'different chain', no_data: 'no block data',
  };
  const headers = ['Endpoint', 'Chain', 'Status', 'OK', 'Median', 'p95', 'Block', 'Lag'];
  if (reference !== undefined) headers.push('Lag check');
  const ms = (value) => value === null ? '—' : `${value.toFixed(1)}ms`;
  const rows = report.results.map((r) => [
    r.endpoint, r.chainId ?? '—', r.status, `${r.successes}/${r.attempts}`,
    ms(r.latencyMs.median), ms(r.latencyMs.p95), r.latestBlock ?? '—', r.lagBlocks ?? '—',
    ...(reference === undefined ? [] : [lagChecks[r.lagStatus] ?? '—']),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  const errors = report.results.flatMap((r) => Object.entries(r.errors).map(([code, count]) => `  ${r.endpoint}: ${code} × ${count}`));
  return [
    report.demo ? 'RPC Doctor · local demo (synthetic endpoints)' : 'RPC Doctor', '',
    line(headers), line(widths.map((w) => '─'.repeat(w))), ...rows.map(line), '',
    `Samples: ${report.settings.samples} · Timeout: ${report.settings.timeoutMs}ms · Concurrency: ${report.settings.concurrency} · Elapsed: ${report.durationMs}ms`,
    `Lag threshold: ${report.settings.lagThreshold} blocks.`,
    ...(reference === undefined
      ? ['Lag is relative to observed same-chain peers; — means no comparison is available.']
      : [`Reference: endpoint ${reference} (${report.results[reference - 1].endpoint}).`,
        'Lag uses only the reference on the same chain; — means not compared. No fallback.',
        'The reference is not checked for freshness; endpoints ahead of it have lag 0.']),
    'Endpoint labels follow input order. URLs are omitted to protect API keys.',
    ...(errors.length ? ['', 'Errors:', ...errors] : []),
  ].join('\n');
}
