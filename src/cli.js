import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { benchmark } from './benchmark.js';
import { runDemo } from './demo.js';
import { formatTable } from './format.js';
import { ConfigError, loadConfig } from './config.js';
import { HealthPolicyError, parseHealthPolicy, evaluateHealthPolicy } from './health-policy.js';

const help = `RPC Doctor — compare EVM JSON-RPC endpoints

Usage:
  rpc-doctor [options] <url> [url ...]
  rpc-doctor --config <file> [options]
  rpc-doctor --demo
  RPC_DOCTOR_ENDPOINTS_JSON='["https://your-rpc.example"]' rpc-doctor

Options:
  --config <file>     Read an explicit JSON config (at most 64 KiB; no auto-search)
  --samples <n>       Block-number samples per endpoint, 1–100 (default: 5)
  --interval <ms>     Minimum interval between round starts, 0–60000 (default: 0)
  --warmup <n>        Unmeasured block-number calls per endpoint, 0–20 (default: 0)
  --timeout <ms>      Timeout per request, 1–60000 (default: 5000)
  --concurrency <n>   Maximum simultaneous RPC requests, 1–20 (default: 4)
  --lag-threshold <n> Allowed lag in blocks, 0–9007199254740991 (default: 3)
  --reference <n>     Reference endpoint index, starting at 1 in the selected list
  --expected-chain <id> Require a decimal or 0x-hex chain ID (optional)
  --strict           Exit 1 when any endpoint fails the CI health policy (CLI-only)
  --max-failures <n>  Allowed failed measured calls per endpoint, 0–100 (default: 0;
                     requires --strict; CLI-only)
  --label <name>      Repeat once per endpoint, in input order (default: RPC N)
  --json             Write a versioned JSON report
  --demo             Compare three synthetic local endpoints
  --help, -h         Show help
  --version, -v      Show version

At most 20 endpoints; requests per endpoint stay sequential. No transactions sent.
Concurrency includes handshakes, warm-up, and samples; it also applies to --demo.
All endpoints finish preparation before sampling begins. Each measured round sends
one call per accepted endpoint and waits for all outcomes before the next round.
Interval uses the previous round's actual start, after its completion barrier;
long rounds need no extra wait. No catch-up, initial wait, or final wait is added.
Pacing counts in Elapsed and observation offsets, never in RPC latency.
Slow endpoints delay all peers; observations are not synchronized.
JSON records round boundaries and each attempt's start/finish in elapsed client ms
from startedAt; the table shows each endpoint's first-start to last-finish window.
Warm-up follows the network guard; failures and elapsed ms are reported separately.
Maximum requests per endpoint: 1 + warmup + samples. No retries.
Use environment input for API-key URLs to avoid storing them in shell history.
Labels also name environment URLs; with --demo, supply three labels or none.
Labels are public text: use names, never secrets or URLs. Use 1–64 characters.
Control characters become spaces; whitespace is collapsed and trimmed.
URLs: positional > config endpoints > RPC_DOCTOR_ENDPOINTS_JSON.
Settings: CLI > config > defaults. --label replaces all selected labels;
config labels apply only to config URLs, otherwise the default is RPC N.
Config fields: endpoints [{label, url OR urlEnv}], samples, timeout (ms), concurrency,
lagThreshold, reference, expectedChain, warmup, interval (ms). Config expectedChain must be a string.
Expected chain range: 0–2^256-1; no leading zeros, signs, or whitespace.
Mismatched endpoints keep their observed ID but receive no block samples.
Without a reference, lag uses the same-chain peer maximum.
An unavailable or different-chain reference leaves lag unknown, with no fallback.
The reference itself is not freshness-checked; endpoints ahead of it have lag 0.
Unknown fields and missing/empty environment references are errors, even if overridden.
--demo cannot be combined with --config. Help/version do not read config files.
Default exit codes: 0 = at least one usable endpoint; 1 = none usable; 2 = invalid usage/runtime error.
With --strict, every endpoint needs a measured success; failed measured calls must
be <= --max-failures and known lag <= --lag-threshold (inclusive, in blocks).
Handshake failures, mismatches, warm-up errors, and unusable/different-chain
references always fail. Partial measured failures may pass within the limit;
statuses and errors remain unchanged. The full report is printed before exit 0/1.
Unknown lag for a lone same-chain endpoint or the reference itself is unchecked,
not a failure. Passing does not establish freshness, trust, or uptime.
Strict flags are CLI-only; config validation/precedence stays unchanged.
Invalid input/runtime errors remain exit 2; Ctrl+C remains exit 130.
With expected-chain, only successful block samples on that chain count as usable.
Warm-up successes never count as usable samples or affect block/lag/latency stats.
Latency n counts successful measured calls. Stddev uses the population divisor n;
n=0 is unavailable, n=1 gives 0ms without establishing stability.
p99 uses nearest rank and equals max for 0 < n < 100. Short samples cannot reliably
estimate tails; even 100 successes give no reliability guarantee. Failures stay separate.
`;

