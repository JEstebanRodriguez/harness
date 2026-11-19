import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { workspacePaths, globalPaths, PACKAGE_ROOT, migrateLayout, display } from './paths.js';
import { loadConfig, MODES } from './config.js';
import { loadBacklog, saveBacklog, findTask, addTask } from './backlog.js';
import { LANES, isLane } from './lanes.js';
import { approve, reject, unblock, switchLane } from './engine.js';
import { nextAction, runTask } from './workflow.js';
import { syncProject, syncGlobal, importNative, TARGETS } from './sync.js';
import { addMemory, searchMemory, listMemory, findMemory, MEMORY_TYPES } from './memory.js';
import { handoff, resumeBrief, detectAgent } from './session.js';

const HELP = `xjergx — harness que elige ODD, RDD o SDD según el ticket y comparte memoria, skills,
agents y sesión entre Claude Code, Codex, OpenCode, Pi y omp.

Uso: xjergx <comando> [opciones]

Workspace
  init                         Crea .xjergx/ y genera los archivos de cada herramienta
  sync                         Regenera skills, agents, instrucciones y hooks de cada herramienta
      [--target claude|codex|opencode|pi|omp ...] [--global]
  import                       Adopta skills/agents creados en .claude/, .codex/, .opencode/, ...  [--global] [--force]

Continuidad entre agentes
  resume                       Contexto para retomar: último handoff, ticket, cambios, memoria  [--agent]
  handoff --summary "..."      Deja dicho dónde quedó todo  [--next "..."]... [--open "..."]... [--agent]

Memoria
  memory add "<título>"        [--body "..."] [--type ${MEMORY_TYPES.join('|')}] [--tags a,b] [--global]
  memory search "<términos>"   [--limit 10] [--json]
  memory list                  [--type] [--global] [--json]
  memory show <id>

Backlog
  add "<descripción>"          Agrega un ticket  [--lane odd|rdd|sdd] [--id T-123]
  status                       Lista los tickets  [--json]
  lane <ID> <odd|rdd|sdd>      Fuerza el carril de un ticket (reinicia sus fases)

Modo driver (xjergx lanza al agente en cada fase)
  run  [--agent claude|codex|opencode|pi|omp|manual] [--mode interactive|yolo|dry-run]
       [--task <ID>] [--step] [--skip-preflight]

Modo host (tu agente orquesta)
  next [--json] [--task] [--mode]
  approve | reject --note "..." | unblock [--phase <fase>]   [--task]
`;

const BOOLEANS = new Set(['json', 'step', 'skip-preflight', 'help', 'version', 'yolo', 'dry-run', 'interactive', 'global', 'force', 'auto']);

export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  const set = (key, value) => {
    if (flags[key] === undefined) flags[key] = value;
    else flags[key] = [].concat(flags[key], value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') flags.help = true;
    else if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s);
      if (inline !== undefined) set(key, inline);
      else if (BOOLEANS.has(key)) flags[key] = true;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) set(key, argv[++i]);
      else throw new Error(`Falta el valor de --${key}.`);
    } else positionals.push(arg);
  }
  // v0.1 shortcuts: --yolo / --dry-run / --interactive
  for (const m of MODES) if (flags[m] === true) flags.mode = m;
  return { positionals, flags };
}

const list = (v) => (v === undefined ? [] : [].concat(v));
const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
const csv = (v) => list(v).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean);

function context(root, flags) {
  const paths = workspacePaths(root);
  const config = loadConfig(paths);
  const mode = one(flags.mode) ?? config.mode;
  if (!MODES.includes(mode)) throw new Error(`Modo inválido "${mode}". Usá ${MODES.join(', ')}.`);
  if (existsSync(paths.base)) migrateLayout(paths);
  return { paths, config, mode };
}

function consoleIO() {
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const question = async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(q)).trim();
    } finally {
      rl.close();
    }
  };
  return {
    isTTY,
    log: (m) => console.log(m),
    warn: (m) => console.error(m),
    ask: question,
    confirm: async (q) => /^(s|si|sí|y|yes)$/i.test(await question(q)),
  };
}

