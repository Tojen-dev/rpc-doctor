import assert from 'node:assert/strict';
import { marked } from 'marked';

// Independent GFM renderer; reject any generated markup outside this report's
// inert vocabulary. Decode the resulting HTML text once, as a browser would.
export function htmlText(html) {
  return html.replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return entity[0] === '#' ? String.fromCodePoint(entity[1].toLowerCase() === 'x'
      ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))) : named[entity] ?? whole;
  });
}

export function renderedReport(markdown) {
  const html = marked.parse(markdown, { gfm: true });
  for (const [tag] of html.matchAll(/<[^>]*>/g)) {
    assert.match(tag, /^<\/?(?:h1|h2|p|table|thead|tbody|tr|th|td)>$/, `Unexpected active/formatting markup: ${tag}`);
  }
  const tables = [...html.matchAll(/<table>([\s\S]*?)<\/table>/g)].map(([, body]) =>
    [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
      [...row.matchAll(/<t[hd]>([\s\S]*?)<\/t[hd]>/g)].map(([, cell]) => htmlText(cell))));
  return { html, tables };
}

export function compareMarkdownReport(markdown, report) {
  const { tables } = renderedReport(markdown);
  const cell = value => value == null ? '—' : String(value);
  const errorText = map => Object.keys(map).sort().map(code => `${code}: ${map[code]}`).join('; ') || 'None';
  const summary = Object.fromEntries(tables[0].slice(1));
  assert.equal(summary['Elapsed (ms)'], String(report.durationMs));
  assert.equal(summary['Requested measured samples per accepted endpoint'], String(report.settings.samples));
  assert.equal(summary['Timeout per request (ms)'], String(report.settings.timeoutMs));
  assert.equal(summary['Effective concurrency (all RPC phases)'], String(report.settings.concurrency));
  assert.equal(summary['Expected chain ID'], report.settings.expectedChain ?? 'Disabled');
  assert.equal(summary['Reference endpoint index'], cell(report.settings.reference ?? 'None — same-chain peer maximum'));
  assert.equal(summary['Warm-up calls per accepted endpoint'], cell(report.settings.warmup ?? 'Disabled'));
  assert.equal(summary['Minimum interval between round starts (ms)'], cell(report.settings.intervalMs ?? 'Disabled'));
  assert.equal(summary['Actual pacing wait (ms)'], report.settings.intervalMs ? cell(report.pacingWaitMs) : 'Disabled');
  // Actual wall timestamps vary across otherwise identical deterministic runs.
  for (const key of ['Started at (UTC)', 'Generated at (UTC)']) assert.ok(Number.isFinite(Date.parse(summary[key])));
  assert.equal(tables[1].length, report.results.length + 1);
  report.results.forEach((r, i) => {
    assert.deepEqual(tables[1][i + 1], [i + 1, r.endpoint, r.status, r.chainId, r.networkStatus ?? 'Disabled',
      `${r.successes}/${r.attempts}`, r.successRate, r.latestBlock, r.lagBlocks, r.peerCount, r.lagStatus ?? 'Same-chain peers'].map(cell));
    assert.deepEqual(tables[2][i + 1], [i + 1, r.latencySampleCount, r.latencyMs.min, r.latencyMs.median,
      r.latencyMs.p95, r.latencyMs.p99, r.latencyMs.max, r.latencyMs.stddev].map(cell));
    assert.deepEqual(tables[3][i + 1], [i + 1, errorText(r.chainId === null ? r.errors : {}), errorText(r.chainId === null ? {} : r.errors),
      r.warmup ? `${r.warmup.successes}/${r.warmup.attempts}` : 'Disabled', r.warmup?.durationMs ?? 'Disabled',
      r.warmup ? errorText(r.warmup.errors) : 'Disabled'].map(cell));
    assert.deepEqual(tables[4][i + 1], [i + 1, r.observations[0]?.startedMs, r.observations.at(-1)?.finishedMs].map(cell));
  });
  assert.deepEqual(tables[5].slice(1), report.rounds.map(r => [r.round, r.startedMs, r.finishedMs].map(cell)));
  if (report.healthPolicy) {
    const policy = report.healthPolicy;
    assert.deepEqual(tables[6].slice(1), [
      ['Result', policy.passed ? 'PASS' : 'FAIL'],
      ['Maximum failed measured calls per endpoint (inclusive)', String(policy.maxFailures)],
      ['Maximum known lag (blocks, inclusive)', String(report.settings.lagThreshold)],
    ]);
    if (policy.violations.length) assert.deepEqual(tables[7].slice(1),
      policy.violations.map(v => [String(v.endpointIndex), v.code, v.message]));
    if (policy.uncheckedLagEndpoints.length) assert.deepEqual(tables.at(-1).slice(1),
      policy.uncheckedLagEndpoints.map(i => [String(i), report.results[i - 1].endpoint]));
  } else assert.match(markdown, /Disabled\. No strict PASS\/FAIL decision was requested\./);
}
