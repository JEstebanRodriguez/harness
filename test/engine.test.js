import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { advance, approve, reject, unblock, switchLane } from '../src/engine.js';
import { addTask, normalizeTask, findTask } from '../src/backlog.js';
import { makeWorkspace, ctxFor, writeTaskFile, SMALL } from './helpers.js';

function newTask(ws, opts = {}) {
  const data = { tasks: [] };
  return addTask(data, { description: 'Do something', ...opts });
}

/** Advance until the task needs something external. */
function settle(ctx, task) {
  for (let i = 0; i < 20; i++) {
    const ev = advance(ctx, task);
    if (!['advanced', 'escalated', 'retry'].includes(ev.type)) return ev;
  }
  throw new Error('did not settle');
}

test('pending task needs the classifier first', () => {
  const ws = makeWorkspace();
  const task = newTask(ws);
  const ev = advance(ctxFor(ws), task);
  assert.equal(ev.type, 'needs_agent');
  assert.equal(ev.phase.id, 'classify');
});

test('invalid classification is reported, not accepted', () => {
  const ws = makeWorkspace();
  const task = newTask(ws);
  writeTaskFile(ws, task.id, 'classification.json', '{"files_estimate": "many"}');
  const ev = advance(ctxFor(ws), task);
  assert.equal(ev.type, 'invalid_output');
  assert.equal(task.status, 'pending');
});

test('ODD lane: classify → build → archive → completed', () => {
  const ws = makeWorkspace();
  const ctx = ctxFor(ws);
  const task = newTask(ws);
  writeTaskFile(ws, task.id, 'classification.json', JSON.stringify(SMALL));
  let ev = settle(ctx, task);
  assert.equal(task.lane, 'odd');
  assert.equal(task.laneSource, 'router');
  assert.equal(ev.phase.id, 'build');

  writeTaskFile(ws, task.id, 'build-report.md', '# Report\n\nStatus: DONE\n');
  ev = settle(ctx, task);
  assert.equal(ev.phase.id, 'archive');

  writeTaskFile(ws, '../engram', `${task.id}.md`, '# Engram');
  ev = settle(ctx, task);
  assert.equal(ev.type, 'completed');
  assert.equal(task.status, 'completed');
});

test('a report without a status line is invalid', () => {
  const ws = makeWorkspace();
  const task = newTask(ws, { lane: 'odd' });
  writeTaskFile(ws, task.id, 'build-report.md', '# Report\nall good');
  assert.equal(advance(ctxFor(ws), task).type, 'invalid_output');
});

test('BLOCKED report blocks the task, unblock retries the phase', () => {
  const ws = makeWorkspace();
  const ctx = ctxFor(ws);
  const task = newTask(ws, { lane: 'odd' });
  writeTaskFile(ws, task.id, 'build-report.md', 'Status: BLOCKED\nReason: no DB access');
  const ev = advance(ctx, task);
  assert.equal(ev.type, 'blocked');
  assert.equal(task.blockedReason, 'no DB access');

  unblock(ctx, task);
  assert.equal(task.status, 'build');
  assert.equal(advance(ctx, task).type, 'needs_agent');
});

test('RDD gate: interactive waits for approval, reject repeats the phase with feedback', () => {
  const ws = makeWorkspace();
  const ctx = ctxFor(ws, 'interactive');
  const task = newTask(ws, { lane: 'rdd' });
  writeTaskFile(ws, task.id, 'requirements.md', '# Requirements v1');

  let ev = advance(ctx, task);
  assert.equal(ev.type, 'awaiting_approval');
  assert.equal(advance(ctx, task).type, 'awaiting_approval'); // stays put

  reject(ctx, task, 'Missing the admin use case');
  assert.equal(task.status, 'requirements');
  assert.equal(task.feedback.note, 'Missing the admin use case');
  assert.ok(existsSync(join(ws.paths.tasks, task.id, 'history', 'requirements.1.md')));

  writeTaskFile(ws, task.id, 'requirements.md', '# Requirements v2');
  ev = advance(ctx, task);
  assert.equal(ev.type, 'awaiting_approval');
  approve(task);
  assert.equal(task.feedback, null);
  ev = advance(ctx, task);
  assert.equal(ev.type, 'needs_agent');
  assert.equal(ev.phase.id, 'build');
});

test('yolo mode skips gates', () => {
  const ws = makeWorkspace();
  const task = newTask(ws, { lane: 'rdd' });
  writeTaskFile(ws, task.id, 'requirements.md', '# Requirements');
  const ev = settle(ctxFor(ws, 'yolo'), task);
  assert.equal(ev.phase.id, 'build');
});

