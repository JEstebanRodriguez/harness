import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commandExists } from './adapters.js';

/**
 * Optional external tools the harness takes advantage of when they are installed.
 *  - Engram (github.com/Gentleman-Programming/engram): persistent memory over SQLite/FTS5 + MCP.
 *  - codegraph (github.com/colbymchenry/codegraph): tree-sitter code graph over MCP.
 * Nothing breaks without them: memory falls back to Markdown and exploration to plain search.
 * XJERGX_MEMORY_BACKEND (auto|engram|markdown) and XJERGX_CODEGRAPH (auto|on|off) override the config.
 */

/** Map of our targets to `engram setup <agent>` names (omp has none: configure its MCP manually). */
export const ENGRAM_SETUP_AGENT = { claude: 'claude-code', codex: 'codex', opencode: 'opencode', pi: 'pi', omp: null };

/** Agents codegraph's installer knows how to wire (pi/omp: add its MCP server by hand). */
export const CODEGRAPH_AGENTS = ['claude', 'codex', 'opencode'];

/** @returns {{ enabled: boolean, reason: string }} */
export function engramStatus(config) {
  const mode = process.env.XJERGX_MEMORY_BACKEND || config.memory?.backend || 'auto';
  if (mode === 'markdown') return { enabled: false, reason: 'memory.backend = "markdown"' };
  if (!commandExists('engram')) {
    return { enabled: false, reason: mode === 'engram' ? 'memory.backend = "engram" pero no encuentro el binario `engram` en el PATH' : 'Engram no está instalado' };
  }
  return { enabled: true, reason: mode === 'engram' ? 'memory.backend = "engram"' : 'Engram detectado en el PATH' };
}

/** @returns {{ enabled: boolean, reason: string }} */
export function codegraphStatus(config, root) {
  const mode = process.env.XJERGX_CODEGRAPH || config.codegraph || 'auto';
  if (mode === 'off') return { enabled: false, reason: 'codegraph = "off"' };
  if (mode === 'on') return { enabled: true, reason: 'codegraph = "on"' };
  if (root && existsSync(join(root, '.codegraph'))) return { enabled: true, reason: 'índice .codegraph/ en el workspace' };
  if (commandExists('codegraph')) return { enabled: true, reason: 'codegraph detectado en el PATH' };
  return { enabled: false, reason: 'codegraph no está instalado' };
}

/**
 * Run the engram CLI. Never throws: callers fall back to Markdown on failure.
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
export function runEngram(args, { cwd } = {}) {
  const res = spawnSync('engram', args, { cwd, encoding: 'utf8', timeout: 15000, env: process.env });
  if (res.error) return { ok: false, stdout: '', stderr: res.error.message };
  return { ok: res.status === 0, stdout: (res.stdout ?? '').trimEnd(), stderr: (res.stderr ?? '').trim() };
}
