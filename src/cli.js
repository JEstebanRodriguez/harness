import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { workspacePaths, PACKAGE_ROOT } from './paths.js';
import { loadConfig, MODES } from './config.js';
import { loadBacklog, saveBacklog, findTask, addTask } from './backlog.js';
import { LANES, isLane } from './lanes.js';
import { approve, reject, unblock, switchLane } from './engine.js';
import { nextAction, runTask } from './workflow.js';
import { install, INSTALL_TARGETS } from './install.js';

const HELP = `xjergx — harness que elige ODD, RDD o SDD según el ticket, para cualquier agente.

Uso: xjergx <comando> [opciones]

Backlog
  init                         Crea .xjergx/ (backlog, config) en el directorio actual
  add "<descripción>"          Agrega un ticket  [--lane odd|rdd|sdd] [--id T-123]
  status                       Lista los tickets  [--json]
  lane <ID> <odd|rdd|sdd>      Fuerza el carril de un ticket (reinicia sus fases)

Modo driver (xjergx lanza al agente en cada fase)
  run                          Ejecuta el ticket activo hasta un gate, bloqueo o fin
      --agent claude|opencode|codex|pi|manual   (default: config.agent)
      --mode interactive|yolo|dry-run           (default: config.mode)
      --task <ID>  --step (una sola fase)  --skip-preflight

Modo host (tu agente orquesta; ver \`install\`)
  next                         Avanza y dice qué hacer a continuación  [--json] [--task] [--mode]
  approve                      Aprueba el documento en revisión  [--task]
  reject --note "..."          Lo rechaza: la fase se repite con tu comentario  [--task]
  unblock                      Reintenta un ticket bloqueado  [--task] [--phase <fase>]

Integración
  install <claude|opencode|codex|pi|all>   Genera comandos/subagentes nativos y AGENTS.md
`;

export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  const booleans = new Set(['json', 'step', 'skip-preflight', 'help', 'version', 'yolo', 'dry-run', 'interactive']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') flags.help = true;
    else if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s);
      if (inline !== undefined) flags[key] = inline;
      else if (booleans.has(key)) flags[key] = true;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else throw new Error(`Falta el valor de --${key}.`);
    } else positionals.push(arg);
  }
  // v0.1 shortcuts: --yolo / --dry-run / --interactive
  for (const m of MODES) if (flags[m] === true) flags.mode = m;
  return { positionals, flags };
}

function context(root, flags) {
  const paths = workspacePaths(root);
  const config = loadConfig(paths);
  const mode = flags.mode ?? config.mode;
  if (!MODES.includes(mode)) throw new Error(`Modo inválido "${mode}". Usá ${MODES.join(', ')}.`);
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

function init(paths) {
  mkdirSync(paths.base, { recursive: true });
  const created = [];
  if (!existsSync(paths.backlog)) {
    saveBacklog(paths, { tasks: [] });
    created.push('backlog.json');
  }
  if (!existsSync(paths.config)) {
    writeFileSync(paths.config, `${JSON.stringify({ agent: 'manual', mode: 'interactive' }, null, 2)}\n`);
    created.push('config.json');
  }
  const ignore = join(paths.base, '.gitignore');
  if (!existsSync(ignore)) {
    writeFileSync(ignore, '# Prompts are regenerated for every phase\nprompts/\n*.tmp\n');
    created.push('.gitignore');
  }
  return created;
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

  switch (cmd) {
    case 'init': {
      const created = init(paths);
      console.log(created.length ? `Creado en .xjergx/: ${created.join(', ')}` : '.xjergx/ ya estaba inicializado.');
      console.log('Siguiente: xjergx add "<descripción del ticket>"');
      return 0;
    }

    case 'add': {
      const data = loadBacklog(paths);
      const task = addTask(data, { description: rest.join(' '), lane: flags.lane, id: flags.id });
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
      const result = nextAction(ctx, { taskId: flags.task, skipPreflight: flags['skip-preflight'] });
      printNext(result, flags.json);
      return result.action === 'blocked' ? 2 : 0;
    }

    case 'approve':
    case 'reject':
    case 'unblock': {
      const data = loadBacklog(paths);
      const task = flags.task
        ? findTask(data, flags.task)
        : data.tasks.find((t) => (cmd === 'unblock' ? t.status === 'blocked' : t.awaitingApproval));
      if (!task) throw new Error(cmd === 'unblock' ? 'No hay tareas bloqueadas.' : 'No hay nada esperando aprobación.');
      if (cmd === 'approve') approve(task);
      else if (cmd === 'reject') reject(ctx, task, flags.note);
      else unblock(ctx, task, flags.phase);
      saveBacklog(paths, data);
      console.log(`${task.id}: ${cmd === 'approve' ? 'aprobado' : cmd === 'reject' ? 'rechazado, la fase se repite' : `desbloqueado, vuelve a ${task.status}`}.`);
      return 0;
    }

    case 'run':
      return runTask(ctx, {
        agent: flags.agent,
        taskId: flags.task,
        step: flags.step,
        skipPreflight: flags['skip-preflight'],
      }, consoleIO());

    case 'install': {
      const target = rest[0];
      if (!target) throw new Error(`Uso: xjergx install <${INSTALL_TARGETS.join('|')}|all>`);
      const written = install(paths, target);
      console.log('Archivos generados:');
      for (const f of written) console.log(`  ${f}`);
      return 0;
    }

    default:
      throw new Error(`Comando desconocido "${cmd}". Ejecutá xjergx help.`);
  }
}