test('failed review sends the task back to build with the audit, then blocks after max retries', () => {
  const ws = makeWorkspace({ maxReviewRetries: 2 });
  const ctx = ctxFor(ws, 'yolo');
  const task = newTask(ws, { lane: 'rdd' });
  writeTaskFile(ws, task.id, 'requirements.md', '# R');

  for (let attempt = 1; attempt <= 2; attempt++) {
    writeTaskFile(ws, task.id, 'build-report.md', 'Status: DONE');
    writeTaskFile(ws, task.id, 'audit.md', '**Status:** FAILED\n## Required Action\n1. fix');
    const ev = settle(ctx, task);
    assert.equal(ev.phase.id, 'build', `attempt ${attempt} goes back to build`);
    assert.match(task.lastAudit, new RegExp(`history/audit\\.${attempt}\\.md$`));
    assert.equal(existsSync(join(ws.paths.tasks, task.id, 'build-report.md')), false);
  }

  writeTaskFile(ws, task.id, 'build-report.md', 'Status: DONE');
  writeTaskFile(ws, task.id, 'audit.md', 'Status: FAILED');
  const ev = settle(ctx, task);
  assert.equal(ev.type, 'blocked');
  assert.match(task.blockedReason, /falló 3 veces/);
});

test('passing review clears the failed audit and moves to archive', () => {
  const ws = makeWorkspace();
  const ctx = ctxFor(ws, 'yolo');
  const task = newTask(ws, { lane: 'rdd' });
  writeTaskFile(ws, task.id, 'requirements.md', '# R');
  writeTaskFile(ws, task.id, 'build-report.md', 'Status: DONE');
  writeTaskFile(ws, task.id, 'audit.md', 'Status: FAILED');
  settle(ctx, task);
  writeTaskFile(ws, task.id, 'build-report.md', 'Status: DONE');
  writeTaskFile(ws, task.id, 'audit.md', '- **Status:** PASSED');
  const ev = settle(ctx, task);
  assert.equal(ev.phase.id, 'archive');
  assert.equal(task.lastAudit, null);
});

test('escalation moves the task to a heavier lane and archives colliding outputs', () => {
  const ws = makeWorkspace();
  const ctx = ctxFor(ws);
  const task = newTask(ws, { lane: 'odd' });
  writeTaskFile(ws, task.id, 'problem.md', 'problem');
  writeTaskFile(ws, task.id, 'build-report.md', 'Status: DONE');
  writeTaskFile(ws, task.id, 'escalation.json', JSON.stringify({ to: 'sdd', reason: 'needs a migration' }));

  const ev = advance(ctx, task);
  assert.equal(ev.type, 'escalated');
  assert.equal(task.lane, 'sdd');
  assert.equal(task.status, 'explore');
  assert.equal(task.laneSource, 'escalation');
  const dir = join(ws.paths.tasks, task.id);
  assert.equal(existsSync(join(dir, 'build-report.md')), false, 'old build report must not satisfy the new lane');
  assert.equal(existsSync(join(dir, 'problem.md')), true, 'context is kept');
  assert.deepEqual(readdirSync(join(dir, 'history')).sort(), ['build-report.1.md', 'escalation.1.json']);
});

test('escalation to a lighter or unknown lane is ignored', () => {
  const ws = makeWorkspace();
  const task = newTask(ws, { lane: 'sdd' });
  writeTaskFile(ws, task.id, 'escalation.json', JSON.stringify({ to: 'odd' }));
  advance(ctxFor(ws), task);
  assert.equal(task.lane, 'sdd');
  assert.ok(task.history.some((h) => h.event === 'escalation_ignored'));
});

test('user can force a lane at any time', () => {
  const ws = makeWorkspace();
  const task = newTask(ws, { lane: 'sdd' });
  switchLane(ctxFor(ws), task, 'odd', 'user', ['user said so']);
  assert.equal(task.lane, 'odd');
  assert.equal(task.status, 'build');
});

test('SDD gate is on the spec, design has none', () => {
  const ws = makeWorkspace();
  const ctx = ctxFor(ws);
  const task = newTask(ws, { lane: 'sdd' });
  writeTaskFile(ws, task.id, 'context.md', 'ctx');
  writeTaskFile(ws, task.id, 'adr.md', 'adr');
  writeTaskFile(ws, task.id, 'spec.md', 'spec');
  const ev = settle(ctx, task);
  assert.equal(ev.type, 'awaiting_approval');
  assert.match(ev.artifact, /spec\.md$/);
});

test('dry-run still opens gates (it is a planning mode)', () => {
  const ws = makeWorkspace();
  const task = newTask(ws, { lane: 'rdd' });
  writeTaskFile(ws, task.id, 'requirements.md', '# R');
  assert.equal(advance(ctxFor(ws, 'dry-run'), task).type, 'awaiting_approval');
});

test('legacy v0.1 tasks are migrated', () => {
  assert.deepEqual(
    (({ lane, status }) => ({ lane, status }))(normalizeTask({ id: 'A', description: 'x', status: 'pending', type: 'hotfix' })),
    { lane: 'odd', status: 'build' },
  );
  assert.deepEqual(
    (({ lane, status }) => ({ lane, status }))(normalizeTask({ id: 'B', description: 'x', status: 'coding' })),
    { lane: 'sdd', status: 'build' },
  );
});

test('findTask skips completed and blocked tasks', () => {
  const data = { tasks: [] };
  const a = addTask(data, { description: 'a' });
  const b = addTask(data, { description: 'b' });
  const c = addTask(data, { description: 'c' });
  a.status = 'completed';
  b.status = 'blocked';
  assert.equal(findTask(data).id, c.id);
  assert.equal(c.id, 'T-003');
});
