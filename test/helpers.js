import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { workspacePaths } from '../src/paths.js';
import { DEFAULT_CONFIG, mergeDeep } from '../src/config.js';
import { saveBacklog } from '../src/backlog.js';

// Never touch the real ~/.xjergx from tests.
process.env.XJERGX_HOME = mkdtempSync(join(tmpdir(), 'xjergx-home-'));
delete process.env.XJERGX_AGENT;
// Never route to a real Engram install or depend on codegraph from tests (engram tests opt in).
process.env.XJERGX_MEMORY_BACKEND = 'markdown';
process.env.XJERGX_CODEGRAPH = 'off';

export function makeWorkspace(configOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'xjergx-'));
  const paths = workspacePaths(root);
  mkdirSync(paths.base, { recursive: true });
  saveBacklog(paths, { tasks: [] });
  const config = mergeDeep(DEFAULT_CONFIG, configOverrides);
  return { root, paths, config };
}

export function ctxFor(ws, mode = 'interactive') {
  return { paths: ws.paths, config: ws.config, mode };
}

export function writeTaskFile(ws, taskId, name, content) {
  const file = join(ws.paths.tasks, taskId, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

export const SMALL = {
  files_estimate: 1,
  touches_contract: false,
  sensitive_area: false,
  multi_repo: false,
  requirements_clarity: 'clear',
  design_certainty: 'obvious',
  summary: 'Fix a typo in the header component.',
};
