import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { handoff, resumeBrief, detectAgent, loadSession } from '../src/session.js';
import { addTask, saveBacklog, loadBacklog } from '../src/backlog.js';
import { addMemory } from '../src/memory.js';
import { makeWorkspace, writeTaskFile } from './helpers.js';

function gitWorkspace() {
  const ws = makeWorkspace();
  const git = (...a) => spawnSync('git', a, { cwd: ws.root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(ws.root, 'app.js'), 'v1');
  git('add', '.');
  git('commit', '-qm', 'init');
  return { ws, git };
}

test('agent detection: explicit variable wins, then tool markers', () => {
  assert.equal(detectAgent({ XJERGX_AGENT: 'pi', CLAUDECODE: '1' }), 'pi');
  assert.equal(detectAgent({ CLAUDECODE: '1' }), 'claude');
  assert.equal(detectAgent({ CODEX_THREAD_ID: 'x' }), 'codex');
  assert.equal(detectAgent({}), 'unknown');
});

test('handoff writes session.json and a journal; auto mode only records activity', () => {
  const { ws } = gitWorkspace();
  assert.throws(() => handoff(ws.paths, { agent: 'codex' }), /--summary/);

  const { handoff: h, journal } = handoff(ws.paths, {
    agent: 'codex',
    summary: 'Endpoint CSV listo, falta E2E',
    next: ['Escribir E2E-2', 'Correr review'],
    open: ['¿Incluir pedidos cancelados?'],
  });
  assert.equal(h.agent, 'codex');
  assert.deepEqual(h.next, ['Escribir E2E-2', 'Correr review']);
  assert.equal(h.repos[0].changed, 0);
  assert.ok(existsSync(journal));
  assert.match(readFileSync(journal, 'utf8'), /Incluir pedidos cancelados/);

  handoff(ws.paths, { agent: 'codex', auto: true });
  const s = loadSession(ws.paths);
  assert.equal(s.handoff.summary, 'Endpoint CSV listo, falta E2E', 'auto never overwrites the handoff');
  assert.equal(s.activity.agent, 'codex');
});

test('resume: Codex hands off, Claude picks up ticket, progress notes and memory', () => {
  const { ws } = gitWorkspace();
  const data = loadBacklog(ws.paths);
  const task = addTask(data, { description: 'Exportar pedidos a CSV', lane: 'rdd' });
  task.status = 'build';
  saveBacklog(ws.paths, data);
  writeTaskFile(ws, task.id, 'progress-build.md', '- happy path listo\n- falta E2E');
  addMemory(ws.paths, { title: 'Exports usan streaming', type: 'decision', agent: 'codex' });

  writeFileSync(join(ws.paths.base, 'scratch.txt'), 'harness files are not "work"');
  handoff(ws.paths, { agent: 'codex', summary: 'Core del export listo', next: ['E2E de casos malos'], open: ['¿Cancelados?'] });
  const brief = resumeBrief(ws.paths, { agent: 'claude' });

  assert.match(brief, /Last handoff by \*\*codex\*\*/);
  assert.match(brief, /> Core del export listo/);
  assert.match(brief, /- E2E de casos malos/);
  assert.match(brief, /¿Cancelados\?/);
  assert.match(brief, /Active ticket \*\*T-001\*\*/);
  assert.match(brief, /Next phase: `build`/);
  assert.match(brief, /progress-build\.md/);
  assert.match(brief, /\[decision\] Exports usan streaming/);
  assert.match(brief, /`xjergx`: Continue work another coding agent started/, 'bundled skill is listed');
  assert.match(brief, /xjergx handoff --agent claude/);
  assert.doesNotMatch(brief, /later activity/);
  assert.doesNotMatch(brief, /scratch\.txt/, 'changes inside .xjergx/ are not listed as work');
});

test('resume warns when someone kept working after the handoff', () => {
  const { ws } = gitWorkspace();
  handoff(ws.paths, { agent: 'codex', summary: 'Listo hasta acá' });

  // Same agent, nothing changed (a Stop hook firing right after the handoff): no warning.
  handoff(ws.paths, { agent: 'codex', auto: true });
  assert.doesNotMatch(resumeBrief(ws.paths), /later activity/);

  // OpenCode edits a file and its hook records activity, but nobody writes a handoff.
  writeFileSync(join(ws.root, 'app.js'), 'v2');
  handoff(ws.paths, { agent: 'opencode', auto: true });
  assert.match(resumeBrief(ws.paths, { agent: 'claude' }), /later activity by \*\*opencode\*\*/);
});

test('resume works on a fresh workspace', () => {
  const ws = makeWorkspace();
  const brief = resumeBrief(ws.paths, { agent: 'pi' });
  assert.match(brief, /No previous session recorded/);
  assert.match(brief, /The backlog is empty/);
});
