const MAX_CHAIN_ID = (1n << 256n) - 1n;

export function parseExpectedChain(value) {
  const invalid = () => new Error('Expected chain must be a decimal or 0x-hex string from 0 to 2^256-1, without leading zeros.');
  if (typeof value !== 'string' || value.length > 78) throw invalid();
  const match = /^(?:0|[1-9][0-9]*|0x(?:0|[1-9a-fA-F][0-9a-fA-F]*))$/.exec(value);
  // A JS $ anchor can match before a final newline; require the entire string.
  if (!match || match[0] !== value) throw invalid();
  const chainId = BigInt(value);
  if (chainId > MAX_CHAIN_ID) throw invalid();
  return chainId;
}
