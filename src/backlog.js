import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isLane, firstPhase, TERMINAL_STATUSES } from './lanes.js';

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {string} description
 * @property {string} status            'pending' | phase id | 'completed' | 'blocked'
 * @property {string|null} lane         'odd' | 'rdd' | 'sdd' once known
 * @property {string|null} laneSource   'router' | 'user' | 'escalation'
 * @property {string[]} laneReasons
 * @property {Record<string, number>} attempts  failed reviews per phase
 * @property {{phase: string, artifact: string}|null} awaitingApproval
 * @property {{phase: string, note: string}|null} feedback  human feedback for a phase to redo
 * @property {string|null} lastAudit    previous failed audit (relative path) for the builder to fix
 * @property {string|null} blockedReason
 * @property {Array<object>} history
 */

export class NotInitializedError extends Error {}

export function now() {
  return new Date().toISOString();
}

export function loadBacklog(paths) {
  if (!existsSync(paths.backlog)) {
    throw new NotInitializedError('No hay backlog en este workspace. Ejecutá `xjergx init` primero.');
  }
  let data;
  try {
    data = JSON.parse(readFileSync(paths.backlog, 'utf8'));
  } catch (err) {
    throw new Error(`${paths.backlog} no es JSON válido: ${err.message}`);
  }
  if (!Array.isArray(data.tasks)) throw new Error(`${paths.backlog} debe tener un arreglo "tasks".`);
  data.tasks = data.tasks.map(normalizeTask);
  return data;
}

/** Atomic write: a crash never leaves a half-written backlog. */
export function saveBacklog(paths, data) {
  mkdirSync(dirname(paths.backlog), { recursive: true });
  const tmp = `${paths.backlog}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, paths.backlog);
}

/** Fill defaults and migrate tasks written by the old bash harness (type/status names). */
export function normalizeTask(raw) {
  const task = {
    id: String(raw.id),
    description: raw.description ?? '',
    status: raw.status ?? 'pending',
    lane: raw.lane ?? null,
    laneSource: raw.laneSource ?? null,
    laneReasons: raw.laneReasons ?? [],
    attempts: raw.attempts ?? {},
    awaitingApproval: raw.awaitingApproval ?? null,
    feedback: raw.feedback ?? null,
    lastAudit: raw.lastAudit ?? null,
    blockedReason: raw.blockedReason ?? null,
    history: raw.history ?? [],
    createdAt: raw.createdAt ?? now(),
  };

  // Legacy v0.1 (xjergx.sh): type "hotfix" meant the fast track.
  if (!task.lane && raw.type === 'hotfix') {
    task.lane = 'odd';
    task.laneSource = 'user';
    task.laneReasons = ['migrado de type "hotfix"'];
    if (task.status === 'pending') task.status = firstPhase('odd').id;
  }
  const legacy = { spec_ready: 'spec', coding: 'build', archiving: 'archive' };
  if (legacy[task.status]) {
    task.lane = task.lane ?? 'sdd';
    task.laneSource = task.laneSource ?? 'user';
    task.status = legacy[task.status];
  }
  return task;
}

export function findTask(data, id) {
  if (id) {
    const task = data.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`No existe la tarea ${id}.`);
    return task;
  }
  // Same rule as v0.1: the first task that is not finished. Blocked tasks need a human.
  return data.tasks.find((t) => !TERMINAL_STATUSES.includes(t.status)) ?? null;
}

export function nextTaskId(data) {
  const nums = data.tasks.map((t) => Number(/^T-(\d+)$/.exec(t.id)?.[1])).filter(Number.isFinite);
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return `T-${String(n).padStart(3, '0')}`;
}

/** @returns {Task} */
export function addTask(data, { description, lane, id }) {
  if (!description?.trim()) throw new Error('La tarea necesita una descripción.');
  if (lane && !isLane(lane)) throw new Error(`Carril inválido "${lane}". Usá odd, rdd o sdd.`);
  const taskId = id ?? nextTaskId(data);
  if (data.tasks.some((t) => t.id === taskId)) throw new Error(`Ya existe una tarea ${taskId}.`);
  const task = normalizeTask({ id: taskId, description: description.trim() });
  if (lane) {
    task.lane = lane;
    task.laneSource = 'user';
    task.laneReasons = ['carril elegido por el usuario'];
    task.status = firstPhase(lane).id;
  }
  task.history.push({ at: now(), event: 'created', lane: task.lane });
  data.tasks.push(task);
  return task;
}
