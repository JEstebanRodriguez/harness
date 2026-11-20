import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { remember, recall, overview, showMemory, backendOf, indexTaskRecord } from '../src/memstore.js';
import { handoff, resumeBrief } from '../src/session.js';
import { buildPrompt } from '../src/prompt.js';
import { doctor } from '../src/doctor.js';
import { engramStatus, codegraphStatus } from '../src/tools.js';
import { addTask } from '../src/backlog.js';
import { LANES, CLASSIFY_PHASE } from '../src/lanes.js';
import { makeWorkspace, ctxFor } from './helpers.js';

const FAKE_ENGRAM = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-engram.js');
const savedEnv = { ...process.env };
let log;

/** Put fake `engram` (and optionally `codegraph`) executables first on the PATH. */
function installFakes({ codegraph = false } = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'xjergx-bin-'));
  chmodSync(FAKE_ENGRAM, 0o755);
  writeFileSync(join(bin, 'engram'), `#!/bin/sh\nexec node "${FAKE_ENGRAM}" "$@"\n`);
  chmodSync(join(bin, 'engram'), 0o755);
  if (codegraph) {
    writeFileSync(join(bin, 'codegraph'), '#!/bin/sh\necho codegraph\n');
    chmodSync(join(bin, 'codegraph'), 0o755);
  }
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
}

