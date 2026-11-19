import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync, renameSync, mkdirSync } from 'node:fs';

export const BASE_DIR = '.xjergx';

/** Directory of the installed package (where the bundled role prompts and skills live). */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** User-level home shared by every project (global memory, skills and agents). XJERGX_HOME overrides it. */
export function globalHome() {
  return process.env.XJERGX_HOME || join(homedir(), BASE_DIR);
}

/**
 * Every path the harness touches inside a workspace.
 * @param {string} root workspace root
 */
export function workspacePaths(root) {
  const base = join(root, BASE_DIR);
  const memory = join(base, 'memory');
  return {
    root,
    base,
    backlog: join(base, 'backlog.json'),
    config: join(base, 'config.json'),
    tasks: join(base, 'tasks'),
    memory,
    /** Records written by the archivist at the end of each ticket. */
    engram: join(memory, 'tasks'),
    /** Ad-hoc memories written by any agent with `xjergx memory add`. */
    notes: join(memory, 'notes'),
    session: join(base, 'session.json'),
    /** Written by hooks after every turn; machine-local, git-ignored. */
    activity: join(base, 'activity.json'),
    sessions: join(base, 'sessions'),
    prompts: join(base, 'prompts'),
    /** Canonical agents: role overrides and your own custom agents. */
    agentOverrides: join(base, 'agents'),
    /** Canonical skills (Agent Skills format: <name>/SKILL.md). */
    skills: join(base, 'skills'),
    protocol: join(base, 'protocol.md'),
    manifest: join(base, 'sync-manifest.json'),
  };
}

/** @typedef {ReturnType<typeof workspacePaths>} WorkspacePaths */

/** Same layout for the user-level home: root is the home folder itself. */
export function globalPaths() {
  const base = globalHome();
  return {
    base,
    memory: join(base, 'memory'),
    notes: join(base, 'memory', 'notes'),
    skills: join(base, 'skills'),
    agents: join(base, 'agents'),
    manifest: join(base, 'sync-manifest.json'),
  };
}

export function taskDir(paths, taskId) {
  return join(paths.tasks, taskId);
}

/** Path shown to agents: always relative to the workspace and with forward slashes. */
export function display(paths, absPath) {
  const rel = relative(paths.root, absPath);
  return (rel.startsWith('..') ? absPath : rel).split('\\').join('/');
}

/** v0.2 kept archivist records in .xjergx/engram/. Move them into memory/tasks once. */
export function migrateLayout(paths) {
  const legacy = join(paths.base, 'engram');
  if (existsSync(legacy) && !existsSync(paths.engram)) {
    mkdirSync(paths.memory, { recursive: true });
    renameSync(legacy, paths.engram);
    return true;
  }
  return false;
}
