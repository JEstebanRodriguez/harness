import { LANES, CLASSIFY_PHASE } from './lanes.js';
import { advance, approve, reject } from './engine.js';
import { loadBacklog, saveBacklog, findTask, now } from './backlog.js';
import { writePrompt, kickoffMessage } from './prompt.js';
import { outputPath, archiveTaskFile } from './artifacts.js';
import { display } from './paths.js';
import { resolveAdapter, invokeAgent, commandExists } from './adapters.js';
import { preflight } from './preflight.js';

const MAX_STEPS = 50; // guard against a malformed state looping forever

/** Identifies one attempt at a phase: any state change (retry, escalation, approval) yields a new key. */
function phaseKey(task, phase) {
  return `${task.lane}:${phase.id}:${task.history.length}`;
}

/** Interactive/conversational phases open a normal session; the rest run headless. */
export function wantsInteractiveSession(ctx, phase) {
  return ctx.mode !== 'yolo' && !phase.headless;
}

/** Shared preparation for a phase that an agent has to run. */
function preparePhase(ctx, task, phase, eventType) {
  // A malformed output would be mistaken for the new one; keep it for reference instead.
  if (eventType === 'invalid_output' && phase.output !== '@engram') archiveTaskFile(ctx.paths, task.id, phase.output);
  const promptFile = writePrompt(ctx, task, phase);
  task.history.push({ at: now(), event: 'phase_started', phase: phase.id });
  return {
    promptFile,
    output: display(ctx.paths, outputPath(ctx.paths, task, phase)),
    message: kickoffMessage(ctx, promptFile),
  };
}

/** Preflight only guards the start of a task: once a phase has run, the tree is dirty on purpose. */
function checkPreflight(ctx, task, opts) {
  const started = task.history.some((h) => h.event !== 'created');
  if (started) return null;
  if (opts.skipPreflight || !ctx.config.preflight) return null;
  const res = preflight(ctx.paths.root);
  return res.ok ? null : res.problems;
}

/**
 * HOST MODE — used when the coding agent itself is the orchestrator.
 * Advances the state as far as it can and returns the single next thing the host must do.
 */
export function nextAction(ctx, opts = {}) {
  const data = loadBacklog(ctx.paths);
  const task = findTask(data, opts.taskId);
  if (!task) return { action: 'idle', log: [], message: 'No hay tareas pendientes en el backlog.' };

  const problems = checkPreflight(ctx, task, opts);
  if (problems) {
    return { action: 'blocked', task: task.id, log: [], reason: `Preflight: ${problems.join(' | ')}. Commiteá o stasheá, o usá --skip-preflight.` };
  }

  const log = [];
  for (let i = 0; i < MAX_STEPS; i++) {
    const ev = advance(ctx, task);
    saveBacklog(ctx.paths, data);
    log.push(ev.message);
    const base = { task: task.id, lane: task.lane, status: task.status, log };

    switch (ev.type) {
      case 'completed':
        return { ...base, action: 'done', message: ev.message };
      case 'blocked':
        return { ...base, action: 'blocked', reason: task.blockedReason ?? ev.message };
      case 'awaiting_approval':
        return {
          ...base,
          action: 'approve',
          artifact: ev.artifact,
          instructions: 'Show the artifact to the user and ask for approval. Yes → run `xjergx approve`. No → run `xjergx reject --note "<their feedback>"`. Then run `xjergx next` again.',
        };
      case 'needs_agent':
      case 'invalid_output': {
        const { phase } = ev;
        if (ctx.mode === 'dry-run' && phase.writesCode) {
          return { ...base, action: 'stop', reason: 'dry-run: el plan está listo y la siguiente fase escribe código.' };
        }
        const prep = preparePhase(ctx, task, phase, ev.type);
        saveBacklog(ctx.paths, data);
        return {
          ...base,
          action: 'run_phase',
          phase: phase.id,
          agent: phase.agent,
          promptFile: display(ctx.paths, prep.promptFile),
          output: prep.output,
          conversational: wantsInteractiveSession(ctx, phase),
          instructions: `Read ${display(ctx.paths, prep.promptFile)} and follow it (or delegate it to the ${phase.agent} subagent). When ${prep.output} exists, run \`xjergx next\` again.`,
        };
      }
      default:
        continue; // advanced, escalated, retry
    }
  }
  throw new Error('La máquina de estados no se estabilizó; revisá el backlog.');
}

/**
 * DRIVER MODE — the harness launches the coding agent for each phase and loops.
 * @param {object} io { log(msg), warn(msg), confirm(q): Promise<boolean>, ask(q): Promise<string>, isTTY: boolean }
 * @returns {Promise<number>} process exit code
 */
