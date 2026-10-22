import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BASE_DIR } from './paths.js';

/** Git repositories in the workspace: the root itself and its direct children (a .git dir, or a .git file for worktrees/submodules). */
export function findRepos(root) {
  const repos = [];
  if (existsSync(join(root, '.git'))) repos.push(root);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && existsSync(join(root, entry.name, '.git'))) {
      repos.push(join(root, entry.name));
    }
  }
  return repos;
}

/**
 * A task starts from a clean tree so its changes can be reviewed and reverted as a unit.
 * Untracked files count; the harness's own folder does not.
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function preflight(root) {
  const repos = findRepos(root);
  if (!repos.length) {
    return { ok: false, problems: ['No encontré ningún repositorio git en el workspace (ni en la raíz ni un nivel abajo).'] };
  }
  const problems = [];
  for (const repo of repos) {
    const res = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    if (res.error) return { ok: false, problems: [`No pude ejecutar git: ${res.error.message}`] };
    if (res.status !== 0) {
      problems.push(`${relative(root, repo) || '.'}: git status falló (${res.stderr.trim()})`);
      continue;
    }
    const dirty = res.stdout
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.slice(3).replace(/^"/, '').startsWith(`${BASE_DIR}/`));
    if (dirty.length) {
      const name = relative(root, repo) || '.';
      problems.push(`${name}: ${dirty.length} cambio(s) sin commitear, por ejemplo: ${dirty.slice(0, 3).map((l) => l.trim()).join(', ')}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
