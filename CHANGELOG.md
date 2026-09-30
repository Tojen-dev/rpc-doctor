# Changelog

## 0.1.0 — 2026-09-30

- Compare EVM RPC latency, errors, chain IDs, and relative block lag.
- Report median and nearest-rank p95 from successful samples.
- Print readable tables or versioned JSON, without exposing endpoint URLs.
- Load endpoints from arguments or an environment variable.
- Try three synthetic local endpoints with `--demo`.
- Bound concurrency, request timeouts, sample counts, and response sizes.
- Test protocol failures and CLI behavior without external providers.