export async function main(args, env, stdout, stderr) {
  try {
    let parsed;
    try {
      parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
        config: { type: 'string' }, samples: { type: 'string' }, timeout: { type: 'string' },
        concurrency: { type: 'string' }, warmup: { type: 'string' }, interval: { type: 'string' },
        'lag-threshold': { type: 'string' }, reference: { type: 'string' },
        'expected-chain': { type: 'string' },
        strict: { type: 'boolean' }, 'max-failures': { type: 'string' },
        label: { type: 'string', multiple: true },
        json: { type: 'boolean' }, demo: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      } });
    } catch { throw new Error('Invalid arguments. Use --help for available options.'); }
    const { values, positionals } = parsed;
    if (values.help) { stdout.write(help); return 0; }
    if (values.version) {
      const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      stdout.write(`${pkg.version}\n`);
      return 0;
    }
    const healthOptions = parseHealthPolicy({ strict: values.strict, maxFailures: values['max-failures'] });
    if ([values.samples, values.timeout].some((value) => value !== undefined && !/^\d+$/.test(value))) {
      throw new Error('Samples and timeout must be positive integers.');
    }
    if (values.concurrency !== undefined && (values.concurrency.length === 0 || /\D/.test(values.concurrency))) {
      throw new Error('Concurrency must be an integer from 1 to 20.');
    }
    if (values.warmup !== undefined && (values.warmup.length === 0 || /\D/.test(values.warmup))) {
      throw new Error('Warm-up must be an integer from 0 to 20.');
    }
    if (values.interval !== undefined && (values.interval.length === 0 || /\D/.test(values.interval))) {
      throw new Error('Interval must be an integer from 0 to 60000 ms.');
    }
    if (values['lag-threshold'] !== undefined && (values['lag-threshold'].length === 0 || /\D/.test(values['lag-threshold']))) {
      throw new Error('Lag threshold must be an integer from 0 to 9007199254740991.');
    }
    if (values.reference !== undefined && (values.reference.length === 0 || /\D/.test(values.reference))) {
      throw new Error('Reference must be an endpoint index from 1 to the selected endpoint count.');
    }
    let endpoints = positionals;
    if (values.demo && endpoints.length) throw new Error('Use --demo without endpoint URLs.');
    if (values.demo && values.config !== undefined) throw new Error('Use --demo without --config.');
    const config = values.config === undefined ? {} : await loadConfig(values.config, env);
    const options = {
      samples: values.samples === undefined ? config.samples ?? 5 : Number(values.samples),
      warmup: values.warmup === undefined ? config.warmup ?? 0 : Number(values.warmup),
      intervalMs: values.interval === undefined ? config.intervalMs ?? 0 : Number(values.interval),
      timeoutMs: values.timeout === undefined ? config.timeoutMs ?? 5000 : Number(values.timeout),
      concurrency: values.concurrency === undefined ? config.concurrency ?? 4 : Number(values.concurrency),
      lagThreshold: values['lag-threshold'] === undefined ? config.lagThreshold ?? 3 : Number(values['lag-threshold']),
      reference: values.reference === undefined ? config.reference : Number(values.reference),
      expectedChain: values['expected-chain'] === undefined ? config.expectedChain : values['expected-chain'],
      labels: values.label,
    };
    if (endpoints.length === 0 && config.endpoints !== undefined) {
      endpoints = config.endpoints;
      options.labels ??= config.labels;
    }
    if (!values.demo && endpoints.length === 0 && env.RPC_DOCTOR_ENDPOINTS_JSON) {
      try { endpoints = JSON.parse(env.RPC_DOCTOR_ENDPOINTS_JSON); }
      catch { throw new Error('RPC_DOCTOR_ENDPOINTS_JSON must contain a JSON array of endpoint URLs.'); }
    }
    if (!values.demo && Array.isArray(endpoints) && endpoints.length === 0) {
      stderr.write(help);
      return 2;
    }
    // Config indices, like CLI indices, always refer to the selected URL list.
    // Validate explicit config even when its reference is overridden by the CLI.
    if (config.reference !== undefined && Array.isArray(endpoints) && config.reference > endpoints.length) {
      throw new ConfigError('Config reference exceeds the selected endpoint count.');
    }
    const report = values.demo ? await runDemo(options) : await benchmark(endpoints, options);
    if (healthOptions) report.healthPolicy = evaluateHealthPolicy(report, healthOptions);
    stdout.write((values.json ? JSON.stringify(report, null, 2) : formatTable(report)) + '\n');
    if (healthOptions) return report.healthPolicy.passed ? 0 : 1;
    return report.results.some((result) => result.successes > 0) ? 0 : 1;
  } catch (error) {
    // Only application-controlled messages are allowed; unexpected errors may contain URLs.
    const expected = /^(Use |Provide |Samples |Warm-up |Interval |Timeout |Concurrency |Lag threshold |Reference |Expected chain |Labels |Duplicate |Invalid arguments\.|RPC_DOCTOR_ENDPOINTS_JSON)/;
    stderr.write(`RPC Doctor: ${error instanceof ConfigError || error instanceof HealthPolicyError || expected.test(error.message) ? error.message : 'Unable to complete the check.'}\n`);
    return 2;
  }
}
