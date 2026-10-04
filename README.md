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

Endpoint  Chain  Status    OK   Median  p95     Block  Lag  Observed (ms)
RPC 1     1      healthy   5/5  7.0ms   7.6ms   256    0    40–199
RPC 2     1      degraded  5/5  37.6ms  37.9ms  250    6    40–230
RPC 3     1      degraded  4/5  17.8ms  17.9ms  256    0    40–210
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
  "interval": 0,
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
`timeout`, `concurrency`, `lagThreshold`, `reference`, `expectedChain`, `warmup`, and `interval` are
allowed at the top level; all are optional. A settings-only file such as `{"samples": 10}` works with
CLI or environment URLs. If present, `endpoints`
must contain 1–20 entries with distinct HTTP(S) URLs. Unknown fields at either
level, wrong types, userinfo/fragments, and missing environment references are
errors. `samples` must be an integer from 1 to 100; `timeout` is an integer from
1 to 60000 milliseconds; `concurrency` is an integer from 1 to 20; `warmup` is an
integer from 0 to 20; `interval` is an integer from 0 to 60000 milliseconds. `lagThreshold`
is an integer from 0 to 9007199254740991; `reference` is an integer index from 1 to
the selected endpoint count. Those settings require JSON numbers. `expectedChain`
is a string identifier, using the decimal or hex format described below; JSON
numbers are not accepted for chain IDs, even when they are small.

| Input | Priority, highest first |
| --- | --- |
| Endpoint list | Positional URLs → config `endpoints` → `RPC_DOCTOR_ENDPOINTS_JSON` |
| Endpoint names | Explicit `--label` list → selected config endpoint labels → `RPC N` |
| Samples / timeout | Explicit CLI option → config value → 5 / 5000 ms |
| Round interval | Explicit `--interval` → config `interval` → 0 ms |
| Warm-up | Explicit `--warmup` → config `warmup` → 0 |
| Concurrency | Explicit `--concurrency` → config `concurrency` → 4 |
| Lag threshold | Explicit `--lag-threshold` → config `lagThreshold` → 3 blocks |
| Reference | Explicit `--reference` → config `reference` → same-chain peer maximum |
| Expected chain | Explicit `--expected-chain` → config `expectedChain` → no network guard |

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
| Block | Highest block from successful measured samples, stored without integer precision loss |
| Lag | Non-negative block difference from the same-chain peer maximum, or the explicit reference; unknown when comparison is unavailable |
| Status | Healthy when samples pass and lag is within the threshold; degraded on partial failure, warm-up errors, larger lag, or unusable reference; unreachable when probing fails; mismatch when the observed network is rejected by the optional guard |
| Observed (ms) | First measured request start through last finish, in client milliseconds from run start; includes failed attempts and gaps between rounds; `—` means no measured attempts |

Failed calls do not enter latency statistics. Their counts and categories remain
visible in the report. A failed chain handshake produces zero block samples.
`healthy` describes this observation window, **not** a security or uptime guarantee.

These are client-observed timings, including network and provider overhead. The
chain handshake usually establishes the connection before measured samples. There
are no retries. By default, up to four endpoints run concurrently within each
round; queued endpoints may observe later blocks. Relative lag is approximate, not a synchronized or trusted chain-head
measurement. A single endpoint, or peers that are all behind, cannot establish freshness.
Five samples make a quick check, not a statistically robust p95 benchmark.

Use `--concurrency <n>` (1–20) to bound simultaneous RPC requests, including
chain handshakes, optional warm-up, and block samples. Each endpoint's requests remain sequential.
A preparation worker finishes one endpoint's handshake and warm-up before moving
to the next endpoint. Measured workers instead perform one attempt per endpoint
per round, with a barrier after preparation and after every round.
Failures and timeouts release the worker without retries or hiding failed attempts.
Aborting a timed-out request cannot guarantee that a remote provider stops processing it.
Results and labels stay in input order regardless of completion order.

