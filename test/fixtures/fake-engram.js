#!/usr/bin/env node
// Stand-in for the engram CLI. Logs every call to $FAKE_ENGRAM_LOG (one JSON array per line).
//   FAKE_ENGRAM_FAIL=1   every command exits 1 with "database is locked"
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_ENGRAM_LOG) appendFileSync(process.env.FAKE_ENGRAM_LOG, `${JSON.stringify(args)}\n`);
if (process.env.FAKE_ENGRAM_FAIL) {
  process.stderr.write('database is locked\n');
  process.exit(1);
}
const project = args.includes('--project') ? args[args.indexOf('--project') + 1] : 'detected-project';
switch (args[0]) {
  case 'save':
    console.log(`Memory saved: #42 "${args[1]}" (${project})`);
    break;
  case 'search':
    console.log(project === 'xjergx-global' ? 'No memories found.' : `[1] #7 (decision) Exports usan streaming — matched "${args[1]}" in ${project}`);
    break;
  case 'context':
    console.log(`## Recent sessions (${project})\n- codex: Core del export listo\n## Recent observations\n- #7 Exports usan streaming`);
    break;
  case 'timeline':
    console.log(`#${args[1]} Exports usan streaming\n200k filas superan 512MB`);
    break;
  case 'setup':
    console.log(`Configured ${args[1]}`);
    break;
  default:
    console.log('ok');
}
