import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadBacklog, findTask, now } from './backlog.js';
import { LANES, CLASSIFY_PHASE, currentPhase } from './lanes.js';
import { findRepos } from './preflight.js';
import { overview, rememberHandoff, backendOf } from './memstore.js';
import { codegraphStatus } from './tools.js';
import { DEFAULT_CONFIG } from './config.js';
import { collectSkills } from './catalog.js';
import { display, taskDir } from './paths.js';

/**
 * Cross-agent session continuity.
 *
 * Everything another agent needs to pick up the work lives in files:
 *  - .xjergx/session.json   last handoff, written on purpose (commit it: it travels with the repo)
 *  - .xjergx/activity.json  last activity, written by hooks after every turn (git-ignored)
 *  - .xjergx/sessions/      one Markdown journal entry per handoff
 *  - tasks/<ID>/progress-<phase>.md  in-phase notes, see prompt.js
 * `xjergx resume` turns them into a brief any agent can read at session start.
 */

export const KNOWN_AGENTS = ['claude', 'codex', 'opencode', 'pi', 'omp'];

/** Best effort: which coding agent is running us. XJERGX_AGENT always wins. */
export function detectAgent(env = process.env) {
  if (env.XJERGX_AGENT) return env.XJERGX_AGENT;
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (env.OPENCODE || env.OPENCODE_SESSION_ID) return 'opencode';
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_MANAGED_BY_NPM) return 'codex';
  if (env.OMP_SESSION_ID || env.OH_MY_PI) return 'omp';
  if (env.PI_CODING_AGENT || env.PI_SESSION_ID) return 'pi';
  return 'unknown';
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * handoff → .xjergx/session.json (deliberate, meant to be committed so it travels with the repo)
 * activity → .xjergx/activity.json (automatic, every turn, git-ignored)
 */
export function loadSession(paths) {
  return { handoff: readJson(paths.session)?.handoff ?? null, activity: readJson(paths.activity) };
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  // trimEnd only: porcelain lines start with a significant space (" M file").
  return res.status === 0 ? res.stdout.trimEnd() : null;
}

/** Branch, HEAD and modified files of every repo in the workspace. */
export function gitSnapshot(root) {
  let repos = [];
  try {
    repos = findRepos(root);
  } catch {
    return [];
  }
  return repos.map((repo) => {
    const changes = (git(repo, ['status', '--porcelain']) ?? '')
      .split('\n')
      .filter(Boolean)
      .filter((l) => !l.slice(3).startsWith('.xjergx/'));
    return {
      repo: display({ root }, repo) || '.',
      branch: git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
      head: git(repo, ['rev-parse', '--short', 'HEAD']),
      changes: changes.map((l) => l.trim()),
    };
  });
}

function activeTaskInfo(paths) {
  let data;
  try {
    data = loadBacklog(paths);
  } catch {
    return null;
  }
  const task = findTask(data);
  const blocked = data.tasks.filter((t) => t.status === 'blocked');
  if (!task) return { task: null, blocked, total: data.tasks.length };
  const phase = currentPhase(task);
  return { task, phase, blocked, total: data.tasks.length };
}

/**
 * Record where the work stands so another agent (or you, later) can continue.
 * @param {{ summary?: string, next?: string[], open?: string[], agent?: string, auto?: boolean }} input
 */