const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeEach(() => {
  log = join(mkdtempSync(join(tmpdir(), 'xjergx-log-')), 'engram.log');
  process.env.FAKE_ENGRAM_LOG = log;
  process.env.XJERGX_MEMORY_BACKEND = 'auto';
  delete process.env.FAKE_ENGRAM_FAIL;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

const mctx = (ws) => ({ paths: ws.paths, config: ws.config });

test('auto backend: Markdown without engram, Engram once it is on the PATH', () => {
  const ws = makeWorkspace();
  process.env.PATH = '/nonexistent';
  assert.equal(backendOf(mctx(ws)).name, 'markdown');
  delete process.env.XJERGX_MEMORY_BACKEND;
  assert.match(engramStatus({ memory: { backend: 'engram' } }).reason, /no encuentro el binario/);
  process.env.XJERGX_MEMORY_BACKEND = 'auto';
  process.env.PATH = savedEnv.PATH;
  installFakes();
  assert.equal(backendOf(mctx(ws)).name, 'engram');
  process.env.XJERGX_MEMORY_BACKEND = 'markdown';
  assert.equal(backendOf(mctx(ws)).name, 'markdown', 'env override wins');
});

test('memory add goes to Engram with metadata in the content; --global uses the global project', () => {
  installFakes();
  const ws = makeWorkspace();
  const res = remember(mctx(ws), { title: 'Exports usan streaming', body: '200k filas', type: 'decision', tags: ['csv'], agent: 'codex', task: 'T-001' });
  assert.equal(res.backend, 'engram');
  assert.equal(res.id, '42');
  const [save] = calls();
  assert.equal(save[0], 'save');
  assert.equal(save[1], 'Exports usan streaming');
  assert.match(save[2], /^Type: decision\nTags: csv\nAgent: codex\nTicket: T-001\nSource: xjergx\n\n200k filas$/);
  assert.equal(save.includes('--project'), false, 'project detection is left to engram, like the MCP side');
  assert.equal(existsSync(ws.paths.notes), false, 'nothing written to Markdown');

  remember(mctx(ws), { title: 'Prefiero pnpm', type: 'preference', global: true });
  assert.deepEqual(calls()[1].slice(-2), ['--project', 'xjergx-global']);

  ws.config.memory.engramProject = 'team-app';
  remember(mctx(ws), { title: 'x', type: 'note' });
  assert.deepEqual(calls()[2].slice(-2), ['--project', 'team-app']);
});

test('if engram fails, memory falls back to Markdown and says so', () => {
  installFakes();
  process.env.FAKE_ENGRAM_FAIL = '1';
  const ws = makeWorkspace();
  const res = remember(mctx(ws), { title: 'No se pierde', type: 'gotcha' });
  assert.equal(res.backend, 'markdown');
  assert.match(res.warning, /database is locked/);
  assert.match(res.id, /^notes\//);
  const r = recall(mctx(ws), 'pierde');
  assert.equal(r.markdown.length, 1, 'the fallback note is still found');
  assert.match(r.warning, /engram search falló/);
});

test('search combines Engram (project + global) with ticket records in the repo', () => {
  installFakes();
  const ws = makeWorkspace();
  mkdirSync(ws.paths.engram, { recursive: true });
  writeFileSync(join(ws.paths.engram, 'T-003.md'), '# Engram Record: T-003\nCSV export streaming decision');
  const r = recall(mctx(ws), 'streaming');
  assert.deepEqual(calls().map((c) => c[0]), ['search', 'search']);
  assert.equal(r.engram.length, 1, '"No memories found" from the global project is dropped');
  assert.match(r.engram[0].text, /#7 \(decision\) Exports usan streaming/);
  assert.equal(r.markdown[0].id, 'tasks/T-003');
});

test('show reads Markdown ids locally and numeric ids from Engram', () => {
  installFakes();
  const ws = makeWorkspace();
  assert.match(showMemory(mctx(ws), '7'), /200k filas/);
  assert.deepEqual(calls()[0].slice(0, 2), ['timeline', '7']);
  assert.equal(showMemory(mctx(ws), 'nope'), null);
});

test('handoff is mirrored to Engram and resume shows Engram context', () => {
  installFakes();
  const ws = makeWorkspace();
  const { warning } = handoff(ws.paths, { agent: 'codex', summary: 'Core del export listo\nmás detalle', next: ['E2E'] }, ws.config);
  assert.equal(warning, null);
  const save = calls().find((c) => c[0] === 'save');
  assert.equal(save[1], 'Handoff (codex): Core del export listo');
  assert.match(save[2], /Type: handoff[\s\S]*## Next steps\n- E2E/);

  const brief = resumeBrief(ws.paths, { agent: 'claude', config: ws.config });
  assert.match(brief, /Backend: \*\*Engram\*\*/);
  assert.match(brief, /Recent Engram context:\n```\n## Recent sessions/);
  assert.match(brief, /Last handoff by \*\*codex\*\*/, 'session.json still drives the handoff section');

  handoff(ws.paths, { agent: 'claude', auto: true }, ws.config);
  assert.equal(calls().filter((c) => c[0] === 'save').length, 1, 'automatic activity snapshots never go to Engram');
});

test('finished ticket records are indexed in Engram', () => {
  installFakes();
  const ws = makeWorkspace();
  const task = addTask({ tasks: [] }, { description: 'Exportar CSV', lane: 'odd' });
  mkdirSync(ws.paths.engram, { recursive: true });
  const file = join(ws.paths.engram, `${task.id}.md`);
  writeFileSync(file, '# Engram Record: T-001\n- Lane: ODD');
  assert.equal(indexTaskRecord(mctx(ws), task, file), null);
  const [save] = calls();
  assert.equal(save[1], 'xjergx T-001: Exportar CSV');
  assert.match(save[2], /Type: task\nTags: odd\nTicket: T-001/);

  process.env.XJERGX_MEMORY_BACKEND = 'markdown';
  assert.equal(indexTaskRecord(mctx(ws), task, file), null);
  assert.equal(calls().length, 1, 'nothing is sent with the Markdown backend');
});

test('phase prompts adapt to Engram and codegraph', () => {
  const ws = makeWorkspace();
  const task = addTask({ tasks: [] }, { description: 'Exportar CSV', lane: 'sdd' });
  process.env.XJERGX_MEMORY_BACKEND = 'markdown';
  process.env.XJERGX_CODEGRAPH = 'off';
  let p = buildPrompt(ctxFor(ws), task, LANES.sdd.phases[0]);
  assert.match(p, /Project memory:\*\* `\.xjergx\/memory\/`/);
  assert.doesNotMatch(p, /## Codegraph/);
  assert.match(p, /use file search \(rg\/grep/);

  installFakes();
  process.env.XJERGX_MEMORY_BACKEND = 'auto';
  process.env.XJERGX_CODEGRAPH = 'on';
  p = buildPrompt(ctxFor(ws), task, LANES.sdd.phases[0]);
  assert.match(p, /\*\*Engram\*\*, shared by every agent/);
  assert.match(p, /mem_search/);
  assert.match(p, /## Codegraph[\s\S]*codegraph_context[\s\S]*Run these queries \*\*yourself\*\*/);
  assert.match(buildPrompt(ctxFor(ws), addTask({ tasks: [] }, { description: 'x' }), CLASSIFY_PHASE), /codegraph_context` on the\s+symbols the ticket changes/);
});

test('codegraph auto-detection: binary or .codegraph index', () => {
  const ws = makeWorkspace();
  process.env.XJERGX_CODEGRAPH = 'auto';
  process.env.PATH = '/nonexistent';
  assert.equal(codegraphStatus(ws.config, ws.root).enabled, false);
  mkdirSync(join(ws.root, '.codegraph'));
  assert.match(codegraphStatus(ws.config, ws.root).reason, /índice/);
  process.env.PATH = savedEnv.PATH;
  installFakes({ codegraph: true });
  assert.equal(codegraphStatus(ws.config, makeWorkspace().root).enabled, true);
});

test('doctor reports per tool and --fix runs engram setup for the supported ones', () => {
  installFakes({ codegraph: true });
  const ws = makeWorkspace();
  const report = doctor(ctxFor(ws), { fix: true, targets: ['claude', 'codex', 'opencode', 'pi', 'omp'] });
  assert.deepEqual(calls().map((c) => c.join(' ')), ['setup claude-code', 'setup codex', 'setup opencode', 'setup pi']);
  assert.equal(report.targets.find((t) => t.target === 'omp').fix, undefined);
  assert.equal(report.targets.find((t) => t.target === 'claude').fix, 'ok');
  assert.ok(report.actions.some((a) => /omp: `engram setup` no lo soporta/.test(a)));
  assert.ok(report.actions.some((a) => /codegraph init -i/.test(a)), 'not indexed yet');
});

test('overview without a workspace only reads the global Markdown store', () => {
  process.env.XJERGX_MEMORY_BACKEND = 'markdown';
  assert.deepEqual(overview({ paths: null, config: makeWorkspace().config }).markdown, []);
});