function printNext(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const line of result.log ?? []) console.log(`· ${line}`);
  switch (result.action) {
    case 'run_phase':
      console.log(`\n▶ ${result.task} · fase ${result.phase} (${result.agent})`);
      console.log(`  ${result.instructions}`);
      break;
    case 'approve':
      console.log(`\n🛑 Revisá ${result.artifact} y ejecutá \`xjergx approve\` o \`xjergx reject --note "..."\`.`);
      break;
    case 'blocked':
      console.log(`\n⛔ ${result.reason}`);
      break;
    default:
      console.log(`\n${result.message ?? result.reason ?? result.action}`);
  }
}

function printStatus(data) {
  if (!data.tasks.length) {
    console.log('El backlog está vacío. Agregá un ticket con: xjergx add "<descripción>"');
    return;
  }
  const rows = data.tasks.map((t) => [
    t.id,
    t.lane ? LANES[t.lane].name : '—',
    t.status + (t.awaitingApproval ? ' (aprobación)' : ''),
    t.description.length > 60 ? `${t.description.slice(0, 57)}...` : t.description,
  ]);
  const head = ['ID', 'CARRIL', 'ESTADO', 'DESCRIPCIÓN'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(head));
  for (const r of rows) console.log(fmt(r));
}

const GITIGNORE_LINES = ['prompts/', 'activity.json', '*.tmp'];

