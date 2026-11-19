import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { globalPaths } from './paths.js';

/**
 * Shared memory. Plain Markdown files with frontmatter, so every coding agent can
 * read them with or without this CLI, and git can version them.
 *
 *   <project>/.xjergx/memory/tasks/<ID>.md   archivist record of each finished ticket
 *   <project>/.xjergx/memory/notes/*.md      notes any agent adds while working
 *   ~/.xjergx/memory/notes/*.md              global: preferences and lessons for every project
 */

export const MEMORY_TYPES = ['decision', 'convention', 'gotcha', 'asset', 'preference', 'note'];

export function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'note';
}

/** Memory stores visible from a workspace (project first, then global). */
export function memoryStores(paths) {
  const g = globalPaths();
  const stores = [];
  if (paths) stores.push({ scope: 'project', dir: paths.memory, notes: paths.notes });
  stores.push({ scope: 'global', dir: g.memory, notes: g.notes });
  return stores;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * @typedef {{ id: string, scope: string, file: string, title: string, type: string, tags: string[],
 *             created: string, agent?: string, task?: string, body: string }} MemoryEntry
 */

/** @returns {MemoryEntry[]} newest first */
export function listMemory(paths, { scope } = {}) {
  const entries = [];
  for (const store of memoryStores(paths)) {
    if (scope && store.scope !== scope) continue;
    for (const file of walk(store.dir)) {
      const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'));
      const rel = relative(store.dir, file).split('\\').join('/');
      const isTask = rel.startsWith('tasks/');
      const heading = body.match(/^#\s+(.+)$/m)?.[1];
      entries.push({
        id: `${store.scope === 'global' ? 'g:' : ''}${rel.replace(/\.md$/, '')}`,
        scope: store.scope,
        file,
        title: meta.title ?? heading ?? basename(file, '.md'),
        type: meta.type ?? (isTask ? 'task' : 'note'),
        tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [],
        created: meta.created ?? statSync(file).mtime.toISOString(),
        agent: meta.agent,
        task: meta.task ?? (isTask ? basename(file, '.md') : undefined),
        body,
      });
    }
  }
  return entries.sort((a, b) => b.created.localeCompare(a.created));
}

/**
 * @returns {MemoryEntry} the entry written
 */
export function addMemory(paths, { title, body = '', type = 'note', tags = [], agent, task, global = false }) {
  if (!title?.trim()) throw new Error('La memoria necesita un título.');
  if (!MEMORY_TYPES.includes(type)) throw new Error(`Tipo inválido "${type}". Usá: ${MEMORY_TYPES.join(', ')}.`);
  if (!global && !paths) throw new Error('No hay workspace xjergx aquí: usá --global o ejecutá `xjergx init`.');
  const dir = global ? globalPaths().notes : paths.notes;
  mkdirSync(dir, { recursive: true });
  const created = new Date().toISOString();
  const stem = `${created.slice(0, 10)}-${slugify(title)}`;
  let file = join(dir, `${stem}.md`);
  for (let n = 2; existsSync(file); n++) file = join(dir, `${stem}-${n}.md`);
  const content = stringifyFrontmatter(
    { title: title.trim(), type, tags, agent, task, created },
    body.trim() || title.trim(),
  );
  writeFileSync(file, content);
  return listMemory(paths, { scope: global ? 'global' : 'project' }).find((e) => e.file === file);
}

function tokens(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Keyword search: title and tags weigh more than the body. All terms must appear somewhere. */
export function searchMemory(paths, query, { limit = 10, scope } = {}) {
  const terms = [...new Set(tokens(query))];
  if (!terms.length) return [];
  const results = [];
  for (const entry of listMemory(paths, { scope })) {
    const title = tokens(entry.title);
    const tags = entry.tags.flatMap(tokens);
    const meta = tokens(`${entry.type} ${entry.task ?? ''}`);
    const body = tokens(entry.body);
    let score = 0;
    let all = true;
    for (const t of terms) {
      const hit = (arr) => arr.filter((w) => w.startsWith(t)).length;
      const s = hit(title) * 5 + hit(tags) * 4 + hit(meta) * 2 + Math.min(hit(body), 5);
      if (!s) all = false;
      score += s;
    }
    if (all) results.push({ ...entry, score, snippet: snippet(entry.body, terms) });
  }
  return results.sort((a, b) => b.score - a.score || b.created.localeCompare(a.created)).slice(0, limit);
}

function snippet(body, terms) {
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const norm = (l) => l.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const line = lines.find((l) => terms.some((t) => norm(l).includes(t))) ?? lines[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

export function findMemory(paths, id) {
  const entries = listMemory(paths);
  return entries.find((e) => e.id === id) ?? entries.find((e) => e.id.endsWith(`/${id}`) || e.id.endsWith(id));
}
