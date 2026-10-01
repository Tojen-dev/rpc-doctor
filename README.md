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
  "timeout": 3000
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

The file must be a regular file of at most 64 KiB. Only `endpoints`, `samples`, and
`timeout` are allowed at the top level; all are optional. A settings-only file such
as `{"samples": 10}` works with CLI or environment URLs. If present, `endpoints`
must contain 1–20 entries with distinct HTTP(S) URLs. Unknown fields at either
level, wrong types, userinfo/fragments, and missing environment references are
errors. `samples` must be an integer from 1 to 100; `timeout` is an integer from
1 to 60000 milliseconds. JSON strings are not accepted as numeric settings.

| Input | Priority, highest first |
| --- | --- |
| Endpoint list | Positional URLs → config `endpoints` → `RPC_DOCTOR_ENDPOINTS_JSON` |
| Endpoint names | Explicit `--label` list → selected config endpoint labels → `RPC N` |
| Samples / timeout | Explicit CLI option → config value → 5 / 5000 ms |

Endpoint lists are replaced as a whole, never merged. Config names are discarded
when positional URLs replace config endpoints; they never label environment URLs.
Explicit `--label` values rename the entire selected list and must match its count.
An unused `RPC_DOCTOR_ENDPOINTS_JSON` is ignored. An explicitly supplied config is
always fully validated, including environment references and overridden settings,
before any RPC request. CLI overrides do not hide config errors.

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
| Lag | Difference from the highest observed same-chain peer; unknown for a lone endpoint |
| Status | Healthy when all samples pass and observed lag is at most 3 blocks; degraded on partial failure or larger lag; unreachable when no usable samples exist |

Failed calls do not enter latency statistics. Their counts and categories remain
visible in the report. A failed chain handshake produces zero block samples.
`healthy` describes this observation window, **not** a security or uptime guarantee.

These are client-observed timings, including network and provider overhead. The
chain handshake usually establishes the connection before measured samples. There
are no retries. Up to four endpoints run concurrently; later endpoints may observe
later blocks. Relative lag is approximate, not a synchronized or trusted chain-head
measurement. A single endpoint, or peers that are all behind, cannot establish freshness.
Five samples make a quick check, not a statistically robust p95 benchmark.

## Options and exit codes

| Option | Default | Range / behavior |
| --- | --- | --- |
| `--config <file>` | None | Explicit JSON file, at most 64 KiB; incompatible with `--demo` |
| `--samples <n>` | 5 | 1–100 samples per endpoint |
| `--timeout <ms>` | 5000 | 1–60000 ms per complete request, including body |
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