For example, `node bin/rpc-doctor.js --demo --concurrency 1` prepares the demo endpoints
one at a time, then samples RPC 1, RPC 2, RPC 3 in each round. A limit above the number of endpoints is accepted and creates no
extra requests. The table summary and existing JSON `settings.concurrency` field
report the effective worker count: the smaller of the selected limit and endpoint
count. `schemaVersion` remains `1`.

## Sampling rounds and observation times

Measured sampling always runs in **rounds**. All endpoints first finish preparation:
their chain handshake, expected-chain check, and optional warm-up. A failed
handshake or network mismatch excludes that endpoint from measured rounds. Warm-up
errors remain visible and do not exclude an otherwise accepted endpoint.

Each of the `--samples` rounds then sends exactly one `eth_blockNumber` request to
every accepted endpoint, taking available worker slots in input order. The next
round starts only after every attempt in the current round succeeds or fails,
including body validation and timeouts. Failures do not remove endpoints from
later rounds, and there are no retries. By default no pacing delay is added;
`--interval` can require a minimum interval between round starts. If no endpoint
passes preparation, there are no measured rounds or pacing waits.

A fast endpoint cannot begin its second measured attempt until every accepted
endpoint finishes its first, and similarly for later rounds. This does **not**
synchronize requests or provider observations. With concurrency below the accepted endpoint count,
later endpoints still wait for a slot in each round. A slow endpoint delays the
next round for everyone; a slow preparation delays the first round. A fast
endpoint's warmed connection or cache can cool while it waits. There is no
guarantee of comparable provider state, a current reference, or a trusted head.

JSON retains `schemaVersion: 1` and all existing aggregate field names, types, and
meanings, and adds the following fields:

| Field | Meaning |
| --- | --- |
| `startedAt` | UTC ISO timestamp at run start, after input validation; `generatedAt` remains the report-generation timestamp |
| `rounds` | Ordered array of `{round, startedMs, finishedMs}` for completed rounds; empty if none were attempted |
| `results[].observations` | Ordered array with one entry per measured attempt, including failures; empty for failed handshakes and mismatches |
| Observation `round` | 1-based round number |
| Observation `startedMs` / `finishedMs` | Client start immediately before invoking RPC / finish after the full response is validated or the failure is classified |
| Observation `block` / `error` | Exact decimal block string and null error on success; null block and sanitized error category on failure |

All `startedMs` and `finishedMs` values are **elapsed milliseconds from run start**,
measured with the same monotonic clock and rounded to integers. Round times enclose
all requests and worker-queue waits in that round. Individual attempt times exclude
time waiting for a worker, preparation, and preceding rounds. Equal rounded start
and finish values are possible. The clock is independent of later wall-clock
adjustments; adding an offset to `startedAt` gives only an approximate UTC time.
These are client observations, not block timestamps or provider-side execution
times. Keep using `latencyMs` for the successful-call latency distribution: rounded
observation windows also include result validation and failure handling.

The table keeps its existing columns in order and appends `Observed (ms)`, plus
the start timestamp and completed-round count in the summary. Use `--json` for
per-attempt timing and outcomes; table column positions are for human reading.
JSON readers should allow these additive fields. Request order and observation
windows intentionally change from endpoint-at-a-time sampling.

Block remains the maximum of each endpoint's successful **measured** observations
across all rounds, even if a later block is lower. Lag still compares those maxima
within the same chain, using the selected reference or peer maximum; it is not a
per-round or simultaneous head comparison. Warm-up never contributes observations
or blocks. Partial successes, unusable references, sanitized errors, BigInt
precision, label order, and exit codes retain their existing rules.

## Interval between rounds

