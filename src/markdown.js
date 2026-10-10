import { HISTORICAL_NOTE } from './historical.js';

// Dynamic content is always plain text, never Markdown syntax or inline code.
// Encode ASCII punctuation, including URL/email delimiters: backslash escapes
// alone do not prevent GFM bare autolinks. Entities are not parsed as syntax.
// Keep ampersands named so renderers also preserve entity-looking text literally.
export function markdownText(value) {
  if (value === null || value === undefined) return '—';
  return String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim()
    .replace(/[!-/:-@\[-`{-~]/g, character => character === '&' ? '&amp;' : `&#${character.charCodeAt(0)};`);
}

function table(headers, rows) {
  const line = row => `| ${row.map(markdownText).join(' | ')} |`;
  return [line(headers), `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n');
}

const errors = map => map === undefined ? undefined
  : Object.keys(map).sort().map(code => `${code}: ${map[code]}`).join('; ') || 'None';
const ratio = (successes, attempts) => `${successes}/${attempts}`;

// Project only the completed, sanitized in-memory report. Do not spread result
// objects, inspect endpoint URLs, or serialize arbitrary extra properties.
export function formatMarkdown(report) {
  const { settings, results, healthPolicy: policy } = report;
  const sections = ['# RPC Doctor report',
    '## Measurement summary',
    table(['Setting', 'Value'], [
      ['Started at (UTC)', report.startedAt],
      ['Generated at (UTC)', report.generatedAt],
      ['Elapsed (ms)', report.durationMs],
      ['Synthetic demo', report.demo === true ? 'Yes — local synthetic endpoints' : 'No'],
      ['Endpoints (input order)', results.length],
      ['Requested measured samples per accepted endpoint', settings.samples],
      ['Timeout per request (ms)', settings.timeoutMs],
      ['Effective concurrency (all RPC phases)', settings.concurrency],
      ['Warm-up calls per accepted endpoint', settings.warmup ?? 'Disabled'],
      ['Minimum interval between round starts (ms)', settings.intervalMs ?? 'Disabled'],
      ['Actual pacing wait (ms)', settings.intervalMs === undefined ? 'Disabled' : report.pacingWaitMs],
      ['Completed measured rounds', report.rounds?.length],
      ['Expected chain ID', settings.expectedChain ?? 'Disabled'],
      ['Lag threshold (blocks, inclusive)', settings.lagThreshold],
      ['Reference endpoint index', settings.reference ?? 'None — same-chain peer maximum'],
    ]),
    'Each endpoint performs one chain handshake, then the optional expected-chain guard, then optional unmeasured warm-up calls. Failed handshakes and mismatches skip warm-up and measurement. All preparation finishes before measured rounds begin. No retries or transactions are sent.',
    'Each round attempts one block-number call per accepted endpoint and waits for all outcomes. Calls per endpoint are sequential; concurrency bounds all phases. Slow peers delay rounds. Pacing uses the previous actual round start after the completion barrier, with no initial, final, or catch-up wait. Elapsed time includes preparation, waits, and measurement.',
    '## Endpoint results',
    'Rows retain input order. Chain IDs, blocks, and lags are exact decimal integers. Latest block is the highest successful measured block observed. An em dash (—) means unknown or unavailable; Disabled means a feature was not enabled. Neither means zero or a passed check. Successes/attempts count measured calls only; zero attempts means measurement was skipped.',
    table(['Index', 'Endpoint', 'Status', 'Chain ID', 'Network guard', 'Successes/attempts', 'Success rate (%)', 'Latest block', 'Lag (blocks)', 'Peers', 'Lag check'],
      results.map((r, i) => [i + 1, r.endpoint, r.status, r.chainId,
        r.networkStatus ?? 'Disabled', ratio(r.successes, r.attempts), r.successRate,
        r.latestBlock, r.lagBlocks, r.peerCount, r.lagStatus ?? 'Same-chain peers'])),
    settings.reference === undefined
      ? 'Lag uses the highest observed block among usable same-chain peers. A lone usable endpoint has unknown lag. Different chains are never compared.'
      : 'Lag uses only the selected reference. The reference itself has unknown lag; peers ahead of it have lag zero. An unavailable, guard-rejected, or different-chain reference leaves lag unknown with no fallback. Lag check values distinguish reference, compared, ahead, reference_unavailable, reference_mismatch, different_chain, network_mismatch, and no_data.',
    'Relative lag and healthy status do not establish trusted freshness or uptime; peers can agree on stale data.',
    '## Successful measured latency',
    'All latency columns are milliseconds. Only successful measured calls contribute; handshake, warm-up, failures, scheduling, and pacing waits are excluded. n is the successful measured sample count. Stddev uses the population divisor n; n=0 is unavailable and n=1 gives zero without establishing stability. p99 uses nearest rank and equals max for 0 < n < 100. Short samples cannot reliably estimate tails; even 100 successes give no reliability guarantee.',
    table(['Index', 'n', 'Min (ms)', 'Median (ms)', 'p95 (ms)', 'p99 (ms)', 'Max (ms)', 'Stddev (ms)'],
      results.map((r, i) => [i + 1, r.latencySampleCount, r.latencyMs.min, r.latencyMs.median,
        r.latencyMs.p95, r.latencyMs.p99, r.latencyMs.max, r.latencyMs.stddev])),
    ...(report.latencyNotes ?? []).map(markdownText),
    '## Errors by phase',
    'Only sanitized categories and counts are shown. None means no recorded error in that phase, including skipped phases; it does not prove that a call succeeded. Handshake errors are separate from measured sample errors. Warm-up successes never count as usable measured samples.',
    table(['Index', 'Handshake errors', 'Measured sample errors', 'Warm-up successes/attempts', 'Warm-up elapsed (ms)', 'Warm-up errors'],
      results.map((r, i) => [i + 1, errors(r.chainId === null ? r.errors : {}),
        errors(r.chainId === null ? {} : r.errors),
        r.warmup ? ratio(r.warmup.successes, r.warmup.attempts) : 'Disabled',
        r.warmup?.durationMs ?? 'Disabled', r.warmup ? errors(r.warmup.errors) : 'Disabled'])),
    '## Observation times',
    'Offsets are elapsed client milliseconds from Started at, not provider timestamps. Endpoint windows span the first measured attempt start to the last finish, including failed attempts and waits between rounds. Observations are not synchronized. An empty window means no measured attempt.',
    table(['Index', 'First attempt start (ms)', 'Last attempt finish (ms)'],
      results.map((r, i) => [i + 1, r.observations?.[0]?.startedMs, r.observations?.at(-1)?.finishedMs])),
    table(['Round', 'Start (ms)', 'Finish (ms)'],
      (report.rounds ?? []).map(round => [round.round, round.startedMs, round.finishedMs])),
    'Full per-attempt blocks, errors, and timing details are available with --json.',
    '## Strict health policy',
  ];
  if (policy) {
    sections.push(table(['Setting', 'Value'], [
      ['Result', policy.passed === true ? 'PASS' : policy.passed === false ? 'FAIL' : undefined],
      ['Maximum failed measured calls per endpoint (inclusive)', policy.maxFailures],
      ['Maximum known lag (blocks, inclusive)', settings.lagThreshold],
    ]),
    'Every endpoint needs a measured success. Handshake, network mismatch, warm-up, and unusable or different-chain reference failures always fail. Measured failures may pass within the configured limit. Unknown lag for a lone same-chain endpoint or the reference itself is unchecked, not a failure. A policy pass does not establish freshness, trust, or uptime; statuses and errors remain unchanged.',
    policy.violations.length
      ? table(['Endpoint index', 'Reason', 'Detail'], policy.violations.map(v => [v.endpointIndex, v.code, v.message]))
      : 'Violations: None.',
    policy.uncheckedLagEndpoints.length
      ? table(['Unchecked lag endpoint index', 'Endpoint'], policy.uncheckedLagEndpoints.map(index => [index, results[index - 1]?.endpoint]))
      : 'Unchecked lag endpoints: None.',
    ...(policy.notes ?? []).map(markdownText));
  } else sections.push('Disabled. No strict PASS/FAIL decision was requested.');
  if (settings.historicalBlock !== undefined) {
    sections.push('## Historical block probe',
      table(['Setting', 'Value'], [
        ['Requested block (decimal)', settings.historicalBlock],
        ['Phase start (ms from run start)', report.historicalPhase.startedMs],
        ['Phase finish (ms from run start)', report.historicalPhase.finishedMs],
        ['Phase elapsed (ms)', report.historicalPhase.durationMs],
      ]),
      'One optional eth_getBlockByNumber request with full transactions disabled, after all measured rounds. The same timeout, body limit and concurrency apply. Probe and phase times include failed attempts; phase elapsed includes worker scheduling and counts in whole-run elapsed, never in measured latency. Probe offsets are client elapsed milliseconds; skipped timings are unavailable.',
      table(['Index', 'Outcome', 'Attempts', 'Number', 'Hash', 'Error', 'Skip reason', 'Start (ms)', 'Finish (ms)', 'Duration (ms)'],
        results.map((r, i) => {
          const h = r.historicalBlock;
          return [i + 1, h.status, h.attempts, h.number, h.hash, h.error, h.skipReason, h.startedMs, h.finishedMs, h.durationMs];
        })),
      'found means a matching number and valid 32-byte hash were returned; null means no block returned; unsupported means valid JSON-RPC -32601. Other failures are error, not absence or unsupported. skipped means handshake_failed or network_mismatch, with no attempt. An em dash means unavailable, not zero or success.',
      HISTORICAL_NOTE);
  }
  sections.push('Endpoint URLs, credentials, headers, and raw provider messages are omitted. Labels are public text; do not put secrets in labels.');
  return sections.join('\n\n') + '\n';
}
