# EngEmil Pi Plan/Build Extension

A **three-mode** workflow extension for [Pi](https://pi.dev) that separates planning
from execution — inspired by the opencode "plan/build" agent model.

- **NORMAL** — vanilla pi. Full tools, no plan overhead. (default)
- **PLAN** — read-only exploration + plan authoring. Only the plan file is writable.
- **BUILD** — full execution with plan context injection and `[DONE:n]` progress tracking.

Switch modes three ways: the `alt+q` cycle, the `/plan` `/build` `/normal` commands,
or let the **model** propose a switch via the `plan_enter` / `plan_exit` tools (you
confirm in a dialog — just like opencode).

> Plan lives at `tmp/PLAN.md` by default. The extension creates `tmp/` and adds it to
> `.gitignore` automatically, so plans never get committed and your project root stays clean.

## Modes

### NORMAL (`💬 NORMAL`)

Vanilla pi — the "just code/chat" mode.

- Full tool access (whatever you or pi have configured)
- No plan context injected, no progress tracking, no widget
- `plan_enter` tool available so the model can suggest planning a complex task

### PLAN (`📋 PLAN`)

Read-only exploration and plan authoring.

- Read, grep, find, ls freely
- Bash restricted to a read-only allowlist (compound commands are split and checked)
- Write/edit **only** to the plan file (`tmp/PLAN.md` by default)
- A rich, opencode-style workflow prompt is injected every turn (understand → design →
  review → write plan → call `plan_exit`)
- `plan_exit` tool available — calls a dialog to switch to BUILD when the plan is ready

### BUILD (`🔨 BUILD`)

Full tool access for executing the plan.

- All tools available
- Plan context injected automatically (full plan on first turn / after compaction,
  remaining steps on subsequent turns)
- Progress tracked via `[DONE:n]` markers; checkboxes synced to the plan file on disk
- `plan_enter` tool available

## Installation

Pi auto-discovers extensions from two locations and hot-reloads them with `/reload`:

- **Global** — `~/.pi/agent/extensions/<name>/index.ts` (every project)
- **Project-local** — `.pi/extensions/<name>/index.ts` (trusted projects only)

### Global (recommended)

```bash
git clone https://github.com/engemil/ee_pi_plan_build_extension.git ~/.pi/agent/extensions/ee_plan_build_extension
# then, in a running pi session:
/reload
```

### Project-local

```bash
mkdir -p .pi/extensions/ee_plan_build_extension
cp index.ts utils.ts modes.ts prompts.ts tools.ts .pi/extensions/ee_plan_build_extension/
/reload
```

### Quick test (no install)

```bash
pi -e ./ee_pi_plan_build_extension/
```

> `pi -e` is for quick tests only and does not support `/reload`.

## Usage

### Switching modes

| Action | Effect |
|---|---|
| `alt+q` | Cycle: NORMAL → PLAN → BUILD → NORMAL |
| `/plan` | Enter PLAN mode |
| `/build` | Enter BUILD mode |
| `/normal` | Enter NORMAL mode |
| `/mode` | Show current mode |
| `/plan status` | Show plan progress |
| `/plan reset` | Empty the plan file (with confirm) and enter PLAN mode |
| `plan_exit` tool | Model-initiated PLAN → BUILD (you confirm) |
| `plan_enter` tool | Model-initiated → PLAN (you confirm) |

### CLI flags

```bash
pi -e ./ee_pi_plan_build_extension/ --plan          # start in PLAN
pi -e ./ee_pi_plan_build_extension/ --build         # start in BUILD
pi -e ./ee_pi_plan_build_extension/ --normal        # start in NORMAL (default)
pi -e ./ee_pi_plan_build_extension/ --plan-file ./docs/PLAN.md   # custom plan path
```

| Flag | Description |
|------|-------------|
| `--plan` | Start in PLAN mode |
| `--build` | Start in BUILD mode |
| `--normal` | Start in NORMAL mode (default) |
| `--plan-file <path>` | Custom plan file path (default: `tmp/PLAN.md`) |

## Session start & `/new` behavior

There is **no blocking modal** on entry — routine startup and `/new` go straight to
NORMAL (or the mode you flagged). The plan file is **never destroyed** by `/new`; it is
shared on disk across sessions.

- If a plan file with content exists, you get a one-line, non-blocking notice:
  `Plan found at tmp/PLAN.md — /plan to resume, /build to execute`.
- `/new` resets to NORMAL with fresh per-session state; the plan file is untouched.
- To clear a plan intentionally: `/plan reset` (asks for confirmation).
- On `resume`/`fork`, completion state is rebuilt by scanning assistant messages
  **only after the last build-context marker** — so an earlier plan's `[DONE:n]`
  markers don't bleed into the current one.

## Plan file format

Hybrid format — structured steps for tracking, freeform sections for context:

```markdown
# Plan: Refactor auth module

## Context
The auth module needs OAuth2 alongside the existing JWT flow. Code in src/auth/.

## Steps
1. [ ] Audit current auth module structure
2. [x] Add configuration for OAuth2 credentials
3. [ ] Write integration tests

## Notes
- Maintain backward compatibility with JWT
```

Only the `## Steps` section is parsed for progress tracking.

## How it works

### Tool-set management (no clobbering)

On session start the extension captures your **baseline** active tools once. Mode
switches only add/remove the two tools it manages (`plan_enter`, `plan_exit`) — your
MCP, SDK, and other-extension tools are preserved.

### PLAN enforcement (D1)

`edit`/`write` stay active so the model can author the plan file, but a `tool_call`
guard blocks writes to anything except the plan file. Bash is checked against a
read-only allowlist.

### Transition tools (`plan_enter` / `plan_exit`)

The model can propose a mode change; you confirm via a dialog. `plan_exit` is active
only in PLAN; `plan_enter` in NORMAL/BUILD. This mirrors opencode's plan_enter/plan_exit
and makes transitions deliberate.

### Context injection

- **PLAN:** the workflow prompt is re-injected every turn (robust to compaction).
- **BUILD:** full plan on the first turn after switching and after compaction; only
  remaining steps on subsequent turns. A one-time `BUILD_SWITCH` reminder is prepended
  on the plan → build transition.
- **NORMAL:** nothing is injected.

Stale mode-reminder messages are filtered out by the `context` event when the mode
changes.

### Progress tracking (BUILD)

When the agent completes a step it includes `[DONE:n]` in its response. The extension
marks the step done, updates `[ ]` → `[x]` in the plan file, refreshes the footer/widget,
and celebrates when all steps complete.

### State persistence

Mode and plan state are persisted via `pi.appendEntry()` so they survive restarts.

### Compaction

A custom compaction summary includes mode, plan title, and remaining steps. After
compaction the next BUILD turn re-injects the full plan.

## Bash allowlist (PLAN mode)

Commands are **split on `;`, `&&`, `||`, and `|`** and every segment must match a safe
read-only pattern. A destructive token anywhere (including inside `$(...)` substitution)
blocks the whole command.

**Allowed:** `cat`, `head`, `tail`, `less`, `grep`, `find`, `ls`, `pwd`, `echo`, `wc`,
`sort`, `diff`, `tree`, `git status/log/diff/show/branch`, `npm list/outdated`, `rg`,
`fd`, `bat`, `eza`, `jq`, `awk`, `curl`, and more.

**Blocked:** `rm`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, redirects (`>`, `>>`), `tee`,
`npm install`, `git add/commit/push/...`, `sudo`, `kill`, editors, etc.

> PLAN mode is a guardrail, not a sandbox — a determined prompt can still reach
> destructive operations through exotic shell features.

## Architecture

```
ee_pi_plan_build_extension/
├── index.ts      # entry: flags, commands, shortcut, event wiring (thin)
├── modes.ts      # PlanBuildController — mode state machine + tool-set management
├── tools.ts      # plan_enter / plan_exit transition tools
├── prompts.ts    # PLAN-workflow / BUILD-switch prompt text
├── utils.ts      # plan parsing, file ops, step tracking, safe-command, gitignore
└── README.md
```

## License

MIT License, see `LICENSE`.
