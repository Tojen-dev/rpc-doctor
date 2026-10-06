# RPC Doctor

[![CI](https://github.com/Tojen-dev/rpc-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/Tojen-dev/rpc-doctor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Which RPC is fast, which is falling behind, and which is failing?**

RPC Doctor compares EVM JSON-RPC endpoints from your machine and produces a readable
table, a JSON report, or CSV. Zero runtime dependencies. No wallet, API key, or internet
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

Endpoint  Chain  Status    OK   Median  p95     Latency n  Stddev  p99     Block  Lag  Observed (ms)
RPC 1     1      healthy   5/5  7.0ms   7.6ms   5          0.3ms   7.6ms   256    0    40–199
RPC 2     1      degraded  5/5  37.6ms  37.9ms  5          0.2ms   37.9ms  250    6    40–230
RPC 3     1      degraded  4/5  17.8ms  17.9ms  4          0.1ms   17.9ms  256    0    40–210
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

The optional CI flags `--strict` and `--max-failures` are **CLI-only**. Config
fields named `strict` or `maxFailures` are rejected as unknown, even when the
corresponding CLI flags are present.

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
| Latency n | Number of successful measured calls used for all latency statistics; excludes failures and preparation |
| Stddev | Population standard deviation in milliseconds, with divisor `n`; null / `—` when `n=0` |
| p99 | Nearest-rank 99th percentile of successful measured calls; equals max when `0 < n < 100` |
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
Five samples make a quick check, not a statistically robust p95 or p99 benchmark.

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

## Latency variability and sample size

All latency statistics use only **successful measured `eth_blockNumber` calls**.
JSON adds `results[].latencySampleCount` (the same count as `successes`),
`results[].latencyMs.stddev`, `results[].latencyMs.p99`, and top-level
`latencyNotes`, an array of interpretation notes also printed below the table.
These are additive fields under `schemaVersion: 1`; `min`, `median`, `p95`, `max`,
attempts, errors, statuses, and exit codes keep their existing meanings. The table
inserts `Latency n`, `Stddev`, and `p99` after `p95`.

For raw successful latencies `x1…xn` and their arithmetic mean `mean`, standard
deviation is `sqrt(sum((xi - mean)^2) / n)`. This is the **population** standard
deviation of the observed successes, using divisor `n`, with no `n - 1` sample
correction. It describes this run, not an estimate of provider-wide variability.
When `n=0`, all latency statistics are JSON `null` and table `—`. When `n=1`,
standard deviation is `0` and p99 is that one latency; zero deviation does not
establish stability. Identical samples also give zero deviation.

p99 uses **nearest rank**: sort the unrounded successful latencies, then select
one-based rank `ceil(0.99 * n)`, without interpolation. For `0 < n < 100`, p99
is the observed maximum. With 100 successes it is the second-highest value
(which can equal the maximum when tied). The 100-attempt limit and failures can
leave very little tail information: short samples cannot reliably estimate tails,
and even 100 successes do not establish a reliable p99 estimate. Read `Latency n`
and the failure counts alongside every percentile; a fast successful subset can
coexist with many failed attempts.

Calculations use the full, unrounded latency values. Only the final statistics
are rounded to two decimal places in JSON; the table displays them to one decimal
place. Handshake, warm-up, failed calls, worker waits, and pacing delays never
enter the latency distribution. Their time still contributes to whole-run elapsed
time, and failures remain separately visible. Computing these statistics sends no
additional requests and does not change health or exit-code decisions.

For example, successful latencies `[10, 30, 20, 40]` ms give `latencySampleCount: 4`
and `latencyMs: {min: 10, median: 25, p95: 40, max: 40, stddev: 11.18, p99: 40}`.
The population variance is 125 ms². Any other failed attempts are counted in
`attempts` and `errors`, never included in that four-value distribution.

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

The table ends with `Observed (ms)`, plus
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
means `unreachable`. By default, exit `0`/`1` depends only on measured successes;
with `--strict`, any warm-up failure also fails the health policy.

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
Default exit codes depend on usable results: a completed run with usable but
degraded endpoints exits `0`; `1` means no endpoints yielded usable block samples.
The optional strict policy below additionally checks failures and observed lag.
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

With the guard enabled and default exit policy, exit `0` means at least one endpoint
on the expected chain returned a successful block sample, even if others mismatched or failed. Exit `1`
means none did: all mismatches, all failures, or any mixture of those. This does
not make a mismatch a network outage. Invalid arguments/config remain exit `2`.
Without the guard, behavior and report fields remain unchanged; `expectedChain`,
`networkStatus`, and the `Network` column are absent. `schemaVersion` remains `1`.

## Optional strict health policy for CI

`--strict` evaluates **every selected endpoint** after the entire benchmark. It
prints the full table or JSON report, then exits `0` if the policy passes or `1`
if it fails. Without this flag, exit behavior and report fields stay unchanged:
one successful measured endpoint is enough for exit `0`, regardless of other
failures. Invalid input or runtime errors remain exit `2`; Ctrl+C remains `130`.
A failed health check does not write a usage error to stderr.

```sh
# Demo has a lagging endpoint and partial failures: prints the report, exits 1.
node bin/rpc-doctor.js --demo --strict --json

# Five measured attempts: allow one failure per endpoint and lag up to six blocks.
node bin/rpc-doctor.js --demo --strict --samples 5 --max-failures 1 --lag-threshold 6
```

There is one additional tolerance, **`--max-failures N`**, default `0`. It requires
`--strict` and accepts unsigned decimal digits representing an integer **0–100**.
Signs, whitespace, fractions, exponent notation, and non-finite values are
invalid. The limit is a **count per endpoint**, not a percentage or a pool shared
between endpoints: `attempts - successes <= N` passes that check, including the
exact boundary. Handshake and warm-up failures are not measured attempts and
cannot be allowed by this count. Even `N=100` cannot make an endpoint with zero
successful measured samples pass. A limit greater than the configured sample
count is permitted and has the same all-fail safeguard.

The existing `--lag-threshold` supplies the other limit, in **blocks**, also
inclusive: known lag must be `<= lagThreshold`. Comparisons retain exact integer
precision. CLI overrides config for that existing setting; its default is 3.
`--strict` and `--max-failures` themselves are CLI-only, with no config fields.
All explicit config is still validated even when CLI settings override it.

| Observed outcome | Strict policy |
| --- | --- |
| Failed or invalid chain handshake | Fail, even if other endpoints work |
| Rejected expected network (`mismatch`) | Fail; no block requests are added |
| No successful measured block samples | Fail, regardless of the allowance or warm-up successes |
| Partial measured failures | Pass this check only when their count is at most `maxFailures`; status stays `degraded` and errors stay visible |
| Any warm-up failure | Fail, even if all measured calls succeed |
| Known lag above / exactly at threshold | Fail / pass this check, respectively |
| Lone usable endpoint on its chain, without a reference | Unknown lag is **unchecked**, not a policy failure; successful requests cannot prove freshness |
| Selected reference itself, including a single-endpoint run | Its lag is unchecked; its own request failures still undergo the same policy |
| Unavailable or mismatched reference | Fail for that reference and affected usable peers; no fallback |
| Peer on a different chain from the selected reference | Fail; no cross-chain comparison |
| Peer ahead of a usable reference | Lag remains 0; request checks still apply |

Every applicable check must pass. Thus an allowance can let a `degraded` endpoint
pass for partial measured failures, but cannot excuse its warm-up errors, excess
lag, or reference problem. A reference with partial successes retains its observed
baseline and can pass within the measured-failure allowance. Without an explicit
reference, separate chains use only their own peers; a lone endpoint on each
chain has unchecked lag. Use `--expected-chain` when a specific network is required.

**Passing checks RPC outcomes and available relative lag, not trusted freshness.**
Unknown lag never becomes zero. A chosen reference may itself be stale, and even
same-chain peers can all be behind. The report explicitly lists unchecked lag;
the policy does not guarantee current blocks, trust, uptime, or representative
latency. It does not use rounded success rates or latency percentiles as health
thresholds and does not change observed statuses, RPC count/order, concurrency,
warm-up, rounds, pacing, retries, or latency statistics.

Strict reports retain `schemaVersion: 1` and add only top-level `healthPolicy`:

| Field | Meaning |
| --- | --- |
| `mode` / `maxFailures` | `"strict"` and the effective measured-failure allowance per endpoint |
| `passed` | Boolean used for exit `0` / `1` after the complete report is written |
| `violations` | All failed checks in endpoint order, each with 1-based `endpointIndex`, stable `code`, and safe explanatory `message`; empty on pass |
| `uncheckedLagEndpoints` | 1-based indices of endpoints with measured successes but null lag, including unusable-reference cases that also have violations |
| `notes` | Policy definitions and interpretation limits, also printed in the table |

Violation codes are `HANDSHAKE_FAILED`, `NETWORK_MISMATCH`, `NO_MEASURED_SUCCESS`,
`MEASURED_FAILURES`, `WARMUP_FAILURES`, `LAG_EXCEEDED`, `REFERENCE_UNAVAILABLE`,
`REFERENCE_MISMATCH`, and `REFERENCE_DIFFERENT_CHAIN`. One endpoint can have multiple
violations; these are policy checks, not extra RPC errors. The table appends a
`Strict policy: PASS/FAIL` summary, limits, endpoint-specific reasons, and any
unchecked lag indices. Endpoint URLs and raw provider messages remain omitted.
The existing report and error categories remain available in both formats.

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
| `--strict` | Off | CLI-only: evaluate every endpoint using the strict CI policy after reporting |
| `--max-failures <n>` | 0 | CLI-only, requires `--strict`; 0–100 failed measured calls allowed per endpoint, inclusive |
| `--json` | Off | JSON only on stdout; `schemaVersion: 1`; conflicts with `--csv`/`--markdown` |
| `--csv` | Off | CLI-only: fixed-column endpoint CSV; conflicts with `--json`/`--markdown` |
| `--markdown` | Off | CLI-only: shareable Markdown report; conflicts with `--json`/`--csv` |
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

Exit `0`: by default, at least one usable endpoint; with `--strict`, every policy check passed.
Exit `1`: by default, no usable block samples; with `--strict`, at least one policy violation.
Both completed outcomes print the full report, including failed attempts and policy reasons.
Exit `2`: invalid input or a runtime error.
Exit `130`: interrupted with Ctrl+C.

## CSV export

Use the CLI-only `--csv` flag to export one aggregate row per endpoint, in input
order. `--csv` and `--json` conflict in either order, before config reads or RPC;
the conflict also takes precedence over help/version. Otherwise `--csv --help`
and `--csv --version` retain their early, network-free behavior. There is no
config field for choosing CSV. The default remains the table.

```sh
node bin/rpc-doctor.js --demo --csv > report.csv
# With RPC_DOCTOR_ENDPOINTS_JSON already set:
node bin/rpc-doctor.js --samples 10 --csv > report.csv
```

CSV changes output only. Requests, calculations, statuses, strict policy, and exit
codes remain the same. Default all-failure and strict-failure runs still print the
complete CSV before exit `1`. Input/runtime errors exit `2` with a safe diagnostic
on stderr and no fabricated CSV report; Ctrl+C remains `130`. Preserve the command's
exit code in CI rather than inferring success from a readable CSV file.

The byte format is UTF-8 without a BOM, comma-separated, with one header and **42
fields in every record**. Every field is double-quoted; embedded quotes are doubled,
and embedded CR/LF remain inside the quoted field. Records end with CRLF, including
the final record, with no extra blank record. The CSV follows the quoting and record
conventions in [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180). No banner, commentary,
error footer, or `sep=` line is inserted into stdout. CLI labels still undergo the
existing whitespace/control normalization before CSV formatting, so a newline in
a supplied label becomes a space.

### Columns, in fixed order

Names and positions below are the CSV contract. Consumers should select by header
name. Run-level settings/metadata repeat on each endpoint row. Numeric values use
dot decimals without units or percent signs; latency statistics retain JSON's
precision instead of the table's one-decimal display.

| # | Column | Meaning / units |
| --- | --- | --- |
| 1 | `endpoint_index` | 1-based position in the selected endpoint list |
| 2 | `endpoint` | Public, normalized label, with the formula protection below |
| 3 | `chain_id` | Exact decimal chain string; empty if handshake failed |
| 4 | `status` | Existing healthy/degraded/unreachable/mismatch status |
| 5 | `network_status` | match/mismatch/unknown; empty when expected-chain guard is off |
| 6 | `attempts` | Measured block calls attempted |
| 7 | `successes` | Successful measured block calls |
| 8 | `success_rate_pct` | Successful measured calls as percent, 0–100 |
| 9 | `latency_sample_count` | Number of successes used for latency statistics |
| 10 | `latency_min_ms` | Minimum successful-call latency in ms |
| 11 | `latency_median_ms` | Median successful-call latency in ms |
| 12 | `latency_p95_ms` | Nearest-rank p95 in ms |
| 13 | `latency_p99_ms` | Nearest-rank p99 in ms |
| 14 | `latency_max_ms` | Maximum successful-call latency in ms |
| 15 | `latency_stddev_ms` | Population standard deviation in ms, divisor n |
| 16 | `latest_block` | Exact highest successful measured block, decimal text |
| 17 | `lag_blocks` | Exact known non-negative relative lag, decimal text; empty when unknown |
| 18 | `peer_count` | Other usable same-chain endpoints |
| 19 | `handshake_errors` | JSON category/count object for handshake failures |
| 20 | `sample_errors` | JSON category/count object for measured failures |
| 21 | `warmup_attempts` | Unmeasured warm-up calls attempted; empty when disabled |
| 22 | `warmup_successes` | Successful warm-up calls; empty when disabled |
| 23 | `warmup_duration_ms` | Complete warm-up elapsed ms; empty when disabled |
| 24 | `warmup_errors` | JSON category/count object; empty when warm-up disabled |
| 25 | `reference_index` | Selected 1-based reference index; empty in peer-maximum mode |
| 26 | `lag_status` | Existing reference comparison reason; empty without explicit reference |
| 27 | `expected_chain` | Exact expected chain decimal text; empty when guard is off |
| 28 | `lag_threshold_blocks` | Inclusive known-lag threshold in blocks |
| 29 | `samples` | Requested measured attempts per accepted endpoint |
| 30 | `timeout_ms` | Timeout per complete RPC request in ms |
| 31 | `concurrency` | Effective concurrent worker count |
| 32 | `warmup_requested` | Configured warm-up calls per accepted endpoint; empty at zero/off |
| 33 | `interval_ms` | Minimum interval between round starts; empty at zero/off |
| 34 | `pacing_wait_ms` | Actual total explicit pacing wait; empty at zero/off interval |
| 35 | `started_at` | UTC ISO run-start timestamp |
| 36 | `generated_at` | UTC ISO report-generation timestamp |
| 37 | `duration_ms` | Whole-run elapsed ms, including preparation and waits |
| 38 | `demo` | true for the local synthetic demo; empty otherwise |
| 39 | `strict_passed` | **Whole-run** strict result, true/false; empty if disabled |
| 40 | `strict_max_failures` | Allowed measured failures per endpoint; empty if strict disabled |
| 41 | `strict_violations` | JSON array of this endpoint's policy violation codes, in report order; empty if strict disabled |
| 42 | `strict_lag_check` | compared, unchecked, or no_samples; empty if strict disabled |

A quoted empty cell (`""`, parsed as an empty string) represents JSON null or an
absent/disabled field. It does not mean zero, false, pass, or known freshness.
Real numeric zero is `"0"`, and a real boolean false is `"false"`. For example,
unknown lag is empty while a measured zero lag is `0`; a positive interval with
no required wait has `pacing_wait_ms=0`, whereas disabled pacing leaves it empty.
Enabled but skipped warm-up has zero attempts/successes/time and an empty error
object, so it is distinguishable from disabled warm-up.

Error cells use compact JSON objects with category keys sorted in ascending order,
for example `{"HTTP_ERROR":1,"TIMEOUT":2}` after CSV parsing. Parse that cell as JSON
if category counts are needed. `{}` means no recorded error in that phase; no error
category is invented for a network mismatch. The report's existing `errors` map
belongs entirely to the handshake when `chainId` is null, or to measured calls
otherwise: a failed handshake prevents measurement. Warm-up errors stay separate.
Only sanitized categories/counts are exported, never URLs, headers, raw provider
messages or arbitrary extra report properties.

With strict mode enabled, `strict_violations=[]` means this endpoint has no policy
violations. It does **not** mean the entire run passed: consult `strict_passed`,
which is repeated unchanged on all rows. `strict_lag_check=unchecked` identifies a
successful endpoint whose lag was not checked; `no_samples` means no successful
measured sample. `compared` means relative lag was available, not that it passed
the threshold or that the node is current. Strict pass with unknown lag retains
its existing interpretation; CSV never substitutes a zero lag or a freshness claim.

CSV omits individual observations, round boundaries, narrative latency/policy
notes, and verbose policy messages. Use `--json` for those details, the versioned
schema, or lossless access to labels without CSV formula protection. Short samples
still cannot reliably estimate tails; p99 equals max below 100 successes. Relative
lag and a strict pass still do not establish trusted freshness or uptime.

### Spreadsheet import and formula protection

Quoting alone does not prevent spreadsheet formulas. Before quoting, the CSV
formatter prepends an ASCII apostrophe to text beginning with `=`, `+`, `-`, `@`
or their full-width equivalents, including after leading whitespace, Unicode
control or format characters. Leading tab/CR/LF within that prefix also triggers
protection. This applies centrally to every selected string cell. For example,
`=1+1` becomes `'=1+1`; an ordinary CSV parser sees that added apostrophe as data.
Ordinary labels keep their text, and JSON/table labels are unaffected. Commas and
quotes cannot create extra cells because quoting/doubling is applied afterward.

Import using your spreadsheet's text/CSV import dialog with UTF-8 and comma as the
delimiter. Explicitly select **Text** for public labels, `chain_id`, `latest_block`,
`lag_blocks`, and `expected_chain` (or all columns), and disable formula/type
auto-detection when available. Exact decimal strings are never converted through
JavaScript Number by the exporter, but spreadsheet auto-detection can still round
large integers or reinterpret text; CSV double quotes do not enforce a cell type.
Do not use `="digits"` formulas to preserve identifiers.

The apostrophe reduces formula interpretation risk; it is not a universal safety
guarantee. Applications, locales, import options, and save/reopen operations can
handle or remove prefixes differently. Do not remove protection before opening
untrusted labels in a spreadsheet. The protection is not a general secret detector
or sanitizer for other contexts. See [OWASP's CSV injection guidance](https://owasp.org/www-community/attacks/CSV_Injection)
for spreadsheet-specific limitations.

## Markdown report

Use the CLI-only `--markdown` flag for a standalone report suitable for a GFM
(GitHub Flavored Markdown) viewer. Save stdout with shell redirection:

```sh
node bin/rpc-doctor.js --demo --markdown > report.md
# Read private endpoints from RPC_DOCTOR_ENDPOINTS_JSON as above.
node bin/rpc-doctor.js --samples 10 --warmup 1 --markdown > report.md

# Preserve the health exit code while saving the complete report.
health_exit=0
node bin/rpc-doctor.js --demo --strict --markdown > report.md || health_exit=$?
```

`--markdown`, `--csv`, and `--json` are mutually exclusive in any order. Conflicts
return exit `2` before config or endpoint environment reads and before RPC calls,
including when combined with help/version. Otherwise `--markdown --help` and
`--markdown --version` exit early without reading config or contacting endpoints.
There is no `markdown` config field. No output-path option is provided; shell
redirection creates/truncates its destination before the CLI runs, including when
the CLI later rejects invalid input.

The formatter uses the completed, sanitized in-memory report. It adds no requests,
retries, measurements, or health decisions. Default table output, JSON schema
version 1, CSV columns, concurrency, pacing, statistics, and exit policy are
unchanged. Completed runs print the full report on exit `0` or `1`, including
all-failed runs and strict failures. Invalid usage/runtime errors remain exit `2`
with safe stderr and no fabricated report; Ctrl+C remains exit `130` without a
partial Markdown report.

The report includes:

- Actual UTC start/generation timestamps, elapsed milliseconds, a synthetic-demo
  marker, requested samples, per-request timeout, and effective concurrency.
- Handshake, expected-chain guard, warm-up and measured-round semantics; configured
  pacing and actual wait; round boundaries and each endpoint's observation window.
- Input-ordered endpoints, exact decimal chain/block/lag values, measured
  successes/attempts, success rate, status, network guard, peers, and lag checks.
- Successful measured latency n/min/median/p95/p99/max/population stddev, with
  short-sample limitations and all measurement exclusions explained.
- Separate sanitized handshake, sample, and warm-up error category/count summaries,
  including warm-up attempts/successes and elapsed time. Partial failures stay visible.
- Expected chain, lag threshold and reference policy, with unavailable references,
  self-reference, different chains and unknown lag distinguished. Relative agreement
  does not prove freshness, trust, or uptime.
- Strict PASS/FAIL, inclusive maximum failures and lag limits, every violation
  code/message, and all endpoints whose lag remains unchecked. Disabled strict
  mode has no PASS/FAIL decision.

An em dash (`—`) means unknown/unavailable, while `Disabled` means the feature was
not enabled. Actual zero values remain zero. Warm-up `0/0` with zero elapsed time
means enabled but skipped; `None` errors means no recorded errors, including in
skipped phases, and does not imply success. Endpoint windows include failed
attempts and waits between rounds, and use elapsed client time rather than provider
timestamps. Measurements are not synchronized. Full per-attempt blocks, errors,
and timing details remain available in JSON. Markdown is a human report, not a
versioned machine schema; use JSON or CSV for programmatic consumption.

### Text escaping and sharing

Every dynamic text field (including labels, notes, statuses and diagnostics) uses
one plain-text escape function. Controls, format characters and line separators
become spaces; whitespace collapses and is trimmed, matching existing label
normalization. Unicode text is retained. ASCII punctuation becomes character
references (`&amp;` for ampersands, numeric references for other punctuation).
This protects pipes, backticks, backslashes, brackets, parentheses, HTML syntax,
links/images, headings/lists and bare URL/email autolinks without altering the
displayed normalized label. Literal entity-like labels such as `&lt;` remain
literal text. Raw Markdown contains escapes that a GFM renderer displays as the
original punctuation; avoid decoding entities before parsing the Markdown.

The approach follows GFM's [character-reference rules](https://github.github.com/gfm/#entity-and-numeric-character-references).
Tests use pinned [Marked](https://marked.js.org/using_advanced#options) with GFM
enabled to check displayed text, table structure and the absence of active links,
images or HTML. Marked is a **development-only** dependency; the CLI remains free
of runtime dependencies. Other renderers and services can add their own processing,
so preview the destination's rendering when sharing.

The projection omits endpoint URLs, headers, raw provider messages and arbitrary
extra report properties. Public labels still need care: escaping prevents markup
interpretation, not disclosure of secrets someone puts in a label. Reports also
contain public measurement results and run timestamps.

## Published JSON report schema

The stable repository and package path is
[`schemas/report-v1.schema.json`](schemas/report-v1.schema.json). This is a
**report** schema, not a configuration schema. It declares
[JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12/json-schema-core)
and identifies itself with
[`$id`](https://raw.githubusercontent.com/Tojen-dev/rpc-doctor/main/schemas/report-v1.schema.json).
All references inside it are local; validation requires no RPC or schema downloads.
Pin the schema file to a repository commit when reproducible validation matters.

After installing development dependencies in the source checkout:

```sh
npm ci --ignore-scripts
node bin/rpc-doctor.js --demo --json > report.json
npm run validate:report -- report.json
npm run test:schema
```

The validation helper returns `0` for a valid report structure, `1` for a schema
violation, and `2` for unreadable/malformed JSON or a tool/usage error. These are
**validator** codes, not the benchmark's health result. A benchmark exit `1` still
writes a complete report that can validate successfully. Keep the benchmark's
exit code separately when using strict policy in CI:

```sh
# The synthetic demo normally fails the default strict limits.
health_exit=0
node bin/rpc-doctor.js --demo --strict --json > report.json || health_exit=$?
npm run validate:report -- report.json
# health_exit contains the benchmark result; validation does not replace it.
```

The source helper uses pinned [Ajv](https://ajv.js.org/json-schema.html) in strict
Draft 2020-12 mode, with no coercion, default insertion, or removal of unknown
fields. Ajv is a **devDependency**: using a complete validator avoids maintaining
a partial implementation of the standard. Runtime CLI imports and dependencies
are unchanged. Package consumers can load the shipped schema into their own
Draft 2020-12 validator; use `ajv/dist/2020.js` with Ajv 8. The source-only helper
requires development dependencies and is not part of the installed CLI.

### Version 1 compatibility

All report objects allow unknown **additional fields**, which consumers should
ignore unless understood. Existing fields are still validated even when unknown
fields are present. The exception is an `errors` map: its keys are the documented
closed set of error categories and its values must be positive integer counts.
Status, network/lag status, and strict violation codes are also closed enums.
Unknown `schemaVersion` values, wrong known-field types, and out-of-bound values
are rejected. Unknown fields do not weaken the rules on known fields.

The required baseline is `schemaVersion: 1`, `generatedAt`, `durationMs`,
`settings`, and 1–20 `results`. Settings require `samples`, `timeoutMs`,
`concurrency`, and `lagThreshold`. Each result requires `endpoint`, `chainId`,
`latestBlock`, `attempts`, `successes`, `errors`, `latencyMs`, `successRate`,
`lagBlocks`, `peerCount`, and `status`. Latency objects require `min`, `median`,
`p95`, and `max`. Required nullable fields must be present with `null` when unknown;
absence and zero do not substitute for null.

Later additions are optional for compatibility: `startedAt`, `rounds`,
`observations`, `latencyNotes`, `latencySampleCount`, `stddev`, `p99`, and
`healthPolicy`. Reference/network/warm-up/pacing fields and `demo` are optional
because they depend on selected options. **Every known field is checked when
present**; an optional object still needs its required members. Current output
omits warm-up/pacing settings at zero; if present, `warmup` and `intervalMs` must
be positive. `pacingWaitMs` may be zero. `demo`, when present, is `true`.

Independent historical fixtures cover the original CLI (`c3a1358`), the warm-up
stage (`e1fc349`), and the variability stage (`4c01814`). See
[fixture descriptions](examples/reports/README.md) for their provenance and exact
coverage; no blanket compatibility claim is made for every historical revision.
All fixtures are synthetic, with fixed illustrative timings rather than live
measurements, and are included in the package with the schema.

Future v1 additions must be optional fields whose absence preserves old meanings.
Removing/renaming a required field, changing a known field's type, unit, null
meaning or semantics, changing limits/enums to allow previously invalid values,
or requiring new fields needs a **new `schemaVersion` and a new schema path**.
The compatibility schema does not enforce that every latest feature is present;
consumers that need rounds or strict results must explicitly require them after
validation. An omitted feature is not proof of either an old producer or success.

### What validation proves

The schema checks structure, required members, types, local numeric bounds, enums,
and canonical unsigned decimal strings. Chain IDs, blocks, and lags remain exact
**strings**, including values larger than `Number.MAX_SAFE_INTEGER`; convert to
`BigInt` only for arithmetic. Nulls are accepted only in documented nullable
locations. Observed quantities are not limited to machine integer size.

It does **not** prove cross-field consistency: counts versus attempts/settings,
error sums, success rates or percentiles, nulls versus success counts, block/lag
arithmetic, chain agreement, option/feature co-occurrence, chronological ordering,
round counts, endpoint indices versus the actual list length, or `healthPolicy`
booleans/reasons versus measured results. Expected-chain strings are canonical
and at most 78 digits; the exact `2^256−1` bound remains a semantic check. Timestamp
patterns check UTC ISO syntax with milliseconds, not calendar validity. No rounding
precision or provider observation is certified by schema validation.

A structurally valid report can describe degraded, unreachable, or mismatched
endpoints, and can contain inconsistent arithmetic if supplied by another producer.
Validity does not establish health, block freshness, authenticity, or safe text.
Escape labels/messages for your output context; validation is not sanitization,
secret detection, or permission to execute content. The CLI's existing redaction
and health checks remain separate from this consumer-facing structural contract.

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