export async function runTask(ctx, opts, io) {
  const adapter = resolveAdapter(opts.agent ?? ctx.config.agent, ctx.config);
  if (!adapter.manual && !commandExists(adapter.bin)) {
    io.warn(`No encuentro "${adapter.bin}" en el PATH. Instalá ${adapter.label} o usá --agent manual.`);
    return 1;
  }

  const data = loadBacklog(ctx.paths);
  const task = findTask(data, opts.taskId);
  if (!task) {
    io.log('No hay tareas pendientes en el backlog.');
    return 0;
  }

  const problems = checkPreflight(ctx, task, opts);
  if (problems) {
    io.warn('Preflight falló:');
    for (const p of problems) io.warn(`  - ${p}`);
    io.warn('Commiteá o stasheá esos cambios, o usá --skip-preflight.');
    return 1;
  }

  io.log(`▶ ${task.id}: ${task.description}`);
  io.log(`  modo ${ctx.mode} · agente ${adapter.label}${task.lane ? ` · carril ${LANES[task.lane].name}` : ''}`);

  const invoked = new Set();
  let ranAgent = false;

  for (let i = 0; i < MAX_STEPS; i++) {
    const ev = advance(ctx, task);
    saveBacklog(ctx.paths, data);

    switch (ev.type) {
      case 'completed':
        io.log(`✅ ${ev.message}`);
        return 0;

      case 'blocked':
        io.warn(`⛔ ${ev.message}`);
        io.warn(`   Cuando lo resuelvas: xjergx unblock --task ${task.id}`);
        return 2;

      case 'advanced':
      case 'escalated':
      case 'retry':
        io.log(`${ev.type === 'escalated' ? '⤴' : ev.type === 'retry' ? '↺' : '✓'} ${ev.message}`);
        if (opts.step && ranAgent) return 0;
        continue;

      case 'awaiting_approval': {
        io.log(`🛑 ${ev.message}`);
        if (!io.isTTY) {
          io.log(`   Aprobá con: xjergx approve --task ${task.id}   ·   o rechazá con: xjergx reject --task ${task.id} --note "..."`);
          return 0;
        }
        if (await io.confirm(`¿Aprobás ${ev.artifact}? (s/n) `)) {
          approve(task);
          io.log('✓ Aprobado.');
        } else {
          const note = await io.ask('¿Qué hay que cambiar? ');
          reject(ctx, task, note);
          io.log('↺ Rechazado: la fase se repite con tu comentario.');
        }
        saveBacklog(ctx.paths, data);
        continue;
      }

      case 'needs_agent':
      case 'invalid_output': {
        const { phase } = ev;
        if (ev.type === 'invalid_output') io.warn(`⚠ ${ev.message}`);
        if (invoked.has(phaseKey(task, phase))) {
          io.warn(`⚠ El agente terminó la fase ${phase.id} sin dejar un resultado válido en ${display(ctx.paths, outputPath(ctx.paths, task, phase))}.`);
          io.warn('   Revisá la sesión y volvé a ejecutar `xjergx run` para reintentar.');
          return 1;
        }
        if (ctx.mode === 'dry-run' && phase.writesCode) {
          io.log('📝 dry-run: el plan está listo. Me detengo antes de escribir código.');
          return 0;
        }

        const prep = preparePhase(ctx, task, phase, ev.type);
        saveBacklog(ctx.paths, data);
        const label = phase === CLASSIFY_PHASE ? 'clasificación' : phase.id;

        if (adapter.manual) {
          io.log(`\n📄 Fase ${label}: pegale esto a tu agente (Claude, OpenCode, Codex, Pi, ...):\n`);
          io.log(`   ${prep.message}\n`);
          io.log(`   Debe dejar el resultado en ${prep.output}. Después ejecutá \`xjergx run\` otra vez.`);
          return 0;
        }

        const interactive = wantsInteractiveSession(ctx, phase);
        io.log(`\n▶ Fase ${label} → ${phase.agent} con ${adapter.label} (${interactive ? 'sesión interactiva: cerrala cuando la fase termine' : 'headless'})`);
        const code = await invokeAgent(adapter, { message: prep.message, interactive, cwd: ctx.paths.root });
        // Keyed after preparePhase logged the start: if nothing else happens, the next lap sees the same key.
        invoked.add(phaseKey(task, phase));
        ranAgent = true;
        if (code !== 0) io.warn(`⚠ ${adapter.label} terminó con código ${code}. Verifico igual lo que dejó.`);
        continue;
      }

      default:
        throw new Error(`Evento desconocido: ${ev.type}`);
    }
  }
  throw new Error('La máquina de estados no se estabilizó; revisá el backlog.');
}
