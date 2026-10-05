export class HealthPolicyError extends Error {}

// CLI-only policy: validate before probing, evaluate only after the full report.
export function parseHealthPolicy({ strict = false, maxFailures } = {}) {
  if (typeof strict !== 'boolean') throw new HealthPolicyError('Strict mode must be a boolean flag.');
  if (maxFailures !== undefined) {
    if (!strict) throw new HealthPolicyError('Use --max-failures only with --strict.');
    if (typeof maxFailures !== 'string' || maxFailures.length === 0 || /\D/.test(maxFailures)
      || Number(maxFailures) > 100) {
      throw new HealthPolicyError('Max failures must be an integer from 0 to 100.');
    }
  }
  return strict ? { maxFailures: maxFailures === undefined ? 0 : Number(maxFailures) } : undefined;
}

export function evaluateHealthPolicy(report, { maxFailures }) {
  const violations = [];
  const uncheckedLagEndpoints = [];
  const referenceReasons = {
    reference_unavailable: ['REFERENCE_UNAVAILABLE', 'Selected reference has no usable block sample.'],
    reference_mismatch: ['REFERENCE_MISMATCH', 'Selected reference was rejected by the network guard.'],
    different_chain: ['REFERENCE_DIFFERENT_CHAIN', 'Endpoint and selected reference belong to different chains.'],
  };
  report.results.forEach((result, index) => {
    const fail = (code, message) => violations.push({ endpointIndex: index + 1, code, message });
    if (result.status === 'mismatch') fail('NETWORK_MISMATCH', 'Endpoint was rejected by the network guard.');
    else if (result.chainId === null) fail('HANDSHAKE_FAILED', 'Chain handshake failed.');
    else if (result.successes === 0) fail('NO_MEASURED_SUCCESS', 'No successful measured block sample.');

    const failures = result.attempts - result.successes;
    if (failures > maxFailures) {
      fail('MEASURED_FAILURES', `Failed measured calls: ${failures}; per-endpoint limit: ${maxFailures}.`);
    }
    if (result.warmup && result.warmup.successes < result.warmup.attempts) {
      fail('WARMUP_FAILURES', 'At least one warm-up call failed.');
    }
    const referenceReason = referenceReasons[result.lagStatus];
    if (referenceReason) fail(...referenceReason);
    if (result.lagBlocks !== null && BigInt(result.lagBlocks) > BigInt(report.settings.lagThreshold)) {
      fail('LAG_EXCEEDED', `Observed lag ${result.lagBlocks} blocks exceeds the limit ${report.settings.lagThreshold}.`);
    }
    if (result.successes > 0 && result.lagBlocks === null) uncheckedLagEndpoints.push(index + 1);
  });
  return {
    mode: 'strict', maxFailures, passed: violations.length === 0, violations, uncheckedLagEndpoints,
    notes: [
      'Every endpoint needs a successful measured sample. Handshake, network, warm-up, and reference failures cannot be allowed by maxFailures.',
      'Limits are inclusive: failed measured calls per endpoint <= maxFailures; known lag in blocks <= lagThreshold.',
      'Unknown lag for a lone same-chain endpoint or the reference itself is unchecked and does not fail this policy. Unusable or different-chain references always fail.',
      'A policy pass does not establish freshness, trust, or uptime. Observed statuses and errors are unchanged.',
    ],
  };
}
