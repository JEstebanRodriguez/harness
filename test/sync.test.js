import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncProject, syncGlobal, importNative, upsertSection, mergeHooks, TARGETS } from '../src/sync.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { parseTomlStrings } from '../src/toml.js';
import { allAgents } from '../src/lanes.js';
import { globalPaths } from '../src/paths.js';
import { makeWorkspace } from './helpers.js';

const read = (ws, p) => readFileSync(join(ws.root, p), 'utf8');

function addSkill(dir, name, description = `Does ${name}`, extra = {}) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nSteps.\n`);
  for (const [f, c] of Object.entries(extra)) writeFileSync(join(dir, name, f), c);
}

function addAgent(dir, name, body = 'You review SQL migrations.') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: Reviews ${name}\n---\n\n${body}\n`);
}

test('one canonical skill and agent reach every tool in its native format', () => {
  const ws = makeWorkspace();
  addSkill(ws.paths.skills, 'db-migrations', 'Write safe DB migrations', { 'checklist.md': '- lock timeout' });
  addAgent(ws.paths.agentOverrides, 'sql-reviewer', 'Check for \\d+ "locks"');

  const r = syncProject(ws.paths, TARGETS);
  assert.deepEqual(r.conflicts, []);

  // Skills: Claude/omp read .claude/skills; Codex, OpenCode and Pi read .agents/skills.
  for (const base of ['.claude/skills', '.agents/skills']) {
    assert.match(read(ws, `${base}/db-migrations/SKILL.md`), /Write safe DB migrations/);
    assert.equal(read(ws, `${base}/db-migrations/checklist.md`), '- lock timeout', 'supporting files are copied');
    assert.ok(existsSync(join(ws.root, base, 'xjergx/SKILL.md')), 'bundled xjergx skill is shared too');
  }

  // Custom agent, full body, every format.
  const claude = parseFrontmatter(read(ws, '.claude/agents/sql-reviewer.md'));
  assert.equal(claude.meta.name, 'sql-reviewer');
  assert.match(claude.body, /Check for \\d\+ "locks"/);
  const codex = parseTomlStrings(read(ws, '.codex/agents/sql-reviewer.toml'));
  assert.equal(codex.name, 'sql-reviewer');
  assert.equal(codex.developer_instructions.trim(), 'Check for \\d+ "locks"');
  const oc = parseFrontmatter(read(ws, '.opencode/agents/sql-reviewer.md'));
  assert.equal(oc.meta.mode, 'subagent');
  assert.match(read(ws, '.pi/prompts/sql-reviewer.md'), /\$ARGUMENTS/);

  // Role agents become stubs pointing at the phase prompt (not in Pi, which has no subagents).
  for (const role of allAgents()) {
    assert.match(read(ws, `.claude/agents/${role}.md`), /prompt file/);
    assert.ok(existsSync(join(ws.root, `.codex/agents/${role}.toml`)));
    assert.ok(existsSync(join(ws.root, `.opencode/agents/${role}.md`)));
    assert.equal(existsSync(join(ws.root, `.pi/prompts/${role}.md`)), false);
  }

  // Instructions: one protocol, imported by Claude, inlined in AGENTS.md for the rest.
  assert.match(read(ws, 'CLAUDE.md'), /@\.xjergx\/protocol\.md/);
  assert.match(read(ws, '.xjergx/protocol.md'), /xjergx resume/);
  assert.equal(read(ws, 'AGENTS.md').match(/xjergx:start/g).length, 1);
  assert.match(read(ws, 'AGENTS.md'), /xjergx handoff --agent/);
  for (const cmd of ['.claude/commands/xjergx.md', '.opencode/commands/xjergx.md', '.pi/prompts/xjergx.md']) {
    assert.match(read(ws, cmd), /xjergx resume/);
  }

  // Hooks: resume at session start, activity snapshot when the agent stops.
  for (const [file, agent] of [['.claude/settings.json', 'claude'], ['.codex/hooks.json', 'codex']]) {
    const hooks = JSON.parse(read(ws, file)).hooks;
    assert.match(hooks.SessionStart[0].hooks[0].command, new RegExp(`xjergx resume --agent ${agent}`));
    assert.match(hooks.Stop[0].hooks[0].command, new RegExp(`handoff --auto --agent ${agent}`));
  }
});

test('sync is idempotent, follows renames and never touches files it did not write', () => {
  const ws = makeWorkspace();
  addSkill(ws.paths.skills, 'old-name');
  // A skill the user wrote by hand directly for Claude.
  addSkill(join(ws.root, '.claude/skills'), 'handmade');
  writeFileSync(join(ws.root, 'AGENTS.md'), '# House rules\n');
  mkdirSync(join(ws.root, '.claude'), { recursive: true });
  writeFileSync(join(ws.root, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));

  syncProject(ws.paths, TARGETS);
  const second = syncProject(ws.paths, TARGETS);
  assert.deepEqual(second.written, [], 'nothing changes on a second run');

  rmSync(join(ws.paths.skills, 'old-name'), { recursive: true });
  addSkill(ws.paths.skills, 'new-name');
  const third = syncProject(ws.paths, TARGETS);
  assert.ok(third.removed.includes('.claude/skills/old-name/'));
  assert.ok(third.removed.includes('.agents/skills/old-name/'));
  assert.ok(existsSync(join(ws.root, '.agents/skills/new-name/SKILL.md')));
  assert.ok(existsSync(join(ws.root, '.claude/skills/handmade/SKILL.md')), 'user files survive');

  assert.match(read(ws, 'AGENTS.md'), /^# House rules/);
  const settings = JSON.parse(read(ws, '.claude/settings.json'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] });
  assert.equal(settings.hooks.Stop.length, 2, "user's own Stop hook is kept");
  assert.equal(settings.hooks.SessionStart.length, 1, 'our hook is not duplicated');
});

