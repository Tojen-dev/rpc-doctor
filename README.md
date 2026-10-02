# RPC Doctor

[![CI](https://github.com/Tojen-dev/rpc-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/Tojen-dev/rpc-doctor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Which RPC is fast, which is falling behind, and which is failing?**

RPC Doctor compares EVM JSON-RPC endpoints from your machine and produces a readable
table or a JSON report. Zero runtime dependencies. No wallet, API key, or internet
connection is needed for the demo. Requires **Node.js 22+**.

## Try it

```sh
git clone https://github.com/Tojen-dev/rpc-doctor.git
cd rpc-doctor
node bin/rpc-doctor.js --demo
```

The demo starts three short-lived loopback servers: fast, behind, and intermittently
rate-limited. Example output below is synthetic; timings vary by machine.

```text
RPC Doctor · local demo (synthetic endpoints)

Endpoint  Chain  Status    OK   Median  p95     Block  Lag
RPC 1     1      healthy   5/5  7.0ms   7.6ms   256    0
RPC 2     1      degraded  5/5  37.6ms  37.9ms  250    6
RPC 3     1      degraded  4/5  17.8ms  17.9ms  256    0
```

## Compare your endpoints

```sh
node bin/rpc-doctor.js --samples 10 --timeout 3000 \
  https://your-first-rpc.example \
  https://your-second-rpc.example
```

Replace the example URLs with your provider endpoints. Local nodes are supported.
The only methods sent in v0.1 are `eth_chainId` and `eth_blockNumber`.
No transaction submission or signing is performed.

For endpoint URLs containing credentials, populate `RPC_DOCTOR_ENDPOINTS_JSON` via
your secret manager or local environment. It must be a JSON array of URL strings.
Positional URLs take precedence over the environment variable.

```sh
# Once RPC_DOCTOR_ENDPOINTS_JSON is set:
node bin/rpc-doctor.js --samples 10 --json > report.json
```

Environment input keeps URLs out of command arguments. Do not paste actual keys
into commands saved in shell history. Reports use `RPC 1`, `RPC 2`, etc. by default,
in input order; they never include endpoint URLs or raw provider error messages.
Environment variables remain accessible to processes with sufficient local permissions.

To name endpoints, repeat `--label <name>` once for each URL, in the same order:

```sh
node bin/rpc-doctor.js --label "Primary node" --label "Backup node" \
  https://your-first-rpc.example https://your-second-rpc.example

# The same labels work with URLs already set in RPC_DOCTOR_ENDPOINTS_JSON:
node bin/rpc-doctor.js --label "Primary node" --label "Backup node" --json
```

If any labels are supplied, their count must match the selected URL list. Positional
URLs still take precedence over environment URLs. Table rows and JSON `endpoint`
fields use the same labels and preserve input order, even when probes finish out of
order or fail. With `--demo`, provide three labels or none.

Labels are public report text: use descriptive names, never secrets or URLs.
URL-shaped labels are rejected without echoing their contents. Control characters
(including terminal and Unicode format controls) become spaces; whitespace is
collapsed and trimmed. Each resulting name must contain 1–64 Unicode code points.
Invalid labels produce exit code `2` before any RPC request.

Optional local installation, from the cloned repository:

```sh
npm install --global .
rpc-doctor --help
```

This project is distributed through GitHub; no npm registry release is required.

## Local configuration

Use `--config FILE` to load a UTF-8 JSON file explicitly. There is no automatic
config search, code execution, `.env` loading, or variable interpolation. Paths are
relative to the current working directory. Start with
[`examples/rpc-doctor.json`](examples/rpc-doctor.json):

```json
{
  "endpoints": [
    { "label": "Primary node", "urlEnv": "PRIMARY_RPC_URL" },
    { "label": "Local node", "url": "http://127.0.0.1:8545" }
  ],
  "samples": 10,
  "timeout": 3000,
  "concurrency": 4,
  "lagThreshold": 3
}
```

Set `PRIMARY_RPC_URL` through your environment or secret manager before running:

```sh
node bin/rpc-doctor.js --config examples/rpc-doctor.json --json
```

Each endpoint requires a public `label` and exactly one of `url` or `urlEnv`.
`urlEnv` names an environment variable containing the **entire URL**; its name must
match `[A-Za-z_][A-Za-z0-9_]*`, and its value must be non-empty. Keep secret URLs in
the environment, not the file. Labels follow the same sanitization rules as
`--label`. No paths, environment variable names/values, or raw JSON contents appear
in config error messages.

The file must be a regular file of at most 64 KiB. Only `endpoints`, `samples`,
`timeout`, `concurrency`, `lagThreshold`, and `reference` are allowed at the top
level; all are optional. A settings-only file such as `{"samples": 10}` works with
CLI or environment URLs. If present, `endpoints`
must contain 1–20 entries with distinct HTTP(S) URLs. Unknown fields at either
level, wrong types, userinfo/fragments, and missing environment references are
errors. `samples` must be an integer from 1 to 100; `timeout` is an integer from
1 to 60000 milliseconds; `concurrency` is an integer from 1 to 20. `lagThreshold`
is an integer from 0 to 9007199254740991; `reference` is an integer index from 1 to
the selected endpoint count. JSON strings are not accepted as numeric settings.

| Input | Priority, highest first |
| --- | --- |
| Endpoint list | Positional URLs → config `endpoints` → `RPC_DOCTOR_ENDPOINTS_JSON` |
| Endpoint names | Explicit `--label` list → selected config endpoint labels → `RPC N` |
| Samples / timeout | Explicit CLI option → config value → 5 / 5000 ms |
| Concurrency | Explicit `--concurrency` → config `concurrency` → 4 |
| Lag threshold | Explicit `--lag-threshold` → config `lagThreshold` → 3 blocks |
| Reference | Explicit `--reference` → config `reference` → same-chain peer maximum |

Endpoint lists are replaced as a whole, never merged. Config names are discarded
when positional URLs replace config endpoints; they never label environment URLs.
Explicit `--label` values rename the entire selected list and must match its count.
An unused `RPC_DOCTOR_ENDPOINTS_JSON` is ignored. An explicitly supplied config is
always fully validated, including environment references and overridden settings,
before any RPC request. CLI overrides do not hide config errors.

Reference indices always address the **selected** URL list, including when
positional URLs replace config endpoints. The config reference must also fit that
list even when `--reference` overrides it. To return to peer-maximum mode, omit
`--reference` and remove `reference` from the config.

`--demo` rejects `--config` and still ignores environment URLs. After argument
parsing, `--help` and `--version` exit without reading a config file or resolving
environment references. Without `--config`, existing CLI behavior is unchanged.

## What the report means

| Field | Meaning |
| --- | --- |
| Chain | Decimal chain ID from a separate handshake |
| OK | Successful block-number samples / attempted samples |
| Median | Median latency of successful block-number calls |
| p95 | Nearest-rank 95th percentile of successful calls |
| Block | Highest block observed during the run, stored without integer precision loss |
| Lag | Non-negative block difference from the same-chain peer maximum, or the explicit reference; unknown when comparison is unavailable |
| Status | Healthy when all samples pass and lag is within the threshold (default 3); degraded on partial failure, larger lag, or an unavailable/different-chain explicit reference; unreachable when no usable samples exist |

Failed calls do not enter latency statistics. Their counts and categories remain
visible in the report. A failed chain handshake produces zero block samples.
`healthy` describes this observation window, **not** a security or uptime guarantee.

These are client-observed timings, including network and provider overhead. The
chain handshake usually establishes the connection before measured samples. There
are no retries. By default, up to four endpoints run concurrently; later endpoints
may observe later blocks. Relative lag is approximate, not a synchronized or trusted chain-head
measurement. A single endpoint, or peers that are all behind, cannot establish freshness.
Five samples make a quick check, not a statistically robust p95 benchmark.

Use `--concurrency <n>` (1–20) to bound simultaneous RPC requests, including both
chain handshakes and block samples. Each endpoint's requests remain sequential;
a worker moves to the next endpoint only after completing its current probe.
Failures and timeouts release the worker without retries or hiding failed attempts.
Aborting a timed-out request cannot guarantee that a remote provider stops processing it.
Results and labels stay in input order regardless of completion order.

For example, `node bin/rpc-doctor.js --demo --concurrency 1` probes the demo endpoints
one at a time. A limit above the number of endpoints is accepted and creates no
extra requests. The table summary and existing JSON `settings.concurrency` field
report the effective worker count: the smaller of the selected limit and endpoint
count. `schemaVersion` remains `1`.

## Lag policy

`--lag-threshold <n>` sets the maximum allowed lag, including the exact boundary.
Zero requires a peer to be at least as high as the comparison baseline. The value
must be a non-negative safe integer (at most 9007199254740991). Block heights and
differences are calculated with `BigInt`, including heights above that limit.

Without `--reference`, the baseline remains the highest successful block observed
among available same-chain endpoints. A lone endpoint has unknown lag; successful
requests can still be `healthy`, which does not establish freshness.

Use `--reference <n>` to select one endpoint by its **1-based input index**, not its
label or completion order. For example:

```sh
node bin/rpc-doctor.js --demo --reference 1 --lag-threshold 6 --json
```

The reference is usable when its chain handshake and at least one block sample
succeed. Its highest successful block is the baseline even after partial sample
failures; those failures and its `degraded` status remain visible. A successful
sample does not establish that the reference is current or trustworthy.

| Explicit-reference case | Lag / JSON `lagStatus` | Result status |
| --- | --- | --- |
| Same-chain peer at or below reference | Exact difference / `compared` | Degraded only if above threshold or samples failed |
| Peer above reference | `0` / `ahead` | Request failures still determine degradation |
| Reference itself, including a one-endpoint run | Unknown / `reference` | Based on request success only; freshness unverified |
| Reference has no usable chain/block | Unknown / `reference_unavailable` for usable peers | Peers remain usable but degraded; no fallback to another endpoint |
| Peer belongs to another chain | Unknown / `different_chain` | Degraded; never compare across networks or fall back to that chain's peers |
| Endpoint has no usable chain/block | Unknown / `no_data` | Unreachable, with its own errors retained |

Unknown lag is JSON `null` and table `—`. Reference mode adds a table `Lag check`
column, JSON `settings.reference`, and per-result `lagStatus`; these fields are
absent without an explicit reference. `peerCount` still counts other usable
same-chain endpoints, regardless of the chosen baseline. Successful samples,
latencies, labels, and input order are preserved even when lag cannot be checked.
Exit codes are unchanged: a completed run with usable but degraded endpoints
still exits `0`; `1` means all endpoints failed. The settings report the selected
threshold; reports never include endpoint URLs.

## Options and exit codes

| Option | Default | Range / behavior |
| --- | --- | --- |
| `--config <file>` | None | Explicit JSON file, at most 64 KiB; incompatible with `--demo` |
| `--samples <n>` | 5 | 1–100 samples per endpoint |
| `--timeout <ms>` | 5000 | 1–60000 ms per complete request, including body |
| `--concurrency <n>` | 4 | 1–20 simultaneous RPC requests; CLI overrides config; works with `--demo` |
| `--lag-threshold <n>` | 3 | Maximum allowed lag; integer from 0 to 9007199254740991 |
| `--reference <n>` | Peer maximum | 1-based index in selected URL list; same-chain comparisons only, no fallback |
| `--label <name>` | `RPC N` | Repeat once per endpoint in input order; 1–64 characters after normalization |
| `--json` | Off | JSON only on stdout; `schemaVersion: 1` |
| `--demo` | Off | Synthetic local endpoints; ignores environment URLs |
| `--help`, `-h` | | Usage |
| `--version`, `-v` | | Version |

Supply 1–20 distinct HTTP(S) URLs. URL userinfo, fragments, and redirects are refused.
Response bodies are limited to 1 MiB. Each healthy endpoint receives one handshake
plus the configured number of samples. Respect your provider's request allowance.

Exit `0`: run completed with at least one usable endpoint (others may be degraded).
Exit `1`: all endpoints failed. Exit `2`: invalid input or a runtime error.
Exit `130`: interrupted with Ctrl+C.

## Development

```sh
npm ci
npm run check
npm test
```

Tests use local HTTP servers; no paid provider or internet access is required.
CI runs on Node.js 22 and 24. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[development roadmap](docs/ROADMAP.md) for the next features.

Protocol reference: [Ethereum JSON-RPC API](https://ethereum.org/developers/docs/apis/json-rpc/).

## License

[MIT](LICENSE).
