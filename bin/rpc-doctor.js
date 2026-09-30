#!/usr/bin/env node
import { main } from '../src/cli.js';

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  process.exit(2);
});
process.once('SIGINT', () => process.exit(130));
process.exitCode = await main(process.argv.slice(2), process.env, process.stdout, process.stderr);