test('a native file with the same name is reported as a conflict, not overwritten', () => {
  const ws = makeWorkspace();
  addSkill(ws.paths.skills, 'deploy', 'canonical');
  addSkill(join(ws.root, '.agents/skills'), 'deploy', 'hand written for codex');
  const r = syncProject(ws.paths, ['codex']);
  assert.deepEqual(r.conflicts, ['.agents/skills/deploy/']);
  assert.match(read(ws, '.agents/skills/deploy/SKILL.md'), /hand written for codex/);
});

test('syncing one tool does not remove files owned by another', () => {
  const ws = makeWorkspace();
  addSkill(ws.paths.skills, 'shared');
  syncProject(ws.paths, ['codex', 'pi']);
  syncProject(ws.paths, ['codex']);
  assert.ok(existsSync(join(ws.root, '.agents/skills/shared/SKILL.md')));
  assert.ok(existsSync(join(ws.root, '.pi/prompts/xjergx.md')));
});

test('v0.2 opencode files in singular folders are cleaned up', () => {
  const ws = makeWorkspace();
  mkdirSync(join(ws.root, '.opencode/agent'), { recursive: true });
  writeFileSync(join(ws.root, '.opencode/agent/xjergx-explorer.md'), '---\ndescription: x\n---\n<!-- Generated by `xjergx install`. Re-run it -->\n');
  writeFileSync(join(ws.root, '.opencode/agent/mine.md'), '---\ndescription: mine\n---\nmine');
  const r = syncProject(ws.paths, ['opencode']);
  assert.ok(r.removed.includes('.opencode/agent/xjergx-explorer.md'));
  assert.ok(existsSync(join(ws.root, '.opencode/agent/mine.md')));
});

test('import adopts a Claude skill and a Codex agent so every tool gets them', () => {
  const ws = makeWorkspace();
  addSkill(join(ws.root, '.claude/skills'), 'release-notes', 'Write release notes');
  mkdirSync(join(ws.root, '.codex/agents'), { recursive: true });
  writeFileSync(join(ws.root, '.codex/agents/scout.toml'), `name = "scout"\ndescription = "Read-only explorer"\nmodel = "gpt-5"\ndeveloper_instructions = """\nStay in exploration mode.\n"""\n`);
  syncProject(ws.paths, ['claude', 'codex']); // generated files must not be re-imported

  const imp = importNative({ root: ws.root, manifestFile: ws.paths.manifest, skillsDir: ws.paths.skills, agentsDir: ws.paths.agentOverrides, scope: 'project' });
  assert.deepEqual(imp.skills, ['.claude/skills/release-notes/ → release-notes']);
  assert.deepEqual(imp.agents, ['.codex/agents/scout.toml → scout']);

  // The originals are now duplicates of what sync generates: remove them as the user would.
  rmSync(join(ws.root, '.claude/skills/release-notes'), { recursive: true });
  rmSync(join(ws.root, '.codex/agents/scout.toml'));
  const r = syncProject(ws.paths, TARGETS);
  assert.deepEqual(r.conflicts, []);
  assert.match(read(ws, '.agents/skills/release-notes/SKILL.md'), /Write release notes/);
  assert.match(read(ws, '.opencode/agents/scout.md'), /Stay in exploration mode/);
  assert.match(read(ws, '.claude/agents/scout.md'), /Read-only explorer/);
  assert.equal(parseTomlStrings(read(ws, '.codex/agents/scout.toml')).developer_instructions.trim(), 'Stay in exploration mode.');

  const again = importNative({ root: ws.root, manifestFile: ws.paths.manifest, skillsDir: ws.paths.skills, agentsDir: ws.paths.agentOverrides, scope: 'project' });
  assert.deepEqual([...again.skills, ...again.agents], [], 'generated copies are never re-imported');
});

test('global skills and agents sync to every tool user folder', () => {
  const home = mkdtempSync(join(tmpdir(), 'xjergx-userhome-'));
  const g = globalPaths();
  addSkill(g.skills, 'my-style', 'How I like code');
  addAgent(g.agents, 'pair', 'Pair program with me.');
  const r = syncGlobal(TARGETS, home);
  assert.deepEqual(r.conflicts, []);
  for (const p of ['.claude/skills/my-style/SKILL.md', '.agents/skills/my-style/SKILL.md', '.claude/agents/pair.md',
    '.codex/agents/pair.toml', '.config/opencode/agents/pair.md', '.pi/agent/prompts/pair.md']) {
    assert.ok(existsSync(join(home, p)), p);
  }
  assert.equal(readdirSync(join(home, '.claude/agents')).length, 1, 'no role stubs at user level');
  rmSync(g.skills, { recursive: true });
  rmSync(g.agents, { recursive: true });
});

test('helpers: section upsert and hook merge are safe', () => {
  const once = upsertSection('# Rules', 'v1');
  assert.equal(upsertSection(once, 'v2').match(/xjergx:start/g).length, 1);
  assert.equal(mergeHooks('{ not json', 'claude'), null);
  const twice = JSON.parse(mergeHooks(mergeHooks('', 'codex'), 'codex'));
  assert.equal(twice.hooks.SessionStart.length, 1);
});