Use `--interval <ms>` or the config number `"interval": ms` to require a minimum
interval between the **starts of measured rounds**. The value must be a finite,
non-negative integer from **0 to 60000 milliseconds**, default `0`. CLI takes
precedence over config; `--interval 0` disables a configured interval. Invalid
explicit config is still rejected before RPC, even when overridden. The config
requires a JSON number; CLI values use unsigned decimal digits, without signs,
whitespace, fractions, or exponent notation.

```sh
node bin/rpc-doctor.js --demo --samples 3 --interval 100
node bin/rpc-doctor.js --demo --samples 3 --interval 100 --json
```

After each round's completion barrier, the next round waits only until the
previous round's **actual start + interval**. For example, a 100 ms interval with
a 30 ms round leaves about 70 ms to wait; a 150 ms round needs no extra wait.
Elapsed time uses the unrounded monotonic clock. Early timer wake-ups recheck the
deadline; late wake-ups start a later round and its next interval is measured from
that new actual start. There is no attempt to catch up to an earlier schedule.

There is no interval wait before the first round, after the last round, or when
all endpoints fail preparation or mismatch the expected chain. A single-round
run never waits for pacing. Handshakes and warm-up keep their existing scheduling;
only measured rounds are paced. RPC failures and timeouts still finish their
attempts and count toward the round's duration. A slow round or worker queue
therefore consumes the interval before an additional wait is considered.

With a positive interval, JSON adds `settings.intervalMs` and top-level
`pacingWaitMs`, the total actual time spent in explicit pacing waits, including
late timer wake-ups, rounded to integer milliseconds. The table adds a summary
line with the minimum interval and pacing wait; existing columns stay unchanged.
No pacing fields or summary line are added at zero or when omitted, and
`schemaVersion` remains `1`.

Pacing is included in whole-run `durationMs` / `Elapsed` and shifts subsequent
round and observation offsets. The table's first-start to last-finish observation
window includes those gaps. Individual round/attempt durations start **after**
their pacing wait, and RPC `latencyMs` never includes it. Warm-up duration, failure
categories, measured counts, block/lag rules, and exit codes remain unchanged.

An interval is not a per-request rate limit: up to the concurrency cap can start
together in a round. Endpoints queued within a round can start much later, and
consecutive calls to an individual endpoint need not be this far apart. Timers
and slow endpoints can make round spacing longer than requested. This does not
guarantee synchronized observations, a provider quota, or a whole-run deadline.

## Optional warm-up

Use `--warmup <n>` or the config number `"warmup": n` to send **0–20 unmeasured
`eth_blockNumber` calls per endpoint**, default `0`. CLI takes precedence over
config, including `--warmup 0` to disable configured warm-up. Invalid explicit
config values remain errors even when overridden; validation happens before RPC.

```sh
node bin/rpc-doctor.js --demo --warmup 2 --samples 10 --json
```

Each endpoint completes its `eth_chainId` handshake and expected-chain guard
first, then all warm-up calls; measured rounds wait for all endpoints to finish
preparation. A failed handshake or network mismatch skips both block phases. Requests stay sequential
per endpoint under the same concurrency cap and timeout, with the same response
validation. Request IDs are unique within each benchmark run. Warm-up errors are
recorded without retries: the remaining warm-up calls and measured samples still
run, even if every warm-up call fails.

Warm-up can reduce some connection or provider cache effects, but the handshake
already usually establishes the connection. It cannot guarantee a warm provider,
fair comparisons, or representative latency. It also consumes request quota and
time, and may itself trigger rate limits that affect subsequent measurements.
Use it only when that tradeoff suits the measurement.

With warm-up enabled, JSON adds `settings.warmup` and a `warmup` object to every
endpoint result:

| Warm-up field | Meaning |
| --- | --- |
| `attempts` / `successes` | Attempted / successful warm-up calls only |
| `errors` | Sanitized failure-category counts, including invalid responses and timeouts |
| `durationMs` | Elapsed wall-clock milliseconds for the complete warm-up phase, including failures |

