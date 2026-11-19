import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addMemory, searchMemory, listMemory, findMemory, slugify } from '../src/memory.js';
import { parseFrontmatter, stringifyFrontmatter } from '../src/frontmatter.js';
import { parseTomlStrings, tomlMultiline, tomlString } from '../src/toml.js';
import { migrateLayout, globalPaths } from '../src/paths.js';
import { makeWorkspace } from './helpers.js';

test('memory entries are plain markdown with frontmatter', () => {
  const ws = makeWorkspace();
  const e = addMemory(ws.paths, {
    title: 'Exportaciones usan streaming',
    body: 'Más de 200k filas rompían el límite de memoria. Usar streamCsv.',
    type: 'decision',
    tags: ['exports', 'performance'],
    agent: 'codex',
    task: 'T-001',
  });
  assert.equal(e.scope, 'project');
  assert.match(e.id, /^notes\/\d{4}-\d{2}-\d{2}-exportaciones-usan-streaming$/);
  const { meta, body } = parseFrontmatter(readFileSync(e.file, 'utf8'));
  assert.equal(meta.type, 'decision');
  assert.deepEqual(meta.tags, ['exports', 'performance']);
  assert.equal(meta.agent, 'codex');
  assert.match(body, /streamCsv/);
});

test('search ranks title/tag hits, ignores accents and requires every term', () => {
  const ws = makeWorkspace();
  addMemory(ws.paths, { title: 'Exportaciones usan streaming', body: 'usar streamCsv', type: 'decision', tags: ['csv'] });
  addMemory(ws.paths, { title: 'Convención de nombres', body: 'Los helpers de csv van en src/lib', type: 'convention' });
  addMemory(ws.paths, { title: 'Login con SSO', body: 'nada que ver', type: 'note' });

  const csv = searchMemory(ws.paths, 'csv');
  assert.equal(csv.length, 2);
  assert.equal(csv[0].title, 'Exportaciones usan streaming', 'tag hit beats body hit');

  assert.equal(searchMemory(ws.paths, 'exportacion')[0].title, 'Exportaciones usan streaming');
  assert.equal(searchMemory(ws.paths, 'convencion nombres').length, 1);
  assert.equal(searchMemory(ws.paths, 'csv sso').length, 0);
});

test('archivist records are part of memory and global memory is visible from any project', () => {
  const ws = makeWorkspace();
  mkdirSync(ws.paths.engram, { recursive: true });
  writeFileSync(join(ws.paths.engram, 'T-007.md'), '# Engram Record: T-007\n\nChose Redis for sessions due to TTL.\n');
  addMemory(null, { title: 'Prefiero pnpm', body: 'Usar pnpm en todos los proyectos', type: 'preference', global: true });

  const all = listMemory(ws.paths);
  const task = all.find((m) => m.id === 'tasks/T-007');
  assert.equal(task.type, 'task');
  assert.equal(task.title, 'Engram Record: T-007');
  const pref = all.find((m) => m.scope === 'global');
  assert.ok(pref.id.startsWith('g:notes/'));
  assert.ok(existsSync(join(globalPaths().notes)));

  const other = makeWorkspace();
  assert.equal(searchMemory(other.paths, 'pnpm')[0].title, 'Prefiero pnpm');
  assert.equal(findMemory(ws.paths, 'T-007').title, 'Engram Record: T-007');
});

test('project memory needs a workspace unless it is global', () => {
  assert.throws(() => addMemory(null, { title: 'x' }), /--global/);
  assert.throws(() => addMemory(makeWorkspace().paths, { title: 'x', type: 'rumor' }), /Tipo inválido/);
});

test('v0.2 engram folder is migrated into memory/tasks', () => {
  const ws = makeWorkspace();
  mkdirSync(join(ws.paths.base, 'engram'), { recursive: true });
  writeFileSync(join(ws.paths.base, 'engram', 'T-001.md'), '# old');
  assert.equal(migrateLayout(ws.paths), true);
  assert.ok(existsSync(join(ws.paths.engram, 'T-001.md')));
  assert.equal(migrateLayout(ws.paths), false);
});

test('frontmatter round-trips lists, quoting and folded descriptions', () => {
  const text = stringifyFrontmatter({ title: 'a: b', tags: ['x', 'y z'], empty: '' }, 'Body');
  const { meta, body } = parseFrontmatter(text);
  assert.equal(meta.title, 'a: b');
  assert.deepEqual(meta.tags, ['x', 'y z']);
  assert.equal(meta.empty, undefined);
  assert.equal(body, 'Body');

  const folded = parseFrontmatter('---\nname: s\ndescription: >-\n  line one\n  line two\ntags:\n  - a\n  - b\n---\nok');
  assert.equal(folded.meta.description, 'line one line two');
  assert.deepEqual(folded.meta.tags, ['a', 'b']);
});

test('toml helpers round-trip prompts with quotes and backslashes', () => {
  const body = 'Match \\d+ and say "hi"\nNever use \'\'\' here';
  const toml = `name = ${tomlString('scout')}\ndescription = ${tomlString('Say "hi"')}\ndeveloper_instructions = ${tomlMultiline(body)}\n\n[mcp_servers.x]\ncommand = "ignored"\n`;
  const parsed = parseTomlStrings(toml);
  assert.equal(parsed.name, 'scout');
  assert.equal(parsed.description, 'Say "hi"');
  assert.equal(parsed.developer_instructions.trimEnd(), body, 'TOML keeps the newline before the closing quotes');
  assert.equal(parsed.command, undefined, 'tables are ignored');

  const literal = parseTomlStrings(`developer_instructions = ${tomlMultiline('path C:\\temp')}`);
  assert.equal(literal.developer_instructions.trimEnd(), 'path C:\\temp');
  assert.equal(slugify('¿Qué pasó con Ñandú?'), 'que-paso-con-nandu');
});