function ensureGitignore(paths) {
  const file = join(paths.base, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '# Generated per machine / per phase\n';
  const missing = GITIGNORE_LINES.filter((l) => !current.split(/\r?\n/).includes(l));
  if (missing.length) writeFileSync(file, `${current.replace(/\s*$/, '\n')}${missing.join('\n')}\n`);
}

function init(paths) {
  mkdirSync(paths.base, { recursive: true });
  const created = [];
  if (!existsSync(paths.backlog)) {
    saveBacklog(paths, { tasks: [] });
    created.push('backlog.json');
  }
  if (!existsSync(paths.config)) {
    writeFileSync(paths.config, `${JSON.stringify({ agent: 'manual', mode: 'interactive', targets: TARGETS }, null, 2)}\n`);
    created.push('config.json');
  }
  for (const dir of [paths.notes, paths.engram, paths.skills, paths.agentOverrides]) mkdirSync(dir, { recursive: true });
  ensureGitignore(paths);
  return created;
}

function targetsFrom(flags, config) {
  const requested = csv(flags.target);
  if (requested.includes('all')) return TARGETS;
  return requested.length ? requested : config.targets;
}

function printSync(result, rootLabel) {
  if (result.written.length) {
    console.log(`Generado en ${rootLabel}:`);
    for (const f of result.written) console.log(`  ${f}`);
  } else console.log('Todo estaba al día.');
  for (const f of result.removed) console.log(`  − ${f} (ya no existe en la fuente)`);
  for (const f of result.conflicts) {
    console.error(`⚠ ${f} existe y no lo generó xjergx: no lo toqué. Si es tuyo, ejecutá \`xjergx import\` y después \`xjergx sync\`.`);
  }
  for (const s of result.skillProblems ?? []) {
    console.error(`⚠ skill ${s.name}: ${s.problems.join('; ')} (algunas herramientas podrían ignorarla).`);
  }
  for (const n of result.notes) console.log(`ℹ ${n}`);
}

function printMemoryEntries(entries, asJson) {
  if (asJson) {
    console.log(JSON.stringify(entries.map(({ body, ...rest }) => rest), null, 2));
    return;
  }
  if (!entries.length) {
    console.log('Sin resultados.');
    return;
  }
  for (const e of entries) {
    console.log(`[${e.type}] ${e.title}`);
    console.log(`   id: ${e.id}${e.tags.length ? ` · tags: ${e.tags.join(', ')}` : ''}${e.agent ? ` · por ${e.agent}` : ''} · ${e.created.slice(0, 10)}`);
    if (e.snippet) console.log(`   ${e.snippet}`);
  }
}

function memoryCommand(ctx, [sub, ...rest], flags) {
  const paths = existsSync(ctx.paths.base) ? ctx.paths : null;
  switch (sub) {
    case 'add': {
      const entry = addMemory(paths, {
        title: rest.join(' '),
        body: one(flags.body) ?? (flags.file ? readFileSync(one(flags.file), 'utf8') : ''),
        type: one(flags.type) ?? 'note',
        tags: csv(flags.tags),
        agent: one(flags.agent) ?? (detectAgent() === 'unknown' ? undefined : detectAgent()),
        task: one(flags.task),
        global: Boolean(flags.global),
      });
      console.log(`Guardado ${entry.id} (${entry.scope}).`);
      return 0;
    }
    case 'search': {
      const query = rest.join(' ');
      if (!query.trim()) throw new Error('Uso: xjergx memory search "<términos>"');
      printMemoryEntries(searchMemory(paths, query, { limit: Number(one(flags.limit) ?? 10) }), flags.json);
      return 0;
    }
    case 'list': {
      let entries = listMemory(paths, { scope: flags.global ? 'global' : undefined });
      if (flags.type) entries = entries.filter((e) => e.type === one(flags.type));
      printMemoryEntries(entries.map((e) => ({ ...e, snippet: '' })), flags.json);
      return 0;
    }
    case 'show': {
      const entry = rest[0] && findMemory(paths, rest[0]);
      if (!entry) throw new Error(`No encontré la memoria "${rest[0] ?? ''}". Probá con xjergx memory search.`);
      console.log(readFileSync(entry.file, 'utf8'));
      return 0;
    }
    default:
      throw new Error('Uso: xjergx memory <add|search|list|show>');
  }
}

/** @returns {Promise<number>} exit code */
export async function main(argv, root = process.cwd()) {
  const { positionals, flags } = parseArgs(argv);
  const [cmd, ...rest] = positionals;

  if (flags.version) {
    console.log(JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version);
    return 0;
  }
  if (!cmd || flags.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }

  const ctx = context(root, flags);
  const { paths } = ctx;
  const initialized = existsSync(paths.base);

  switch (cmd) {
    case 'init': {
      const created = init(paths);
      console.log(created.length ? `Creado en .xjergx/: ${created.join(', ')}` : '.xjergx/ ya estaba inicializado.');
      const result = syncProject(paths, loadConfig(paths).targets);
      printSync(result, 'el workspace');
      console.log('\nSiguiente: commiteá .xjergx/ y los archivos generados, y agregá un ticket con xjergx add "<descripción>".');
      return 0;
    }

    case 'sync': {
      const targets = targetsFrom(flags, ctx.config);
      if (flags.global) {
        printSync(syncGlobal(targets), homedir());
        return 0;
      }
      if (!initialized) throw new Error('No hay .xjergx/ aquí. Ejecutá `xjergx init` (o usá --global).');
      ensureGitignore(paths);
      printSync(syncProject(paths, targets), 'el workspace');
      return 0;
    }

    case 'install': {
      // v0.2 name, kept as an alias: xjergx install <tool|all>
      if (!rest[0]) throw new Error(`Uso: xjergx install <${TARGETS.join('|')}|all>`);
      if (!initialized) init(paths);
      printSync(syncProject(paths, rest[0] === 'all' ? TARGETS : [rest[0]]), 'el workspace');
      return 0;
    }

    case 'import': {
      if (!flags.global && !initialized) throw new Error('No hay .xjergx/ aquí. Ejecutá `xjergx init` primero.');
      const g = globalPaths();
      const result = flags.global
        ? importNative({ root: homedir(), manifestFile: g.manifest, skillsDir: g.skills, agentsDir: g.agents, scope: 'global', force: flags.force })
        : importNative({ root, manifestFile: paths.manifest, skillsDir: paths.skills, agentsDir: paths.agentOverrides, scope: 'project', force: flags.force });
      for (const s of result.skills) console.log(`skill  ${s}`);
      for (const a of result.agents) console.log(`agent  ${a}`);
      for (const s of result.skipped) console.error(`⚠ omitido: ${s}`);
      if (!result.skills.length && !result.agents.length) console.log('No encontré skills ni agents nuevos para importar.');
      else console.log(`\nListo. Ejecutá \`xjergx sync${flags.global ? ' --global' : ''}\` para llevarlos a todas las herramientas.`);
      return 0;
    }

    case 'resume': {
      // Runs from SessionStart hooks: never fail, never print noise outside a workspace.
      if (!initialized) return 0;
      try {
        console.log(resumeBrief(paths, { agent: one(flags.agent) }));
      } catch (err) {
        console.error(`xjergx resume: ${err.message}`);
      }
      return 0;
    }

    case 'handoff': {
      if (!initialized) {
        if (flags.auto) return 0;
        throw new Error('No hay .xjergx/ aquí. Ejecutá `xjergx init` primero.');
      }
      const res = handoff(paths, {
        summary: one(flags.summary),
        next: list(flags.next),
        open: list(flags.open),
        agent: one(flags.agent),
        auto: Boolean(flags.auto),
      });
      if (!flags.auto) {
        console.log(`Handoff guardado (${res.handoff.agent}). Cualquier agente lo verá con \`xjergx resume\`.`);
        console.log(`Diario: ${display(paths, res.journal)}`);
      }
      return 0;
    }

    case 'memory':
      return memoryCommand(ctx, rest, flags);

    case 'add': {
      const data = loadBacklog(paths);
      const task = addTask(data, { description: rest.join(' '), lane: one(flags.lane), id: one(flags.id) });
      saveBacklog(paths, data);
      console.log(`Agregada ${task.id}${task.lane ? ` en carril ${LANES[task.lane].name}` : ' (el carril se decide al clasificarla)'}.`);
      return 0;
    }

    case 'status': {
      const data = loadBacklog(paths);
      if (flags.json) console.log(JSON.stringify(data, null, 2));
      else printStatus(data);
      return 0;
    }

    case 'lane': {
      const [id, lane] = rest;
      if (!id || !isLane(lane)) throw new Error('Uso: xjergx lane <ID> <odd|rdd|sdd>');
      const data = loadBacklog(paths);
      const task = findTask(data, id);
      switchLane(ctx, task, lane, 'user', ['carril elegido por el usuario']);
      saveBacklog(paths, data);
      console.log(`${task.id} ahora va por ${LANES[lane].name}; empieza en la fase ${task.status}.`);
      return 0;
    }

    case 'next': {
      const result = nextAction(ctx, { taskId: one(flags.task), skipPreflight: flags['skip-preflight'] });
      printNext(result, flags.json);
      return result.action === 'blocked' ? 2 : 0;
    }

    case 'approve':
    case 'reject':
    case 'unblock': {
      const data = loadBacklog(paths);
      const task = flags.task
        ? findTask(data, one(flags.task))
        : data.tasks.find((t) => (cmd === 'unblock' ? t.status === 'blocked' : t.awaitingApproval));
      if (!task) throw new Error(cmd === 'unblock' ? 'No hay tareas bloqueadas.' : 'No hay nada esperando aprobación.');
      if (cmd === 'approve') approve(task);
      else if (cmd === 'reject') reject(ctx, task, one(flags.note));
      else unblock(ctx, task, one(flags.phase));
      saveBacklog(paths, data);
      console.log(`${task.id}: ${cmd === 'approve' ? 'aprobado' : cmd === 'reject' ? 'rechazado, la fase se repite' : `desbloqueado, vuelve a ${task.status}`}.`);
      return 0;
    }

    case 'run':
      return runTask(ctx, {
        agent: one(flags.agent),
        taskId: one(flags.task),
        step: flags.step,
        skipPreflight: flags['skip-preflight'],
      }, consoleIO());

    default:
      throw new Error(`Comando desconocido "${cmd}". Ejecutá xjergx help.`);
  }
}