export function handoff(paths, input, config = DEFAULT_CONFIG) {
  if (!input.auto && !input.summary?.trim()) throw new Error('El handoff necesita --summary "qué se hizo y dónde quedó".');
  const agent = input.agent || detectAgent();
  const at = now();
  const repos = gitSnapshot(paths.root);
  const info = activeTaskInfo(paths);
  const ticket = info?.task ? { id: info.task.id, lane: info.task.lane, status: info.task.status } : null;

  const activity = { at, agent, ticket, repos: repos.map(({ repo, branch, head, changes }) => ({ repo, branch, head, changed: changes.length })) };
  writeJson(paths.activity, activity);
  if (input.auto) return { handoff: null, journal: null };

  const h = {
    at,
    agent,
    summary: input.summary.trim(),
    next: (input.next ?? []).map((s) => s.trim()).filter(Boolean),
    open: (input.open ?? []).map((s) => s.trim()).filter(Boolean),
    ticket,
    repos: activity.repos,
  };
  writeJson(paths.session, { handoff: h });

  mkdirSync(paths.sessions, { recursive: true });
  const journal = join(paths.sessions, `${at.replace(/[:.]/g, '-')}-${agent}.md`);
  const journalText = [
    `# Handoff · ${agent} · ${at}`,
    '',
    h.ticket ? `Ticket: ${h.ticket.id} (${h.ticket.lane ?? 'sin carril'} · ${h.ticket.status})` : 'Ticket: ninguno activo',
    '',
    '## Summary',
    h.summary,
    '',
    '## Next steps',
    ...(h.next.length ? h.next.map((s) => `- ${s}`) : ['- (none)']),
    '',
    '## Open questions',
    ...(h.open.length ? h.open.map((s) => `- ${s}`) : ['- (none)']),
    '',
    '## Repos',
    ...repos.map((r) => `- ${r.repo}: ${r.branch}@${r.head}, ${r.changes.length} uncommitted change(s)`),
    '',
  ].join('\n');
  writeFileSync(journal, journalText);
  const warning = rememberHandoff({ paths, config }, h, journalText);
  return { handoff: h, journal, warning };
}

/** Did anything happen after the handoff? (Hooks record activity every turn, even when nothing changed.) */
function workChangedSince(h, activity) {
  if (activity.agent !== h.agent) return true;
  const key = (r) => `${r.repo}|${r.branch}|${r.head}|${r.changed}`;
  const before = new Set((h.repos ?? []).map(key));
  return (activity.repos ?? []).some((r) => !before.has(key(r)));
}

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/**
 * Markdown brief for the agent starting a session. Read-only: never advances the workflow.
 * @param {string} [agent] who is resuming (to point out a switch of tool)
 */
