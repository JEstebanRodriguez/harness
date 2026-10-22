import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE_DIR = '.xjergx';

/** Directory of the installed package (where the bundled role prompts live). */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every path the harness touches inside a workspace.
 * @param {string} root workspace root
 */
export function workspacePaths(root) {
  const base = join(root, BASE_DIR);
  return {
    root,
    base,
    backlog: join(base, 'backlog.json'),
    config: join(base, 'config.json'),
    tasks: join(base, 'tasks'),
    engram: join(base, 'engram'),
    prompts: join(base, 'prompts'),
    agentOverrides: join(base, 'agents'),
  };
}

/** @typedef {ReturnType<typeof workspacePaths>} WorkspacePaths */

export function taskDir(paths, taskId) {
  return join(paths.tasks, taskId);
}

/** Path shown to agents: always relative to the workspace and with forward slashes. */
export function display(paths, absPath) {
  return relative(paths.root, absPath).split('\\').join('/');
}
