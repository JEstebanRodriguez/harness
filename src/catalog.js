import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { PACKAGE_ROOT, globalPaths } from './paths.js';
import { allAgents } from './lanes.js';

/**
 * The canonical catalog: the single source every tool-specific file is generated from.
 *
 * Skills (Agent Skills standard, <name>/SKILL.md + any supporting files):
 *   bundled  <package>/skills/          shipped with the harness (e.g. `xjergx`)
 *   project  <workspace>/.xjergx/skills/
 *   global   ~/.xjergx/skills/
 * Agents (Markdown with `name` + `description` frontmatter, body = system prompt):
 *   bundled  <package>/agents/          the harness role agents
 *   project  <workspace>/.xjergx/agents/ role overrides and your own agents
 *   global   ~/.xjergx/agents/
 * A project item overrides a global one with the same name, which overrides a bundled one.
 */

export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function readSkillsFrom(dir, source) {
  if (!existsSync(dir)) return [];
  const skills = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const { meta } = parseFrontmatter(readFileSync(file, 'utf8'));
    skills.push({
      name: entry.name,
      dir: join(dir, entry.name),
      description: typeof meta.description === 'string' ? meta.description : '',
      source,
      problems: skillProblems(entry.name, meta),
    });
  }
  return skills;
}

/** Problems that would make a skill invisible or rejected in some tools (Codex is the strictest). */
export function skillProblems(dirName, meta) {
  const problems = [];
  if (!SKILL_NAME.test(dirName) || dirName.length > 64) problems.push('el nombre debe ser kebab-case en minúsculas (máx. 64)');
  if (meta.name && meta.name !== dirName) problems.push(`"name: ${meta.name}" no coincide con la carpeta "${dirName}"`);
  if (!meta.name) problems.push('falta "name" en el frontmatter');
  if (!meta.description) problems.push('falta "description" en el frontmatter');
  else if (String(meta.description).length > 1024) problems.push('"description" supera 1024 caracteres');
  return problems;
}

function readAgentsFrom(dir, source) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const { meta, body } = parseFrontmatter(readFileSync(join(dir, f), 'utf8'));
      const name = basename(f, '.md');
      return { name, description: meta.description ?? name, body, source, file: join(dir, f) };
    });
}

function mergeByName(...lists) {
  const map = new Map();
  for (const list of lists) for (const item of list) map.set(item.name, item);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {import('./paths.js').WorkspacePaths|null} paths  null = global scope only
 */
export function collectSkills(paths, { includeGlobal = true } = {}) {
  const g = globalPaths();
  if (!paths) return mergeByName(readSkillsFrom(g.skills, 'global'));
  return mergeByName(
    readSkillsFrom(join(PACKAGE_ROOT, 'skills'), 'bundled'),
    includeGlobal ? readSkillsFrom(g.skills, 'global') : [],
    readSkillsFrom(paths.skills, 'project'),
  );
}

export function collectAgents(paths) {
  const g = globalPaths();
  if (!paths) return mergeByName(readAgentsFrom(g.agents, 'global'));
  const roles = new Set(allAgents());
  const bundled = readAgentsFrom(join(PACKAGE_ROOT, 'agents'), 'bundled').filter((a) => roles.has(a.name));
  return mergeByName(bundled, readAgentsFrom(paths.agentOverrides, 'project')).map((a) => ({
    ...a,
    role: roles.has(a.name),
  }));
}
