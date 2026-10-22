import { existsSync, readFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { taskDir } from './paths.js';
import { validateClassification } from './router.js';

/** Absolute path of a phase output for a task. */
export function outputPath(paths, task, phase) {
  if (phase.output === '@engram') return join(paths.engram, `${task.id}.md`);
  return join(taskDir(paths, task.id), phase.output);
}

export function readStatusLine(text) {
  // Accepts "Status: DONE", "- **Status:** PASSED", "**Status**: FAILED", etc.
  const m = text.match(/status\**\s*:\s*\**\s*\[?\s*(DONE|BLOCKED|PASSED|FAILED)\b/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Verify the output of a phase.
 * @returns {{ state: 'missing'|'invalid'|'ok'|'blocked'|'failed', detail?: string, data?: any }}
 */
export function verifyOutput(paths, task, phase) {
  const file = outputPath(paths, task, phase);
  if (!existsSync(file)) return { state: 'missing' };
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return { state: 'invalid', detail: 'el archivo está vacío' };

  switch (phase.check) {
    case 'exists':
      return { state: 'ok' };

    case 'classification': {
      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        return { state: 'invalid', detail: `JSON inválido: ${err.message}` };
      }
      const { ok, errors } = validateClassification(data);
      return ok ? { state: 'ok', data } : { state: 'invalid', detail: errors.join('; ') };
    }

    case 'report': {
      const status = readStatusLine(text);
      if (status === 'DONE') return { state: 'ok' };
      if (status === 'BLOCKED') return { state: 'blocked', detail: blockedReason(text) };
      return { state: 'invalid', detail: 'falta la línea "Status: DONE" o "Status: BLOCKED"' };
    }

    case 'audit': {
      const status = readStatusLine(text);
      if (status === 'PASSED') return { state: 'ok' };
      if (status === 'FAILED') return { state: 'failed' };
      return { state: 'invalid', detail: 'falta la línea "Status: PASSED" o "Status: FAILED"' };
    }

    default:
      throw new Error(`Chequeo desconocido: ${phase.check}`);
  }
}

function blockedReason(text) {
  const m = text.match(/reason\**\s*:\s*\**\s*(.+)/i);
  return m ? m[1].trim() : 'el agente reportó BLOCKED (ver build-report.md)';
}

/**
 * Move a task file to the task's history/ folder so a phase can run again
 * without the harness mistaking the old file for fresh output.
 * @returns {string|null} new absolute path
 */
export function archiveTaskFile(paths, taskId, fileName) {
  const dir = taskDir(paths, taskId);
  const src = join(dir, fileName);
  if (!existsSync(src)) return null;
  const historyDir = join(dir, 'history');
  mkdirSync(historyDir, { recursive: true });
  const ext = extname(fileName);
  const stem = basename(fileName, ext);
  const taken = readdirSync(historyDir).filter((f) => f.startsWith(`${stem}.`)).length;
  const dest = join(historyDir, `${stem}.${taken + 1}${ext}`);
  renameSync(src, dest);
  return dest;
}

/** Files currently present in the task folder (not history), sorted. */
export function listTaskArtifacts(paths, taskId) {
  const dir = taskDir(paths, taskId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(dir, e.name))
    .sort();
}
