# RPC Doctor development roadmap

45 coherent increments, each intended to produce a useful, reviewable commit.
The first five establish v0.1. The remaining forty grow the tool through normal
development. Each increment includes its relevant tests and documentation; do not
create empty commits or manipulate dates to meet a count.

Check an item only when its acceptance criteria pass. If a real bug blocks a step,
fix it first and record the reason; the exact commit count is a planning target.

## Foundation — v0.1

- [x] **01. Project foundation.** Runnable Node.js CLI, MIT license, syntax checks, and package metadata.
- [x] **02. JSON-RPC transport.** Validated envelopes, bounded requests, sanitized failures, and protocol tests.
- [x] **03. Comparison engine.** Latency distributions, failure counts, exact block integers, chain-aware lag, and bounded concurrency.
- [x] **04. Usable CLI.** Table/JSON output, environment input, exit codes, and a local synthetic demo with end-to-end tests.
- [x] **05. Public release baseline.** Reproducible install, CI on supported Node versions, contribution guide, and documented measurement limits.

## Configuration and fair measurements

- [x] **06. Human-readable endpoint labels.** Accept explicit names, preserve input order, and sanitize control characters without leaking URLs.
- [x] **07. Local configuration files.** Load named endpoints and settings from a validated JSON file; allow environment references for secrets; define precedence.
- [x] **08. Configurable concurrency.** Expose a bounded worker count and prove request concurrency never exceeds it.
- [x] **09. Configurable lag policy.** Support a lag threshold and explicit reference endpoint, with unavailable-reference behavior.
- [x] **10. Expected network guard.** Allow an expected chain ID and flag mismatches without comparing unrelated chains.
- [ ] **11. Explicit warm-up.** Add optional warm-up requests; separate their failures and overhead from measured samples.
- [ ] **12. Sampling rounds.** Sample peers in rounds and record observation times to reduce sequential comparison bias.
- [ ] **13. Inter-sample pacing.** Add a configurable minimum interval with elapsed-time accounting and deterministic timer tests.
- [ ] **14. Latency variability.** Report standard deviation and p99 with sample-count caveats and independently checked calculations.
- [ ] **15. Strict health exit policy.** Add opt-in failure thresholds suitable for CI while preserving current default exit codes.

## Portable reports

- [ ] **16. Published JSON schema.** Ship a schema, report fixtures, and compatibility checks for success, mixed-chain, and failure cases.
- [ ] **17. CSV export.** Emit escaped CSV with documented columns, null handling, and spreadsheet formula-injection protection.
- [ ] **18. Markdown report.** Produce a shareable report with escaped labels and an explicit measurement summary.
- [ ] **19. Atomic report files.** Add output-path support with safe overwrite semantics and no half-written reports on failure.

## RPC capabilities

- [ ] **20. Historical block probe.** Check retrieval of a user-selected historical block; distinguish null, unsupported, and error; avoid claiming full archive support.
- [ ] **21. Read-only call probe.** Support an explicit eth_call target/data/block with bounded response handling and no signing.
- [ ] **22. Bounded log probe.** Check eth_getLogs for an explicit small range and optional filter; validate ranges before requests.
- [ ] **23. Finality-tag support.** Probe safe/finalized blocks and distinguish unsupported tags from transient failures.
- [ ] **24. Node sync state.** Report eth_syncing results and validate boolean/object responses without treating missing support as healthy.
- [ ] **25. Client identification.** Expose optional web3_clientVersion with size limits and terminal-safe output.
- [ ] **26. Batch capability.** Probe JSON-RPC batching and match responses by ID regardless of order, including partial failures.
- [ ] **27. Capability summary.** Add a separate capability matrix; keep unsupported optional methods distinct from baseline health failures.

## Reliability and longer runs

- [ ] **28. Transparent retries.** Add opt-in bounded retries with backoff; retain original failures, attempts, and timing in reports.
- [ ] **29. Rate-limit handling.** Respect bounded Retry-After values and distinguish provider throttling from transport failure.
- [ ] **30. Secret headers.** Support environment-backed authorization headers without printing or storing their values in reports.
- [ ] **31. Whole-run budgets.** Enforce a total deadline and request budget; accurately label cancelled and unattempted work.
- [ ] **32. Graceful interruption.** Abort outstanding fetches, close resources, and preserve a partial report on Ctrl+C.
- [ ] **33. NDJSON streaming.** Emit individually valid endpoint/round events with a documented completion record.
- [ ] **34. Watch mode.** Repeat checks on a bounded interval without overlapping runs; support a maximum run count.
- [ ] **35. Local run history.** Store sanitized reports with configurable retention and safe handling of corrupt entries.
- [ ] **36. Regression comparison.** Compare compatible runs by label/network and flag configurable latency/error regressions.
- [ ] **37. Watch trends.** Show compact latency/error trends based on recorded observations, with gaps preserved.

## Release quality and integrations

- [ ] **38. GitHub Actions example.** Provide a workflow for checking user-supplied RPCs through repository secrets and uploading sanitized reports.
- [ ] **39. Container distribution.** Add a small non-root image and test demo execution plus signal handling.
- [ ] **40. Cross-platform CI.** Run functional checks on Linux, macOS, and Windows; fix any path, shell, or signal differences.
- [ ] **41. Installable package smoke test.** Test the packed tarball in a clean temporary project and verify executable/package contents.
- [ ] **42. Reproducible benchmark fixtures.** Add scripted delay, disconnect, regression, and mixed-network scenarios with explicit expected outcomes.
- [ ] **43. Troubleshooting guide.** Explain TLS failures, proxies, rate limits, timeouts, sample interpretation, and configuration errors with reproducible examples.
- [ ] **44. Russian quickstart.** Add a Russian guide synchronized with current options and linked from the main README.
- [ ] **45. Stable release review.** Audit CLI/schema compatibility, run the full supported-platform matrix, finish migration notes and changelog, and tag a stable release.
