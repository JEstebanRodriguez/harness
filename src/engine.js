import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LANES, CLASSIFY_PHASE, currentPhase, phaseAfter, firstPhase, isLane, laneRank,
} from './lanes.js';
import { verifyOutput, outputPath, archiveTaskFile } from './artifacts.js';
import { decideLane } from './router.js';
import { taskDir, display } from './paths.js';
import { now } from './backlog.js';

/**
 * The state machine. `advance` looks at what is on disk for the current phase
 * and moves the task forward only when the expected artifact is really there.
 * It never calls an agent: drivers (run) and hosts (next) do that.
 *
 * Event types:
 *  - completed          task finished
 *  - blocked            needs a human (agent BLOCKED, or too many failed reviews)
 *  - awaiting_approval  a gate is open: approve or reject
 *  - needs_agent        the current phase output is missing → an agent must run the phase
 *  - invalid_output     output exists but is malformed → the agent must redo it
 *  - advanced / escalated / retry  the task moved; call advance again
 *
 * @param {{ paths: import('./paths.js').WorkspacePaths, config: any, mode: string }} ctx
 * @param {import('./backlog.js').Task} task
 */
export function advance(ctx, task) {
  if (task.status === 'completed') return { type: 'completed', message: `${task.id} está completada.` };
  if (task.status === 'blocked') return { type: 'blocked', message: `${task.id} está bloqueada: ${task.blockedReason}` };
  if (task.awaitingApproval) {
    return {
      type: 'awaiting_approval',
      artifact: task.awaitingApproval.artifact,
      message: `${task.id} espera tu aprobación de ${task.awaitingApproval.artifact}.`,
    };
  }

  const escalation = readEscalation(ctx, task);
  if (escalation) return escalation;

  const phase = currentPhase(task);
  const result = verifyOutput(ctx.paths, task, phase);
  const out = display(ctx.paths, outputPath(ctx.paths, task, phase));

  if (result.state === 'missing') return { type: 'needs_agent', phase, message: `Falta ${out} (fase ${phase.id}).` };
  if (result.state === 'invalid') {
    return { type: 'invalid_output', phase, message: `${out} no es válido: ${result.detail}.` };
  }

  if (phase === CLASSIFY_PHASE) return applyClassification(ctx, task, result.data);

  if (result.state === 'blocked') {
    task.status = 'blocked';
    task.blockedReason = result.detail;
    log(task, 'blocked', { phase: phase.id, reason: result.detail });
    return { type: 'blocked', message: `${task.id} quedó bloqueada en ${phase.id}: ${result.detail}` };
  }

  if (result.state === 'failed') return retryAfterFailedAudit(ctx, task, phase);

  // Phase succeeded.
  if (task.feedback?.phase === phase.id) task.feedback = null;
  if (phase.retryPhase) task.lastAudit = null;
  const next = phaseAfter(task.lane, phase.id);
  task.status = next ? next.id : 'completed';
  log(task, 'phase_done', { phase: phase.id, output: out });

  if (phase.gate && ctx.mode !== 'yolo') {
    task.awaitingApproval = { phase: phase.id, artifact: out };
    return { type: 'awaiting_approval', artifact: out, message: `Fase ${phase.id} lista. Revisá ${out} y aprobalo.` };
  }
  return next
    ? { type: 'advanced', message: `${task.id}: ${phase.id} ✓ → ${next.id}` }
    : { type: 'completed', message: `${task.id} completada.` };
}

function applyClassification(ctx, task, classification) {
  const decision = decideLane(classification, ctx.config.router);
  task.lane = decision.lane;
  task.laneSource = 'router';
  task.laneReasons = decision.reasons;
  task.status = firstPhase(decision.lane).id;
  log(task, 'classified', {
    lane: decision.lane,
    reasons: decision.reasons,
    suggested_lane: classification.suggested_lane ?? null,
  });
  return {
    type: 'advanced',
    message: `${task.id} → carril ${LANES[decision.lane].name} (${decision.reasons.join('; ')})`,
  };
}

