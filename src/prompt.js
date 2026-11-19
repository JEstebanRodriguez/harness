import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LANES, LANE_ORDER, laneRank, CLASSIFY_PHASE } from './lanes.js';
import { outputPath, listTaskArtifacts } from './artifacts.js';
import { PACKAGE_ROOT, taskDir, display } from './paths.js';
import { parseFrontmatter } from './frontmatter.js';

/** Role prompt body: workspace override in .xjergx/agents/ wins over the bundled one. */
export function loadRole(paths, agent) {
  const candidates = [join(paths.agentOverrides, `${agent}.md`), join(PACKAGE_ROOT, 'agents', `${agent}.md`)];
  const file = candidates.find((f) => existsSync(f));
  if (!file) throw new Error(`No encuentro el prompt de rol ${agent}.md`);
  return parseFrontmatter(readFileSync(file, 'utf8'));
}

export { parseFrontmatter };

const CHECK_HELP = {
  exists: 'The file must exist and not be empty.',
  classification: 'The file must be valid JSON with exactly the fields described in your role.',
  report: 'The file must contain a line `Status: DONE` (or `Status: BLOCKED` plus a `Reason:` line if you cannot finish).',
  audit: 'The file must contain a line `Status: PASSED` or `Status: FAILED`.',
};

const MODE_HELP = {
  interactive: 'Human-in-the-loop. You MAY ask the user questions and SHOULD pause for confirmation where your role says so.',
  yolo: 'Fully autonomous. Do NOT ask the user anything. Make the most reasonable decision, and write every assumption into your output file.',
  'dry-run': 'Planning only. You may ask the user questions. The harness stops before any phase that writes application code.',
};

/**
 * Build the full instructions for one phase of one task.
 * @returns {string} markdown
 */
export function buildPrompt(ctx, task, phase) {
  const { paths } = ctx;
  const role = loadRole(paths, phase.agent);
  const out = display(paths, outputPath(paths, task, phase));
  const dir = display(paths, taskDir(paths, task.id));
  const lane = task.lane ? LANES[task.lane] : null;
  const memoryDir = display(paths, paths.memory);
  const progress = `${display(paths, taskDir(paths, task.id))}/progress-${phase.id}.md`;

  const inputs = listTaskArtifacts(paths, task.id)
    .map((f) => display(paths, f))
    .filter((f) => f !== out);

  const lines = [];
  lines.push(`# xjergx · ${task.id} · phase \`${phase.id}\``);
  lines.push('');
  lines.push('You are running one phase of the **xjergx harness**. The harness owns the workflow and the state;');
  lines.push('you own only this phase. Follow the contract below, then follow your role.');
  lines.push('');
  lines.push('## Task');
  lines.push(`- **ID:** ${task.id}`);
  lines.push(`- **Description:** ${task.description}`);
  if (lane) {
    lines.push(`- **Lane:** ${lane.name} — ${lane.title}. ${lane.summary}`);
    if (task.laneReasons.length) lines.push(`- **Why this lane:** ${task.laneReasons.join('; ')}`);
  }
  const modeHelp = phase.headless
    ? 'This phase runs without the user: do NOT ask questions; record any doubt or assumption in your output.'
    : MODE_HELP[ctx.mode];
  lines.push(`- **Execution mode:** \`${ctx.mode}\` — ${modeHelp}`);
  lines.push('');
  lines.push('## Files');
  lines.push(`- **Task folder:** \`${dir}/\``);
  lines.push(inputs.length
    ? `- **Read first (artifacts from earlier phases):** ${inputs.map((f) => `\`${f}\``).join(', ')}`
    : '- **Earlier artifacts:** none yet.');
  lines.push(`- **Project memory (engram):** \`${memoryDir}/\` — past tickets (\`tasks/\`) and notes from every agent (\`notes/\`). Search it with \`xjergx memory search "<terms>"\` (it also covers the user's global memory).`);
  lines.push(`- **Progress notes for this phase:** \`${progress}\` — if it exists, a previous session (maybe another agent) started this phase: continue from it instead of starting over.`);
  lines.push(`- **Your output (exact path):** \`${out}\``);
  lines.push('');

  if (task.feedback?.phase === phase.id) {
    lines.push('## Human feedback on your previous attempt (MUST address)');
    lines.push(`> ${task.feedback.note.replace(/\n/g, '\n> ')}`);
    lines.push('Previous versions are in the `history/` subfolder of the task folder.');
    lines.push('');
  }
  if (task.lastAudit && phase.writesCode) {
    lines.push('## Failed review to fix (MUST address)');
    lines.push(`Read \`${task.lastAudit}\` and fix every item under "Required Action". Do not redo work that already passed.`);
    lines.push('');
  }

  lines.push('## Contract with the harness');
  lines.push(`1. This phase is finished only when \`${out}\` exists. ${CHECK_HELP[phase.check]}`);
  lines.push('2. Do NOT edit `.xjergx/backlog.json` and do NOT run other phases. The harness verifies your output and moves on.');
  lines.push('3. Respect the project: read its own conventions (AGENTS.md, CLAUDE.md, CONTRIBUTING, linters, existing code) before writing anything.');
  lines.push('4. Tools such as "engram" or "codegraph" are optional. If you do not have them, use `xjergx memory search` and file search instead.');
  lines.push(`5. **Resumable work:** this phase may be continued by a different coding agent. Keep \`${progress}\` up to date as you go:`);
  lines.push('   what is done, what is left, and every decision or answer the user gave you. Durable lessons for future tickets go to');
  lines.push('   `xjergx memory add "<title>" --body "..." --type decision|convention|gotcha|asset`.');

  const heavier = task.lane ? LANE_ORDER.filter((l) => laneRank(l) > laneRank(task.lane)) : [];
  if (heavier.length && phase !== CLASSIFY_PHASE) {
    lines.push(`6. **Escalation:** if you discover the ticket is bigger or riskier than this lane allows (it changes a schema, public API or`);
    lines.push('   cross-service contract, touches auth/payments/personal data, or the scope keeps growing), stop and write');
    lines.push(`   \`${dir}/escalation.json\` with \`{"to": "${heavier.join('" | "')}", "reason": "..."}\`. The harness will move the task.`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(role.body);
  lines.push('');
  return lines.join('\n');
}

/** Write the prompt to .xjergx/prompts/<task>-<phase>.md and return its absolute path. */
export function writePrompt(ctx, task, phase) {
  mkdirSync(ctx.paths.prompts, { recursive: true });
  const file = join(ctx.paths.prompts, `${task.id}-${phase.id}.md`);
  writeFileSync(file, buildPrompt(ctx, task, phase));
  return file;
}

/** Short message handed to an agent: it points to the prompt file instead of passing kilobytes on the command line. */
export function kickoffMessage(ctx, promptFile) {
  return `Read the file ${display(ctx.paths, promptFile)} and follow its instructions exactly. It contains your role, the task and where to write your output.`;
}
