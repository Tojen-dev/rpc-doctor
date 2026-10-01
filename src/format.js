export function formatTable(report) {
  const headers = ['Endpoint', 'Chain', 'Status', 'OK', 'Median', 'p95', 'Block', 'Lag'];
  const ms = (value) => value === null ? '—' : `${value.toFixed(1)}ms`;
  const rows = report.results.map((r) => [
    r.endpoint, r.chainId ?? '—', r.status, `${r.successes}/${r.attempts}`,
    ms(r.latencyMs.median), ms(r.latencyMs.p95), r.latestBlock ?? '—', r.lagBlocks ?? '—',
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  const errors = report.results.flatMap((r) => Object.entries(r.errors).map(([code, count]) => `  ${r.endpoint}: ${code} × ${count}`));
  return [
    report.demo ? 'RPC Doctor · local demo (synthetic endpoints)' : 'RPC Doctor', '',
    line(headers), line(widths.map((w) => '─'.repeat(w))), ...rows.map(line), '',
    `Samples: ${report.settings.samples} · Timeout: ${report.settings.timeoutMs}ms · Concurrency: ${report.settings.concurrency} · Elapsed: ${report.durationMs}ms`,
    'Lag is relative to observed same-chain peers; — means no comparison is available.',
    'Endpoint labels follow input order. URLs are omitted to protect API keys.',
    ...(errors.length ? ['', 'Errors:', ...errors] : []),
  ].join('\n');
}
