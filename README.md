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
into commands saved in shell history. Reports use `RPC 1`, `RPC 2`, etc. in input
order; they never include endpoint URLs or raw provider error messages. Environment
variables remain accessible to processes with sufficient local permissions.

Optional local installation, from the cloned repository:

```sh
npm install --global .
rpc-doctor --help
```

This project is distributed through GitHub; no npm registry release is required.

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
| `--samples <n>` | 5 | 1–100 samples per endpoint |
| `--timeout <ms>` | 5000 | 1–60000 ms per complete request, including body |
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