Skipped warm-up has zero attempts, successes, and duration, with empty errors.
The table adds `Warm-up OK` (successes/attempts), `Warm-up elapsed` in milliseconds,
and a separate `Warm-up errors` section when needed. Whole-run `durationMs` / table
`Elapsed` includes handshake, warm-up, and measurement overhead; per-endpoint
warm-up durations can overlap under concurrency and should not be summed to infer
whole-run time.

Measured attempts, successes, success rate, errors, latency percentiles, Block,
and lag exclude all warm-up results. The existing `errors` field still includes
handshake failures. Even a higher warm-up block cannot become a lag baseline, and
warm-up success alone cannot make a reference usable. Warm-up errors produce
`degraded` status if any measured samples succeed; no successful measured sample
means `unreachable`. Exit `0`/`1` still depends only on measured successes.

At `warmup: 0`, including when the option is omitted, no extra calls or report
fields/columns are added. The JSON schema version remains `1`. The demo accepts
warm-up; its third endpoint rate-limits every third block call, counting both
phases, so warm-up can shift which measured requests fail.

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
| Same-chain peer at or below reference | Exact difference / `compared` | Degraded if above threshold, samples failed, or warm-up had errors |
| Peer above reference | `0` / `ahead` | Request failures still determine degradation |
| Reference itself, including a one-endpoint run | Unknown / `reference` | Based on request success only; freshness unverified |
| Reference has no usable chain/block | Unknown / `reference_unavailable` for usable peers | Peers remain usable but degraded; no fallback to another endpoint |
| Reference rejected by expected-chain guard | Unknown / `reference_mismatch` for usable peers | Peers remain usable but degraded; no replacement reference |
| Endpoint rejected by expected-chain guard | Unknown / `network_mismatch` | Mismatch, with its observed chain ID retained and no block samples |
| Peer belongs to another chain | Unknown / `different_chain` | Degraded; never compare across networks or fall back to that chain's peers |
| Endpoint has no usable chain/block | Unknown / `no_data` | Unreachable, with its own errors retained |

Unknown lag is JSON `null` and table `—`. Reference mode adds a table `Lag check`
column, JSON `settings.reference`, and per-result `lagStatus`; these fields are
absent without an explicit reference. `peerCount` still counts other usable
same-chain endpoints, regardless of the chosen baseline. Successful samples,
latencies, labels, and input order are preserved even when lag cannot be checked.
Exit codes still depend on usable results: a completed run with usable but degraded
endpoints still exits `0`; `1` means no endpoints yielded usable block samples.
The settings report the selected threshold; reports never include endpoint URLs.

## Expected network

Use `--expected-chain ID` to accept block samples only from a selected network.
The equivalent config field is a **string**, for example `{"expectedChain":"0x1"}`.
CLI takes precedence, but an invalid config value is still rejected before RPC.
No guard is enabled unless this option or config field is present.

The format is unsigned decimal (`0` or a nonzero digit followed by digits), or hex
with the lowercase prefix `0x` (`0x0` or a nonzero hex digit followed by hex digits).
Hex digits may be uppercase or lowercase. Leading zeros, whitespace, signs,
fractions, and exponent notation are rejected. The range is **0 through 2^256−1**;
input is limited to 78 characters. Parsing and comparison use `BigInt`, so
`9007199254740993` and `0x20000000000001` represent the same exact ID. Both the
observed `chainId` and `settings.expectedChain` are reported as decimal strings.

```sh
node bin/rpc-doctor.js --demo --expected-chain 0x1 --json
```

Only the existing `eth_chainId` handshake is used. A valid ID from another network
is retained and produces `status: "mismatch"`, not a transport failure. That
endpoint receives no `eth_blockNumber` calls: attempts/successes are zero, block
and latency values are null, and no RPC error is invented. It contributes neither
to peer counts nor to the lag baseline. Other endpoints continue normally under
the same concurrency limit and keep their original labels and order.

