import { readFileSync } from 'node:fs';
import { addMemory, searchMemory, listMemory, findMemory } from './memory.js';
import { engramStatus, runEngram } from './tools.js';

/**
 * Memory facade used by the CLI, handoffs and the workflow.
 *
 *   Engram installed (and memory.backend ≠ "markdown") → notes and handoffs go to Engram, which every agent
 *   configured with `engram setup` also reads and writes through its MCP tools (mem_search, mem_save, ...).
 *   Otherwise, or if an engram call fails → Markdown files under .xjergx/memory (and ~/.xjergx/memory).
 *
 * Ticket records written by the archivist always stay in .xjergx/memory/tasks/ (they are task artifacts
 * and travel with the repo); when Engram is on they are also indexed there.
 *
 * @typedef {{ paths: import('./paths.js').WorkspacePaths|null, config: any }} MemCtx
 */

function cwdOf(ctx) {
  return ctx.paths?.root ?? process.cwd();
}

/** Project name passed to engram: only when configured, otherwise engram detects it from the directory. */
function projectArgs(ctx, { global } = {}) {
  if (global) return ['--project', ctx.config.memory?.globalProject ?? 'xjergx-global'];
  const p = ctx.config.memory?.engramProject;
  return p ? ['--project', p] : [];
}

export function backendOf(ctx) {
  const s = engramStatus(ctx.config);
  return { name: s.enabled ? 'engram' : 'markdown', reason: s.reason };
}

/** Body stored in Engram: metadata as plain lines (the CLI has no fields for them), then the content. */
export function engramContent({ type, tags = [], agent, task, body, title }) {
  const meta = [
    `Type: ${type}`,
    tags.length ? `Tags: ${tags.join(', ')}` : null,
    agent ? `Agent: ${agent}` : null,
    task ? `Ticket: ${task}` : null,
    'Source: xjergx',
  ].filter(Boolean);
  return `${meta.join('\n')}\n\n${(body || title).trim()}`;
}

/**
 * Save a memory.
 * @returns {{ backend: 'engram'|'markdown', id: string, scope: string, warning?: string, output?: string }}
 */
export function remember(ctx, entry) {
  const { name } = backendOf(ctx);
  if (name === 'engram') {
    if (!entry.title?.trim()) throw new Error('La memoria necesita un título.');
    const res = runEngram(['save', entry.title.trim(), engramContent(entry), ...projectArgs(ctx, entry)], { cwd: cwdOf(ctx) });
    if (res.ok) return { backend: 'engram', id: res.stdout.match(/#?(\d+)/)?.[1] ?? '', scope: entry.global ? 'global' : 'project', output: res.stdout };
    const saved = addMemory(ctx.paths, entry);
    return { backend: 'markdown', id: saved.id, scope: saved.scope, warning: `engram save falló (${res.stderr || 'sin detalle'}); lo guardé en Markdown.` };
  }
  const saved = addMemory(ctx.paths, entry);
  return { backend: 'markdown', id: saved.id, scope: saved.scope };
}

/**
 * Search everywhere: Engram (project + global) when on, plus the Markdown store
 * (ticket records, and notes from before Engram or from fallbacks).
 * @returns {{ engram: Array<{scope: string, text: string}>|null, markdown: any[], warning?: string }}
 */
export function recall(ctx, query, { limit = 10, scope } = {}) {
  const markdown = searchMemory(ctx.paths, query, { limit, scope });
  if (backendOf(ctx).name !== 'engram') return { engram: null, markdown };
  const engram = [];
  const failures = [];
  const scopes = scope ? [scope] : ['project', 'global'];
  if (!ctx.paths && !scope) scopes.splice(0, 1); // outside a workspace only the global store makes sense
  for (const sc of scopes) {
    const res = runEngram(['search', query, ...projectArgs(ctx, { global: sc === 'global' })], { cwd: cwdOf(ctx) });
    if (res.ok) {
      if (res.stdout.trim() && !/^no (results|memories|observations)/i.test(res.stdout.trim())) engram.push({ scope: sc, text: res.stdout });
    } else failures.push(res.stderr || 'sin detalle');
  }
  return { engram, markdown, warning: failures.length ? `engram search falló: ${failures[0]}` : undefined };
}

/** Recent memory for `xjergx resume` and `memory list`. */
export function overview(ctx, { lines = 40 } = {}) {
  const markdown = listMemory(ctx.paths);
  if (backendOf(ctx).name !== 'engram') return { engram: null, markdown };
  const res = runEngram(['context', ...projectArgs(ctx)], { cwd: cwdOf(ctx) });
  if (!res.ok) return { engram: null, markdown, warning: `engram context falló: ${res.stderr || 'sin detalle'}` };
  const all = res.stdout.split('\n');
  const text = all.slice(0, lines).join('\n') + (all.length > lines ? `\n… (${all.length - lines} more lines: \`engram context\`)` : '');
  return { engram: text.trim() ? text : null, markdown };
}

/** `memory show <id>`: Markdown ids look like notes/... or tasks/...; numeric ids are Engram observations. */
export function showMemory(ctx, id) {
  const md = findMemory(ctx.paths, id);
  if (md) return readFileSync(md.file, 'utf8');
  if (/^\d+$/.test(id) && backendOf(ctx).name === 'engram') {
    const res = runEngram(['timeline', id, ...projectArgs(ctx)], { cwd: cwdOf(ctx) });
    if (res.ok) return res.stdout;
  }
  return null;
}

/** After the archive phase: index the ticket record in Engram so agents find it through their MCP tools. */
export function indexTaskRecord(ctx, task, file) {
  if (backendOf(ctx).name !== 'engram') return null;
  const body = readFileSync(file, 'utf8');
  const res = runEngram(
    ['save', `xjergx ${task.id}: ${task.description}`.slice(0, 200), engramContent({ type: 'task', task: task.id, tags: [task.lane].filter(Boolean), body })],
    { cwd: cwdOf(ctx) },
  );
  return res.ok ? null : `No pude indexar ${task.id} en Engram: ${res.stderr || 'sin detalle'} (queda en Markdown).`;
}

/** Handoffs are also saved in Engram, so an agent that only talks to Engram (MCP) still sees them. */
export function rememberHandoff(ctx, h, journalText) {
  if (backendOf(ctx).name !== 'engram') return null;
  const first = h.summary.split('\n')[0].slice(0, 120);
  const res = runEngram(
    ['save', `Handoff (${h.agent}): ${first}`, engramContent({ type: 'handoff', agent: h.agent, task: h.ticket?.id, body: journalText })],
    { cwd: cwdOf(ctx) },
  );
  return res.ok ? null : `No pude guardar el handoff en Engram: ${res.stderr || 'sin detalle'} (queda en .xjergx/session.json).`;
}
