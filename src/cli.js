import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { benchmark } from './benchmark.js';
import { runDemo } from './demo.js';
import { formatTable } from './format.js';
import { ConfigError, loadConfig } from './config.js';

const help = `RPC Doctor — compare EVM JSON-RPC endpoints

Usage:
  rpc-doctor [options] <url> [url ...]
  rpc-doctor --config <file> [options]
  rpc-doctor --demo
  RPC_DOCTOR_ENDPOINTS_JSON='["https://your-rpc.example"]' rpc-doctor

Options:
  --config <file>     Read an explicit JSON config (at most 64 KiB; no auto-search)
  --samples <n>       Block-number samples per endpoint, 1–100 (default: 5)
  --timeout <ms>      Timeout per request, 1–60000 (default: 5000)
  --concurrency <n>   Maximum simultaneous RPC requests, 1–20 (default: 4)
  --label <name>      Repeat once per endpoint, in input order (default: RPC N)
  --json             Write a versioned JSON report
  --demo             Compare three synthetic local endpoints
  --help, -h         Show help
  --version, -v      Show version

At most 20 endpoints; requests per endpoint stay sequential. No transactions sent.
Concurrency includes handshakes and samples; it also applies to --demo.
Use environment input for API-key URLs to avoid storing them in shell history.
Labels also name environment URLs; with --demo, supply three labels or none.
Labels are public text: use names, never secrets or URLs. Use 1–64 characters.
Control characters become spaces; whitespace is collapsed and trimmed.
URLs: positional > config endpoints > RPC_DOCTOR_ENDPOINTS_JSON.
Samples/timeout/concurrency: CLI > config > defaults. --label replaces all selected labels;
config labels apply only to config URLs, otherwise the default is RPC N.
Config fields: endpoints [{label, url OR urlEnv}], samples, timeout (ms), concurrency.
Unknown fields and missing/empty environment references are errors, even if overridden.
--demo cannot be combined with --config. Help/version do not read config files.
Exit codes: 0 = completed; 1 = all endpoints failed; 2 = invalid usage/runtime error.
`;

export async function main(args, env, stdout, stderr) {
  try {
    let parsed;
    try {
      parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
        config: { type: 'string' }, samples: { type: 'string' }, timeout: { type: 'string' },
        concurrency: { type: 'string' },
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
    if ([values.samples, values.timeout].some((value) => value !== undefined && !/^\d+$/.test(value))) {
      throw new Error('Samples and timeout must be positive integers.');
    }
    if (values.concurrency !== undefined && (values.concurrency.length === 0 || /\D/.test(values.concurrency))) {
      throw new Error('Concurrency must be an integer from 1 to 20.');
    }
    let endpoints = positionals;
    if (values.demo && endpoints.length) throw new Error('Use --demo without endpoint URLs.');
    if (values.demo && values.config !== undefined) throw new Error('Use --demo without --config.');
    const config = values.config === undefined ? {} : await loadConfig(values.config, env);
    const options = {
      samples: values.samples === undefined ? config.samples ?? 5 : Number(values.samples),
      timeoutMs: values.timeout === undefined ? config.timeoutMs ?? 5000 : Number(values.timeout),
      concurrency: values.concurrency === undefined ? config.concurrency ?? 4 : Number(values.concurrency),
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
    const report = values.demo ? await runDemo(options) : await benchmark(endpoints, options);
    stdout.write((values.json ? JSON.stringify(report, null, 2) : formatTable(report)) + '\n');
    return report.results.every((result) => result.status === 'unreachable') ? 1 : 0;
  } catch (error) {
    // Only application-controlled messages are allowed; unexpected errors may contain URLs.
    const expected = /^(Use |Provide |Samples |Timeout |Concurrency |Labels |Duplicate |Invalid arguments\.|RPC_DOCTOR_ENDPOINTS_JSON)/;
    stderr.write(`RPC Doctor: ${error instanceof ConfigError || expected.test(error.message) ? error.message : 'Unable to complete the check.'}\n`);
    return 2;
  }
}
