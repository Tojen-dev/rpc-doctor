export function endpointLabels(labels, count) {
  if (labels === undefined) return Array.from({ length: count }, (_, index) => `RPC ${index + 1}`);
  if (!Array.isArray(labels) || labels.length !== count) {
    throw new Error('Provide exactly one --label per endpoint, in input order.');
  }
  return Array.from(labels, (label) => {
    if (typeof label !== 'string') throw new Error('Labels must be strings.');
    // Neutralize terminal controls, bidi/format controls, and Unicode line separators.
    const clean = label.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (clean.length === 0 || Array.from(clean).length > 64) {
      throw new Error('Labels must contain 1–64 characters after whitespace normalization.');
    }
    if (/https?\s*:|[a-z][a-z\d+.-]*:\s*\/\s*\/|www\./iu.test(clean)) {
      throw new Error('Labels must be names, not URLs.');
    }
    return clean;
  });
}
