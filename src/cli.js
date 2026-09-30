import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { benchmark } from './benchmark.js';
import { runDemo } from './demo.js';
import { formatTable } from './format.js';

const help = `RPC Doctor — compare EVM JSON-RPC endpoints

Usage:
  rpc-doctor [options] <url> [url ...]
  rpc-doctor --demo
  RPC_DOCTOR_ENDPOINTS_JSON='["https://your-rpc.example"]' rpc-doctor

Options:
  --samples <n>       Block-number samples per endpoint, 1–100 (default: 5)
  --timeout <ms>      Timeout per request, 1–60000 (default: 5000)
  --json             Write a versioned JSON report
  --demo             Compare three synthetic local endpoints
  --help, -h         Show help
  --version, -v      Show version

At most 20 endpoints; up to four are probed concurrently. No transactions sent.
Use environment input for API-key URLs to avoid storing them in shell history.
Exit codes: 0 = completed; 1 = all endpoints failed; 2 = invalid usage/runtime error.
`;

export async function main(args, env, stdout, stderr) {
  try {
    let parsed;
    try {
      parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
        samples: { type: 'string', default: '5' }, timeout: { type: 'string', default: '5000' },
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
    if (!/^\d+$/.test(values.samples) || !/^\d+$/.test(values.timeout)) {
      throw new Error('Samples and timeout must be positive integers.');
    }
    const options = { samples: Number(values.samples), timeoutMs: Number(values.timeout) };
    let endpoints = positionals;
    if (values.demo && endpoints.length) throw new Error('Use --demo without endpoint URLs.');
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
    const expected = /^(Use |Provide |Samples |Timeout |Duplicate |Invalid arguments\.|RPC_DOCTOR_ENDPOINTS_JSON)/;
    stderr.write(`RPC Doctor: ${expected.test(error.message) ? error.message : 'Unable to complete the check.'}\n`);
    return 2;
  }
}