Guarded reports add a `Network` column and per-result `networkStatus`:

| Network result | `networkStatus` | Behavior |
| --- | --- | --- |
| Handshake ID equals expected ID | `match` | Collect samples; ordinary healthy/degraded/unreachable rules apply |
| Valid handshake ID differs | `mismatch` | Keep observed ID, mark mismatch, skip all block samples |
| Failed or invalid handshake | `unknown` | Keep the sanitized failure; chain ID is null and status is unreachable |

A matching handshake can still have failed block samples. Network mismatch is
separate from RPC errors. If the chosen reference is rejected, it stays selected:
matching peers keep their successful measurements but have unknown lag,
`lagStatus: "reference_mismatch"`, and `degraded` status. If its handshake or all
block samples fail instead, peers use `reference_unavailable`. There is no fallback.

With the guard enabled, exit `0` means at least one endpoint on the expected chain
returned a successful block sample, even if others mismatched or failed. Exit `1`
means none did: all mismatches, all failures, or any mixture of those. This does
not make a mismatch a network outage. Invalid arguments/config remain exit `2`.
Without the guard, behavior and report fields remain unchanged; `expectedChain`,
`networkStatus`, and the `Network` column are absent. `schemaVersion` remains `1`.

## Options and exit codes

| Option | Default | Range / behavior |
| --- | --- | --- |
| `--config <file>` | None | Explicit JSON file, at most 64 KiB; incompatible with `--demo` |
| `--samples <n>` | 5 | 1–100 samples per endpoint |
| `--interval <ms>` | 0 | 0–60000 ms minimum between measured round starts; no initial/final wait |
| `--warmup <n>` | 0 | 0–20 unmeasured block calls per endpoint; failures and elapsed ms reported separately |
| `--timeout <ms>` | 5000 | 1–60000 ms per complete request, including body |
| `--concurrency <n>` | 4 | 1–20 simultaneous RPC requests; CLI overrides config; works with `--demo` |
| `--lag-threshold <n>` | 3 | Maximum allowed lag; integer from 0 to 9007199254740991 |
| `--reference <n>` | Peer maximum | 1-based index in selected URL list; same-chain comparisons only, no fallback |
| `--expected-chain <id>` | None | Decimal or `0x`-hex ID, 0–2^256−1; reject other networks before block samples |
| `--label <name>` | `RPC N` | Repeat once per endpoint in input order; 1–64 characters after normalization |
| `--json` | Off | JSON only on stdout; `schemaVersion: 1` |
| `--demo` | Off | Synthetic local endpoints; ignores environment URLs |
| `--help`, `-h` | | Usage |
| `--version`, `-v` | | Version |

Supply 1–20 distinct HTTP(S) URLs. URL userinfo, fragments, and redirects are refused.
Response bodies are limited to 1 MiB. Each endpoint receives at most
**`1 + warmup + samples` requests** (one handshake, warm-up, measured samples).
Failed or mismatched handshakes stop after one request; later failures do not
reduce the configured attempt count. Warm-up adds up to `warmup × timeout` ms of
request waiting per accepted endpoint, plus processing overhead. With concurrency
`C` and `E` selected endpoints, a conservative request-time allowance remains
`ceil(E / C) × (1 + warmup + samples) × timeout` ms. When planning a paced run,
allow up to `(samples - 1) × interval` ms of additional deliberate waiting, plus
timer/scheduling/processing overhead. Long rounds consume some or all of that
interval, and no accepted endpoints means no pacing waits. Preparation and each
round have their own barrier; actual elapsed time
depends on the slowest remaining work in each phase. This is not an enforced whole-run deadline.
Respect your provider's request allowance.

Exit `0`: run completed with at least one usable endpoint (others may be degraded).
Exit `1`: no usable block samples (including mismatches when the guard is enabled).
Exit `2`: invalid input or a runtime error.
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
