import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { install, upsertSection } from '../src/install.js';
import { allAgents } from '../src/lanes.js';
import { parseFrontmatter } from '../src/prompt.js';
import { makeWorkspace } from './helpers.js';

test('upsertSection appends once and then replaces in place', () => {
  const first = upsertSection('# My project\n\nRules.\n', 'v1');
  assert.match(first, /^# My project[\s\S]*v1/);
  const second = upsertSection(first, 'v2');
  assert.equal(second.match(/xjergx:start/g).length, 1);
  assert.match(second, /v2/);
  assert.doesNotMatch(second, /v1/);
  assert.match(second, /Rules\./);
});

test('install all writes native files for every agent and keeps AGENTS.md content', () => {
  const ws = makeWorkspace();
  writeFileSync(join(ws.root, 'AGENTS.md'), '# Existing rules\n');
  const files = install(ws.paths, 'all');

  for (const agent of allAgents()) {
    assert.ok(files.includes(`.claude/agents/${agent}.md`));
    assert.ok(files.includes(`.opencode/agent/${agent}.md`));
  }
  assert.ok(files.includes('.claude/commands/xjergx.md'));
  assert.ok(files.includes('.opencode/command/xjergx.md'));
  assert.ok(files.includes('.pi/prompts/xjergx.md'));

  const agentsMd = readFileSync(join(ws.root, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /# Existing rules/);
  assert.equal(agentsMd.match(/xjergx:start/g).length, 1, 'shared by opencode, codex and pi without duplicating');

  const sub = parseFrontmatter(readFileSync(join(ws.root, '.claude/agents/xjergx-classifier.md'), 'utf8'));
  assert.equal(sub.meta.name, 'xjergx-classifier');
  const oc = parseFrontmatter(readFileSync(join(ws.root, '.opencode/agent/xjergx-explorer.md'), 'utf8'));
  assert.equal(oc.meta.mode, 'subagent');
});

test('every bundled role prompt has a name matching its file and a description', () => {
  const ws = makeWorkspace();
  for (const agent of allAgents()) {
    const { meta } = parseFrontmatter(readFileSync(join(import.meta.dirname ?? '.', '..', 'agents', `${agent}.md`), 'utf8'));
    assert.equal(meta.name, agent);
    assert.ok(meta.description);
  }
  assert.throws(() => install(ws.paths, 'vscode'), /No sé instalar/);
});
