// Development helper; the benchmark CLI never imports Ajv or this script.
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';

try {
  if (process.argv.length !== 3) throw new Error();
  const schema = JSON.parse(await readFile(new URL('../schemas/report-v1.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
  if (validate(report)) console.log('Valid RPC Doctor v1 report structure (not a health check).');
  else {
    // Do not echo paths, user-controlled property names, or report values.
    console.error('Invalid RPC Doctor v1 report structure.');
    process.exitCode = 1;
  }
} catch {
  console.error('Unable to validate. Usage: npm run validate:report -- <report.json> (requires npm ci).');
  process.exitCode = 2;
}