export function resumeBrief(paths, { agent, config = DEFAULT_CONFIG } = {}) {
  const me = agent || detectAgent();
  const { handoff: h, activity } = loadSession(paths);
  const repos = gitSnapshot(paths.root);
  const info = activeTaskInfo(paths);
  const out = [];

  out.push('# xjergx · session context');
  out.push('');
  out.push('This project uses the xjergx harness. Work, memory, skills and agents are shared across coding agents');
  out.push('(Claude Code, Codex, OpenCode, Pi, omp): another agent may have started what you are about to continue.');
  out.push('');

  out.push('## Where things were left');
  if (h) {
    const who = h.agent === me ? `${h.agent} (this same tool)` : `**${h.agent}**`;
    out.push(`Last handoff by ${who}, ${ago(h.at)} (${h.at}):`);
    out.push('');
    out.push(h.summary.split('\n').map((l) => `> ${l}`).join('\n'));
    if (h.next.length) {
      out.push('');
      out.push('Next steps:');
      for (const s of h.next) out.push(`- ${s}`);
    }
    if (h.open.length) {
      out.push('');
      out.push('Open questions for the user:');
      for (const s of h.open) out.push(`- ${s}`);
    }
    if (activity && Date.parse(activity.at) > Date.parse(h.at) && workChangedSince(h, activity)) {
      out.push('');
      out.push(`⚠ There was later activity by **${activity.agent}** (${ago(activity.at)}) without a new handoff: check \`git diff\` and the task progress notes before trusting the steps above.`);
    }
  } else if (activity) {
    out.push(`No handoff written yet. Last activity: **${activity.agent}**, ${ago(activity.at)}. Check \`git diff\` and the task progress notes.`);
  } else {
    out.push('No previous session recorded.');
  }
  out.push('');

  out.push('## Backlog');
  if (!info) {
    out.push('No backlog yet (`xjergx init`).');
  } else if (!info.task) {
    out.push(info.total ? 'Nothing pending: every ticket is completed or blocked.' : 'The backlog is empty.');
  } else {
    const { task, phase } = info;
    const lane = task.lane ? LANES[task.lane].name : 'not classified yet';
    out.push(`Active ticket **${task.id}** — ${task.description}`);
    out.push(`- Lane: ${lane}${task.laneReasons.length ? ` (${task.laneReasons.join('; ')})` : ''}`);
    if (task.awaitingApproval) {
      out.push(`- Waiting for the user to approve \`${task.awaitingApproval.artifact}\` (\`xjergx approve\` / \`xjergx reject --note\`).`);
    } else {
      out.push(`- Next phase: \`${phase === CLASSIFY_PHASE ? 'classify' : phase.id}\` (agent \`${phase.agent}\`)`);
      const progress = join(taskDir(paths, task.id), `progress-${phase.id}.md`);
      if (existsSync(progress)) {
        out.push(`- This phase was already started: read \`${display(paths, progress)}\` and continue from it.`);
      }
    }
    out.push('- Continue the ticket with `xjergx next --json`.');
  }
  for (const t of info?.blocked ?? []) out.push(`- Blocked: ${t.id} — ${t.blockedReason}`);
  out.push('');

  if (repos.length) {
    out.push('## Repositories');
    for (const r of repos) {
      out.push(`- \`${r.repo}\`: branch \`${r.branch}\` @ ${r.head}, ${r.changes.length} uncommitted change(s)`);
      for (const c of r.changes.slice(0, 8)) out.push(`  - ${c}`);
      if (r.changes.length > 8) out.push(`  - … ${r.changes.length - 8} more`);
    }
    out.push('');
  }

  const mem = overview({ paths, config });
  const backend = backendOf({ config });
  out.push('## Memory');
  out.push(backend.name === 'engram'
    ? 'Backend: **Engram** (shared by every agent configured with `engram setup`; its MCP tools `mem_search` / `mem_save` work too).'
    : 'Backend: Markdown files in `.xjergx/memory/` (Engram not available).');
  if (mem.engram) {
    out.push('');
    out.push('Recent Engram context:');
    out.push('```');
    out.push(mem.engram);
    out.push('```');
  }
  const records = backend.name === 'engram' ? mem.markdown.filter((m) => m.type === 'task') : mem.markdown;
  if (records.length) {
    out.push('');
    out.push(backend.name === 'engram' ? 'Ticket records in the repo:' : `${records.length} entr${records.length === 1 ? 'y' : 'ies'}. Most recent:`);
    for (const m of records.slice(0, 6)) out.push(`- [${m.type}] ${m.title} \`${m.id}\``);
  } else if (!mem.engram) {
    out.push('Empty.');
  }
  if (mem.warning) out.push(`⚠ ${mem.warning}`);
  out.push('Search before deciding: `xjergx memory search "<terms>"` · read one: `xjergx memory show <id>`.');
  const cg = codegraphStatus(config, paths.root);
  if (cg.enabled) {
    out.push('');
    out.push('Code navigation: **codegraph** is available. Use `codegraph_explore` / `codegraph_context` to find symbols, callers and impact before reading files one by one.');
  }
  out.push('');

  const skills = collectSkills(paths);
  if (skills.length) {
    out.push('## Shared skills');
    for (const s of skills) out.push(`- \`${s.name}\`: ${s.description.split('\n')[0].slice(0, 140)}`);
    out.push('');
  }

  out.push('## Protocol');
  out.push('- Durable lessons (decisions, conventions, gotchas, reusable assets): `xjergx memory add "<title>" --body "..." --type <type>`.');
  out.push(`- Before the session ends, or when the user wants to switch tools: \`xjergx handoff --agent ${me === 'unknown' ? '<your-tool>' : me} --summary "..." --next "..." --open "..."\`.`);
  out.push('');
  return out.join('\n');
}
