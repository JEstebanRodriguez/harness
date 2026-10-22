import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, chmodSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runTask, nextAction } from '../src/workflow.js';
import { loadBacklog, saveBacklog, addTask } from '../src/backlog.js';
import { makeWorkspace, ctxFor, writeTaskFile, SMALL } from './helpers.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.js');
chmodSync(FAKE, 0o755);

function workspaceWithFakeAgent(over = {}) {
  const ws = makeWorkspace({
    adapters: { fake: { bin: FAKE, interactive: ['{prompt}'], headless: ['{prompt}'] } },
    ...over,
  });
  // A clean git repo so preflight passes.
  const git = (...args) => spawnSync('git', args, { cwd: ws.root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(ws.root, '.gitignore'), '.fake-agent.log\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return { ws, git };
}

function add(ws, opts) {
  const data = loadBacklog(ws.paths);
  const task = addTask(data, { description: 'Feature', ...opts });
  saveBacklog(ws.paths, data);
  return task.id;
}

function silentIO(answers = []) {
  const out = [];
  return {
    out,
    isTTY: true,
    log: (m) => out.push(m),
    warn: (m) => out.push(m),
    ask: async () => answers.shift() ?? '',
    confirm: async () => (answers.shift() ?? 's') === 's',
  };
}

const phasesRun = (ws) => readFileSync(join(ws.root, '.fake-agent.log'), 'utf8').trim().split('\n');
const env = (vars) => Object.assign(process.env, vars);

test('driver: classifies, routes to ODD and completes with the fake agent', async () => {
  const { ws } = workspaceWithFakeAgent();
  const id = add(ws);
  env({ FAKE_CLASSIFICATION: JSON.stringify(SMALL), FAKE_FAIL_REVIEWS: '0', FAKE_ESCALATE_TO: '', FAKE_SILENT_PHASE: '' });
  const code = await runTask(ctxFor(ws, 'yolo'), { agent: 'fake' }, silentIO());
  assert.equal(code, 0);
  assert.deepEqual(phasesRun(ws), ['classify', 'build', 'archive']);
  const task = loadBacklog(ws.paths).tasks.find((t) => t.id === id);
  assert.equal(task.lane, 'odd');
  assert.equal(task.status, 'completed');
  assert.ok(existsSync(join(ws.paths.engram, `${id}.md`)));
});

test('driver: SDD in yolo with one failed review loops back to build', async () => {
  const { ws } = workspaceWithFakeAgent();
  add(ws);
  env({
    FAKE_CLASSIFICATION: JSON.stringify({ ...SMALL, files_estimate: 4, touches_contract: true }),
    FAKE_FAIL_REVIEWS: '1', FAKE_ESCALATE_TO: '', FAKE_SILENT_PHASE: '',
  });
  const code = await runTask(ctxFor(ws, 'yolo'), { agent: 'fake' }, silentIO());
  assert.equal(code, 0);
  assert.deepEqual(phasesRun(ws), ['classify', 'explore', 'design', 'spec', 'build', 'review', 'build', 'review', 'archive']);
});

test('driver: interactive gate asks the human; rejection repeats the phase', async () => {
  const { ws } = workspaceWithFakeAgent();
  add(ws, { lane: 'rdd' });
  env({ FAKE_FAIL_REVIEWS: '0', FAKE_ESCALATE_TO: '', FAKE_SILENT_PHASE: '' });
  // reject once (n + note), then approve (s)
  const io = silentIO(['n', 'add the admin case', 's']);
  const code = await runTask(ctxFor(ws, 'interactive'), { agent: 'fake' }, io);
  assert.equal(code, 0);
  assert.deepEqual(phasesRun(ws), ['requirements', 'requirements', 'build', 'review', 'archive']);
  const prompt = readFileSync(join(ws.paths.prompts, 'T-001-requirements.md'), 'utf8');
  assert.match(prompt, /add the admin case/);
});

test('driver: escalation from ODD to SDD mid-build', async () => {
  const { ws } = workspaceWithFakeAgent();
  add(ws, { lane: 'odd' });
  env({ FAKE_FAIL_REVIEWS: '0', FAKE_ESCALATE_TO: 'sdd', FAKE_SILENT_PHASE: '' });
  const code = await runTask(ctxFor(ws, 'yolo'), { agent: 'fake' }, silentIO());
  assert.equal(code, 0);
  assert.deepEqual(phasesRun(ws), ['build', 'explore', 'design', 'spec', 'build', 'review', 'archive']);
  assert.equal(loadBacklog(ws.paths).tasks[0].lane, 'sdd');
});

test('driver: dry-run stops before writing code', async () => {
  const { ws } = workspaceWithFakeAgent();
  add(ws, { lane: 'sdd' });
  env({ FAKE_SILENT_PHASE: '', FAKE_ESCALATE_TO: '' });
  const code = await runTask(ctxFor(ws, 'dry-run'), { agent: 'fake' }, silentIO(['s']));
  assert.equal(code, 0);
  assert.deepEqual(phasesRun(ws), ['explore', 'design', 'spec']);
  assert.equal(loadBacklog(ws.paths).tasks[0].status, 'build');
});

test('driver: an agent that produces nothing does not loop', async () => {
  const { ws } = workspaceWithFakeAgent();
  add(ws, { lane: 'odd' });
  env({ FAKE_SILENT_PHASE: 'build', FAKE_ESCALATE_TO: '' });
  const io = silentIO();
  const code = await runTask(ctxFor(ws, 'yolo'), { agent: 'fake' }, io);
  assert.equal(code, 1);
  assert.deepEqual(phasesRun(ws), ['build']);
  assert.ok(io.out.some((l) => /sin dejar un resultado válido/.test(l)));
});

test('driver: preflight refuses a dirty tree before the task starts', async () => {
  const { ws } = workspaceWithFakeAgent();
  add(ws, { lane: 'odd' });
  writeFileSync(join(ws.root, 'dirty.txt'), 'x');
  const io = silentIO();
  const code = await runTask(ctxFor(ws, 'yolo'), { agent: 'fake' }, io);
  assert.equal(code, 1);
  assert.ok(io.out.some((l) => /dirty\.txt/.test(l)));
});

test('driver: manual agent prints the kickoff and resumes on the next run', async () => {
  const { ws } = workspaceWithFakeAgent();
  const id = add(ws, { lane: 'odd' });
  const io = silentIO();
  assert.equal(await runTask(ctxFor(ws, 'yolo'), { agent: 'manual' }, io), 0);
  assert.ok(io.out.some((l) => l.includes(`.xjergx/prompts/${id}-build.md`)));

  writeTaskFile(ws, id, 'build-report.md', 'Status: DONE');
  const io2 = silentIO();
  await runTask(ctxFor(ws, 'yolo'), { agent: 'manual' }, io2);
  assert.ok(io2.out.some((l) => l.includes(`${id}-archive.md`)));
});

test('host: next walks a ticket through approval', () => {
  const { ws } = workspaceWithFakeAgent();
  const id = add(ws, { lane: 'rdd' });
  const ctx = ctxFor(ws, 'interactive');

  let r = nextAction(ctx);
  assert.equal(r.action, 'run_phase');
  assert.equal(r.phase, 'requirements');
  assert.equal(r.agent, 'xjergx-rdd-analyst');
  assert.equal(r.conversational, true);
  assert.ok(existsSync(join(ws.root, r.promptFile)));
  const prompt = readFileSync(join(ws.root, r.promptFile), 'utf8');
  assert.match(prompt, /System PROMPT: xjergx-rdd-analyst/i);
  assert.match(prompt, /escalation\.json/);

  writeTaskFile(ws, id, 'requirements.md', '# R');
  // The agent already modified the tree: preflight must not block a started task.
  writeFileSync(join(ws.root, 'wip.txt'), 'x');
  r = nextAction(ctx);
  assert.equal(r.action, 'approve');
  assert.match(r.artifact, /requirements\.md$/);
});

test('host: idle when the backlog is empty', () => {
  const ws = makeWorkspace();
  assert.equal(nextAction(ctxFor(ws)).action, 'idle');
});
