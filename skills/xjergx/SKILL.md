---
name: xjergx
description: Continue work another coding agent started, hand off before switching tools, search or record shared project memory, and run the ODD/RDD/SDD ticket workflow. Use in any project with a .xjergx folder, at session start, before ending a session, or when the user mentions xjergx, the backlog, a ticket, a handoff or switching to another agent.
---

# xjergx: shared work across coding agents

The xjergx harness lets the user move between Claude Code, Codex, OpenCode, Pi and omp without losing context.
Everything lives in the repository (`.xjergx/`) and is reached through the `xjergx` CLI, so it works the same
from any tool.

## 1. Resume (always first)

```bash
xjergx resume
```

It prints: the last handoff (who, when, summary, next steps, open questions), whether there was work after it,
the active ticket and its phase (and any in-phase progress notes), uncommitted changes, recent memory and the
shared skills. Continue from it. If it warns about activity after the last handoff, inspect `git diff` and the
`progress-<phase>.md` file it mentions before trusting the next steps.

## 2. Memory

Search before deciding anything that may have been decided before:

```bash
xjergx memory search "csv export pagination"
xjergx memory show <id>
xjergx memory list --type decision
```

Record what a future session (in any tool) must know. Be brief and include the *why*:

```bash
xjergx memory add "Exports stream rows instead of buffering" \
  --type decision --tags exports,performance \
  --body "Orders can exceed 200k rows; buffering hit the 512MB limit. Use the streamCsv helper in src/lib/csv.ts."
```

Types: `decision`, `convention`, `gotcha`, `asset`, `preference`, `note`. Add `--global` for something true in all
of the user's projects (e.g. a personal preference). Do not store secrets or credentials.

## 3. Handoff (before the session ends or the user switches tools)

```bash
xjergx handoff --agent <claude|codex|opencode|pi|omp> \
  --summary "Implemented the CSV endpoint and its happy-path test; E2E for empty and huge exports pending." \
  --next "Write E2E-2 (empty result) and E2E-3 (200k rows) in tests/e2e/exports.spec.ts" \
  --next "Run the review phase: xjergx next --json" \
  --open "Should exports include cancelled orders?"
```

Write it as if the reader has none of your context: concrete files, commands and decisions. If you are in the
middle of a ticket phase, also keep the phase's `progress-<phase>.md` up to date.

## 4. Tickets (ODD / RDD / SDD)

```bash
xjergx add "Export orders as CSV"          # new ticket; the classifier picks the lane
xjergx next --json                         # what to do now
```

Act on `action`: `run_phase` → read `promptFile` and do exactly that phase (or delegate it to the subagent named
in `agent`); `approve` → show the artifact to the user, then `xjergx approve` or `xjergx reject --note "..."`;
`done` / `idle` / `stop` / `blocked` → report to the user. Never edit `.xjergx/backlog.json` by hand.

## 5. Skills and agents

Shared skills live in `.xjergx/skills/<name>/SKILL.md` and agents in `.xjergx/agents/<name>.md`. After creating or
editing one there, run `xjergx sync` so every tool gets it. If you created one in a tool-specific folder
(`.claude/skills`, `.codex/agents`, ...), run `xjergx import` and then `xjergx sync`.
