/**
 * Lane definitions. A task's `status` is the id of the phase it must run next,
 * plus the special values `pending` (not classified yet), `completed` and `blocked`.
 *
 * Phase fields:
 *  - agent:      role prompt in agents/<agent>.md
 *  - output:     file the phase must produce inside the task folder ('@engram' = .xjergx/engram/<id>.md)
 *  - check:      how the harness verifies the output (see src/artifacts.js)
 *  - gate:       in interactive/dry-run mode a human approves the output before moving on
 *  - writesCode: dry-run mode stops before this phase
 *  - headless:   always run without an interactive session (no human talk needed)
 *  - retryPhase: on a FAILED audit the task goes back to this phase
 */

/** Lanes ordered from lightest to heaviest. Escalation only moves to the right. */
export const LANE_ORDER = ['odd', 'rdd', 'sdd'];

export const CLASSIFY_PHASE = {
  id: 'classify',
  agent: 'xjergx-classifier',
  output: 'classification.json',
  check: 'classification',
  headless: true,
};

const ARCHIVE_PHASE = {
  id: 'archive',
  agent: 'xjergx-memory-archivist',
  output: '@engram',
  check: 'exists',
  headless: true,
};

export const LANES = {
  odd: {
    name: 'ODD',
    title: 'Organic Driven Development',
    summary: 'Small or exploratory change: sketch usage, make it run, add a few tests per slice.',
    phases: [
      { id: 'build', agent: 'xjergx-odd-builder', output: 'build-report.md', check: 'report', writesCode: true },
      ARCHIVE_PHASE,
    ],
  },
  rdd: {
    name: 'RDD',
    title: 'Requirement Driven Development',
    summary: 'Medium change with known requirements: use cases, happy-path tests, core, then E2E for bad/worst cases.',
    phases: [
      { id: 'requirements', agent: 'xjergx-rdd-analyst', output: 'requirements.md', check: 'exists', gate: true },
      { id: 'build', agent: 'xjergx-rdd-builder', output: 'build-report.md', check: 'report', writesCode: true },
      { id: 'review', agent: 'xjergx-rdd-reviewer', output: 'audit.md', check: 'audit', retryPhase: 'build', headless: true },
      ARCHIVE_PHASE,
    ],
  },
  sdd: {
    name: 'SDD',
    title: 'Spec Driven Development',
    summary: 'Large or risky change: exploration, architecture interview + ADR, OpenSpec contract, code, strict audit.',
    phases: [
      { id: 'explore', agent: 'xjergx-explorer', output: 'context.md', check: 'exists', headless: true },
      { id: 'design', agent: 'xjergx-spec-designer', output: 'adr.md', check: 'exists' },
      { id: 'spec', agent: 'xjergx-spec-writer', output: 'spec.md', check: 'exists', gate: true },
      { id: 'build', agent: 'xjergx-code-writer', output: 'build-report.md', check: 'report', writesCode: true },
      { id: 'review', agent: 'xjergx-code-reviewer', output: 'audit.md', check: 'audit', retryPhase: 'build', headless: true },
      ARCHIVE_PHASE,
    ],
  },
};

export const TERMINAL_STATUSES = ['completed', 'blocked'];

export function isLane(value) {
  return Object.hasOwn(LANES, value);
}

export function laneRank(lane) {
  return LANE_ORDER.indexOf(lane);
}

export function firstPhase(lane) {
  return LANES[lane].phases[0];
}

/** Phase the task has to run next, or null when it is terminal. */
export function currentPhase(task) {
  if (task.status === 'pending') return CLASSIFY_PHASE;
  if (TERMINAL_STATUSES.includes(task.status)) return null;
  const phase = LANES[task.lane]?.phases.find((p) => p.id === task.status);
  if (!phase) throw new Error(`La tarea ${task.id} tiene un estado inválido "${task.status}" para el carril "${task.lane}".`);
  return phase;
}

export function phaseAfter(lane, phaseId) {
  const phases = LANES[lane].phases;
  const i = phases.findIndex((p) => p.id === phaseId);
  return phases[i + 1] ?? null;
}

/** Every agent role referenced by any lane (used by `install`). */
export function allAgents() {
  const names = new Set([CLASSIFY_PHASE.agent]);
  for (const lane of Object.values(LANES)) for (const p of lane.phases) names.add(p.agent);
  return [...names];
}
