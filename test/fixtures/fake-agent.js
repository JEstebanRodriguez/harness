#!/usr/bin/env node
// A stand-in for a coding agent. It reads the prompt file it is pointed at and writes
// the expected output for that phase. Behaviour is driven by environment variables:
//   FAKE_CLASSIFICATION  JSON for the classify phase
//   FAKE_FAIL_REVIEWS    how many reviews fail before one passes (default 0)
//   FAKE_ESCALATE_TO     lane to escalate to during the first build
//   FAKE_SILENT_PHASE    phase id for which the agent writes nothing
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const kickoff = process.argv.slice(2).join(' ');
const promptRel = /Read the file (\S+)/.exec(kickoff)[1];
const prompt = readFileSync(promptRel, 'utf8');
const phase = /phase `([\w-]+)`/.exec(prompt)[1];
const output = /\*\*Your output \(exact path\):\*\* `([^`]+)`/.exec(prompt)[1];
const taskFolder = /\*\*Task folder:\*\* `([^`]+)\/`/.exec(prompt)[1];

appendFileSync('.fake-agent.log', `${phase}\n`);
if (process.env.FAKE_SILENT_PHASE === phase) process.exit(0);

const write = (file, content) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};

const counter = join(taskFolder, '.reviews');
switch (phase) {
  case 'classify':
    write(output, process.env.FAKE_CLASSIFICATION);
    break;
  case 'build': {
    const flag = join(taskFolder, '.escalated');
    if (process.env.FAKE_ESCALATE_TO && !existsSync(flag)) {
      write(flag, '1');
      write(join(taskFolder, 'escalation.json'), JSON.stringify({ to: process.env.FAKE_ESCALATE_TO, reason: 'needs a schema change' }));
      break;
    }
    write('feature.txt', `built in ${phase}\n`);
    write(output, '# Build Report\n\nStatus: DONE\n');
    break;
  }
  case 'review': {
    const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    write(counter, String(n + 1));
    const fail = n < Number(process.env.FAKE_FAIL_REVIEWS ?? 0);
    write(output, `# Audit\n\n- **Status:** ${fail ? 'FAILED' : 'PASSED'}\n\n## Required Action\n1. add tests\n`);
    break;
  }
  default:
    write(output, `# ${phase}\n\ncontent for ${phase}\n`);
}