function retryAfterFailedAudit(ctx, task, phase) {
  const count = (task.attempts[phase.id] ?? 0) + 1;
  task.attempts[phase.id] = count;
  const auditFile = outputPath(ctx.paths, task, phase);
  const retryPhase = LANES[task.lane].phases.find((p) => p.id === phase.retryPhase);

  if (count > ctx.config.maxReviewRetries) {
    task.status = 'blocked';
    task.blockedReason = `la revisión falló ${count} veces; revisá ${display(ctx.paths, auditFile)}`;
    log(task, 'blocked', { phase: phase.id, reason: task.blockedReason });
    return { type: 'blocked', message: `${task.id} bloqueada: ${task.blockedReason}` };
  }

  const archivedAudit = archiveTaskFile(ctx.paths, task.id, phase.output);
  archiveTaskFile(ctx.paths, task.id, retryPhase.output);
  task.lastAudit = display(ctx.paths, archivedAudit);
  task.status = retryPhase.id;
  log(task, 'review_failed', { attempt: count, audit: task.lastAudit });
  return {
    type: 'retry',
    message: `Revisión fallida (${count}/${ctx.config.maxReviewRetries}). Vuelve a ${retryPhase.id} con ${task.lastAudit}.`,
  };
}

/** An agent can ask to move the task to a heavier lane by writing escalation.json. */
function readEscalation(ctx, task) {
  if (!task.lane || task.status === 'pending') return null;
  const file = join(taskDir(ctx.paths, task.id), 'escalation.json');
  if (!existsSync(file)) return null;

  let req;
  try {
    req = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    req = {};
  }
  archiveTaskFile(ctx.paths, task.id, 'escalation.json');
  if (!isLane(req.to) || laneRank(req.to) <= laneRank(task.lane)) {
    log(task, 'escalation_ignored', { request: req });
    return { type: 'advanced', message: `Pedido de escalado ignorado (solo se puede subir de carril): ${JSON.stringify(req)}` };
  }
  const from = task.lane;
  switchLane(ctx, task, req.to, 'escalation', [`escalado desde ${LANES[from].name}: ${req.reason ?? 'sin motivo'}`]);
  return { type: 'escalated', message: `${task.id} escalada de ${LANES[from].name} a ${LANES[req.to].name}: ${req.reason ?? ''}` };
}

/** Move a task to another lane, keeping useful context but archiving outputs the new lane would re-create. */
export function switchLane(ctx, task, lane, source, reasons) {
  if (!isLane(lane)) throw new Error(`Carril inválido "${lane}".`);
  for (const p of LANES[lane].phases) {
    if (p.output !== '@engram') archiveTaskFile(ctx.paths, task.id, p.output);
  }
  log(task, 'lane_changed', { from: task.lane, to: lane, source });
  task.lane = lane;
  task.laneSource = source;
  task.laneReasons = reasons;
  task.status = firstPhase(lane).id;
  task.awaitingApproval = null;
  task.feedback = null;
  task.lastAudit = null;
  task.blockedReason = null;
  task.attempts = {};
}

export function approve(task) {
  if (!task.awaitingApproval) throw new Error(`${task.id} no tiene nada pendiente de aprobación.`);
  log(task, 'approved', { phase: task.awaitingApproval.phase });
  task.awaitingApproval = null;
}

/** Reject a gated artifact: the phase runs again with the human's note. */
export function reject(ctx, task, note) {
  if (!task.awaitingApproval) throw new Error(`${task.id} no tiene nada pendiente de aprobación.`);
  const { phase: phaseId } = task.awaitingApproval;
  const phase = LANES[task.lane].phases.find((p) => p.id === phaseId);
  archiveTaskFile(ctx.paths, task.id, phase.output);
  task.status = phase.id;
  task.awaitingApproval = null;
  task.feedback = { phase: phase.id, note: note?.trim() || 'Rechazado sin comentarios: revisá el documento completo.' };
  log(task, 'rejected', { phase: phase.id, note: task.feedback.note });
}

/** Unblock a task so it retries the phase it was on (or a given one). */
export function unblock(ctx, task, phaseId) {
  if (task.status !== 'blocked') throw new Error(`${task.id} no está bloqueada.`);
  const last = [...task.history].reverse().find((h) => h.event === 'blocked');
  const target = phaseId ?? last?.phase;
  const phase = LANES[task.lane]?.phases.find((p) => p.id === target);
  if (!phase) throw new Error('No sé a qué fase volver; indicala con --phase.');
  // The old output (BLOCKED report / FAILED audit) would block the task again.
  if (phase.output !== '@engram') archiveTaskFile(ctx.paths, task.id, phase.output);
  task.status = target;
  task.blockedReason = null;
  task.attempts = {};
  log(task, 'unblocked', { phase: target });
}

function log(task, event, extra = {}) {
  task.history.push({ at: now(), event, ...extra });
}
