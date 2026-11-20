import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commandExists, BUILTIN_ADAPTERS } from './adapters.js';
import { engramStatus, codegraphStatus, runEngram, ENGRAM_SETUP_AGENT, CODEGRAPH_AGENTS } from './tools.js';

/**
 * Health report of the optional integrations, per target tool.
 * With fix=true it runs `engram setup <agent>` for every configured target Engram supports
 * (that is what connects each agent's MCP to the shared Engram database).
 */
export function doctor(ctx, { fix = false, targets }) {
  const root = ctx.paths.root;
  const engram = engramStatus(ctx.config);
  const engramBin = commandExists('engram');
  const codegraph = codegraphStatus(ctx.config, root);
  const report = {
    workspace: existsSync(ctx.paths.base),
    engram: { ...engram, installed: engramBin },
    codegraph: { ...codegraph, installed: commandExists('codegraph'), indexed: existsSync(join(root, '.codegraph')) },
    targets: [],
    actions: [],
  };

  for (const t of targets) {
    const bin = BUILTIN_ADAPTERS[t]?.bin ?? t;
    const setupName = ENGRAM_SETUP_AGENT[t];
    const row = { target: t, installed: commandExists(bin), engramSetup: setupName, codegraph: CODEGRAPH_AGENTS.includes(t) };
    if (fix && engramBin && setupName) {
      const res = runEngram(['setup', setupName], { cwd: root });
      row.fix = res.ok ? 'ok' : `falló: ${res.stderr || res.stdout || 'sin detalle'}`;
    }
    report.targets.push(row);
  }

  if (!engramBin) {
    report.actions.push('Instalá Engram para memoria persistente compartida (SQLite + MCP): `brew install gentleman-programming/tap/engram` o los releases de github.com/Gentleman-Programming/engram. Después: `xjergx doctor --fix`.');
  } else if (!fix) {
    report.actions.push('Conectá Engram a cada herramienta: `xjergx doctor --fix` (corre `engram setup <agente>`; reiniciá cada agente después).');
  }
  if (report.targets.some((r) => r.target === 'omp')) {
    report.actions.push('omp: `engram setup` no lo soporta; agregá el MCP de Engram (`engram mcp`) a la config de omp a mano.');
  }
  if (!report.codegraph.installed && !report.codegraph.indexed) {
    report.actions.push('Instalá codegraph para explorar el código con un grafo (menos tokens y llamadas): `npx @colbymchenry/codegraph`, después `codegraph init -i` en este workspace.');
  } else if (!report.codegraph.indexed) {
    report.actions.push('Indexá este workspace con codegraph: `codegraph init -i` (es interactivo: elegís a qué agentes conectarlo).');
  }
  const cgManual = report.targets.filter((r) => !r.codegraph).map((r) => r.target);
  if (cgManual.length && (report.codegraph.installed || report.codegraph.indexed)) {
    report.actions.push(`codegraph: su instalador no cubre ${cgManual.join(', ')}; agregá su servidor MCP a mano si lo querés ahí.`);
  }
  return report;
}

export function printDoctor(r) {
  const ok = (b) => (b ? '✓' : '✗');
  console.log(`Workspace xjergx        ${ok(r.workspace)}`);
  console.log(`Memoria                 ${r.engram.enabled ? 'Engram' : 'Markdown'} — ${r.engram.reason}`);
  console.log(`codegraph               ${r.codegraph.enabled ? 'activo' : 'inactivo'} — ${r.codegraph.reason}${r.codegraph.indexed ? ' (índice presente)' : ''}`);
  console.log('');
  console.log('HERRAMIENTA  INSTALADA  ENGRAM SETUP        CODEGRAPH INIT');
  for (const t of r.targets) {
    const setup = t.engramSetup ? `engram setup ${t.engramSetup}` : 'manual (MCP)';
    console.log(`${t.target.padEnd(11)}  ${ok(t.installed).padEnd(9)}  ${setup.padEnd(18)}  ${t.codegraph ? 'sí' : 'manual (MCP)'}${t.fix ? `   → setup ${t.fix}` : ''}`);
  }
  if (r.actions.length) {
    console.log('');
    for (const a of r.actions) console.log(`→ ${a}`);
  }
}
