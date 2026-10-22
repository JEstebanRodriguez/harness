import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter, isAbsolute } from 'node:path';

/**
 * How to launch each coding agent.
 *  - interactive: a normal session the human can talk to (used for conversational phases)
 *  - headless:    one-shot, non-interactive run (used in yolo mode and for headless phases)
 * `{prompt}` is replaced by a one-line kickoff that points at the prompt file.
 *
 * Every entry can be overridden, and new agents added, from .xjergx/config.json → "adapters".
 */
export const BUILTIN_ADAPTERS = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    interactive: ['{prompt}'],
    headless: ['-p', '{prompt}', '--permission-mode', 'acceptEdits'],
  },
  opencode: {
    label: 'OpenCode',
    bin: 'opencode',
    interactive: ['--prompt', '{prompt}'],
    headless: ['run', '{prompt}'],
  },
  codex: {
    label: 'Codex CLI',
    bin: 'codex',
    interactive: ['{prompt}'],
    headless: ['exec', '--full-auto', '{prompt}'],
  },
  pi: {
    label: 'Pi',
    bin: 'pi',
    interactive: ['{prompt}'],
    headless: ['-p', '{prompt}'],
  },
};

/** Pseudo-agent: writes the prompt and lets the human paste it into any tool. */
export const MANUAL = 'manual';

export function resolveAdapter(name, config) {
  if (name === MANUAL) return { name, manual: true, label: 'manual' };
  const merged = { ...BUILTIN_ADAPTERS[name], ...config.adapters?.[name] };
  if (!merged.bin) {
    const known = [...Object.keys(BUILTIN_ADAPTERS), ...Object.keys(config.adapters ?? {}), MANUAL];
    throw new Error(`Agente desconocido "${name}". Disponibles: ${[...new Set(known)].join(', ')}.`);
  }
  for (const key of ['interactive', 'headless']) {
    if (!Array.isArray(merged[key]) || !merged[key].includes('{prompt}')) {
      throw new Error(`El adaptador "${name}" necesita "${key}" como lista de argumentos que incluya "{prompt}".`);
    }
  }
  return { name, label: merged.label ?? name, ...merged };
}

export function commandExists(bin) {
  if (isAbsolute(bin)) return existsSync(bin);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  return (process.env.PATH ?? '').split(delimiter).some((dir) => exts.some((ext) => existsSync(join(dir, bin + ext))));
}

export function buildArgs(adapter, { message, interactive }) {
  return (interactive ? adapter.interactive : adapter.headless).map((a) => (a === '{prompt}' ? message : a));
}

/**
 * Launch the agent and wait for it to exit. The agent shares the terminal so the
 * human can follow (and, in interactive sessions, answer) it.
 * @returns {Promise<number>} exit code
 */
export function invokeAgent(adapter, { message, interactive, cwd }) {
  const args = buildArgs(adapter, { message, interactive });
  const isWin = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    const child = spawn(adapter.bin, isWin ? args.map(quoteWin) : args, {
      cwd,
      stdio: 'inherit',
      shell: isWin, // .cmd shims need a shell on Windows
      env: { ...process.env, XJERGX: '1' },
    });
    child.on('error', (err) => reject(new Error(`No pude ejecutar "${adapter.bin}": ${err.message}`)));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function quoteWin(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}
