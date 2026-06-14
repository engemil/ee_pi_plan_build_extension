# EngEmil Pi (AI Coding Harness) Plan/Build Extension

A two-mode workflow extension for [Pi](https://pi.dev) that separates planning from execution — inspired by the opencode "plan/build" pattern.

The idea is simple:
- **PLAN mode**: Read-only exploration. Safely analyze code and build a plan in `PLAN.md`.
- **BUILD mode**: Full tool access. Execute the plan with progress tracking.
- Toggle between them with `alt+q` or `/plan`.

## Modes

### PLAN Mode (`📋 PLAN`)

Read-only exploration mode for safe code analysis and planning.

- Read files, grep, find, ls freely
- Bash restricted to an allowlist of read-only commands
- Write/edit access **only** to `PLAN.md`
- Cannot modify any other files
- Context injection tells the LLM it's in plan mode and how to format the plan

### BUILD Mode (`🔨 BUILD`)

Full tool access for executing the plan.

- All tools available (read, bash, edit, write, grep, find, ls)
- Plan context injected automatically
- Progress tracked via `[DONE:n]` markers in assistant responses
- `PLAN.md` checkboxes updated on disk when steps complete

## Installation

Pi auto-discovers extensions from two locations and lets you hot-reload them with
`/reload` (no restart needed):

- **Global** — `~/.pi/agent/extensions/<name>/index.ts` (available in every project)
- **Project-local** — `.pi/extensions/<name>/index.ts` (loads only after the project is trusted)

### Global install (recommended)

Copy this repo into pi's global extensions directory as a named subfolder, so that
`index.ts` sits at its root:

```bash
git clone https://github.com/engemil/ee_pi_plan_build_extension.git ~/.pi/agent/extensions/ee_plan_build_extension

# Then, in a running pi session, load it without restarting:
/reload
```

### Project-local install

Same idea, scoped to a single project (must be a trusted project):

```bash
mkdir -p .pi/extensions/ee_plan_build_extension
cp index.ts utils.ts .pi/extensions/ee_plan_build_extension/

# then:
/reload
```

### Quick test (no install)

```bash
pi -e ./ee_pi_plan_build_extension/
```

> `pi -e` is for quick tests only and does **not** support `/reload` — restart pi to
> pick up changes. Use a global or project-local install for hot-reload.

## Usage

CLI flags are passed at launch (shown here with the `pi -e` quick-test form; once
installed, just start `pi` normally):

```bash
# Start directly in plan mode
pi -e ./ee_pi_plan_build_extension/ --plan

# Use a custom plan file path
pi -e ./ee_pi_plan_build_extension/ --plan --plan-file ./docs/PLAN.md
```

## Toggle

- **Keyboard:** `alt+q`
- **Slash command:** `/plan`

## Commands

| Command | Description |
|---------|-------------|
| `/plan` | Toggle between PLAN and BUILD mode |
| `/plan status` | Show current plan progress |
| `/plan reset` | Empty PLAN.md and switch to PLAN mode |

## CLI Flags

| Flag | Description |
|------|-------------|
| `--plan` | Start in PLAN mode |
| `--plan-file <path>` | Custom plan file path (default: `PLAN.md` in cwd) |

## PLAN.md Format

The extension uses a hybrid format — structured steps for tracking, freeform sections for context, for example:

```markdown
# Plan: Refactor auth module

## Context
The auth module needs to support OAuth2 in addition to the existing JWT flow.
Current code is in src/auth/. Tests in tests/auth/.

## Steps
1. [ ] Audit current auth module structure
2. [ ] Design OAuth2 integration points
3. [ ] Implement OAuth2 provider interface
4. [x] Add configuration for OAuth2 credentials
5. [ ] Write integration tests

## Notes
- Must maintain backward compatibility with existing JWT flow
- Consider using passport.js for OAuth2
```

Only the `## Steps` section is parsed for progress tracking. Everything else is freeform.

## How It Works

### Progress Tracking (BUILD Mode)

When the agent completes a step, it includes a `[DONE:n]` marker in its response (e.g. `[DONE:3]`). The extension:

1. Detects the marker in `turn_end`
2. Updates the in-memory step to completed
3. Updates `[ ]` → `[x]` in `PLAN.md` on disk
4. Refreshes the footer status and widget
5. When all steps complete, sends a celebration message

### Context Injection (BUILD Mode)

- **First turn after switching to BUILD:** Full `PLAN.md` content injected via `before_agent_start`
- **After compaction:** Full `PLAN.md` content re-injected
- **Subsequent turns:** Only remaining unchecked steps injected

This balances full context when needed with token efficiency during execution.

### Context Injection (PLAN Mode)

On every turn, the LLM receives instructions explaining:
- It's in read-only PLAN mode
- What restrictions apply
- How to format the plan in `PLAN.md`

### Tool Call Interception (PLAN Mode)

The `tool_call` event handler:
- Blocks `write`/`edit` to anything except the plan file
- Blocks bash commands that aren't in the safe allowlist
- Returns a helpful message telling the user to switch to BUILD mode

### Session Start Behavior

On fresh Pi launch or `/new`:
- If `PLAN.md` has content → presents a selection dialog:
  - **Continue existing plan** → enters PLAN mode to review
  - **Start a new plan** → empties `PLAN.md`, enters PLAN mode
  - **Ignore plan** → enters BUILD mode without plan tracking
- If no `PLAN.md` → starts in BUILD mode (unless `--plan` flag)

### .gitignore Check

On first `PLAN.md` creation, the extension checks if the plan file is in `.gitignore`. If not, it prompts the user whether to add it.

### State Persistence

Mode and plan state are persisted via `pi.appendEntry()` so they survive session restarts. On resume, completion state is rebuilt by scanning past assistant messages for `[DONE:n]` markers.

### Compaction

Custom compaction summary (via `session_before_compact`) includes plan state — mode, progress, and remaining steps — so context is preserved across compaction boundaries.

### Context Filtering

Stale plan/build context messages are filtered out via the `context` event when the mode has changed, preventing confusion from old mode instructions.

## Visual Indicators

- **Footer status:** `📋 PLAN (alt+q)` or `🔨 BUILD 3/7 (alt+q)`
- **Widget (PLAN mode):** Full step checklist with ☑/☐ markers
- **Widget (BUILD mode):** Remaining steps with progress header

## Bash Allowlist (PLAN Mode)

**Allowed (safe patterns):** `cat`, `head`, `tail`, `less`, `grep`, `find`, `ls`, `pwd`, `echo`, `wc`, `sort`, `diff`, `tree`, `git status/log/diff/show/branch`, `npm list/outdated`, `rg`, `fd`, `bat`, `eza`, `jq`, `awk`, `curl`, and more read-only commands.

**Blocked (destructive patterns):** `rm`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `npm install`, `git add/commit/push/pull/merge/rebase/reset`, `sudo`, `kill`, `vim`, `nano`, redirects (`>`, `>>`), and other destructive commands.

## Architecture

```
ee_pi_plan_build_extension/
├── index.ts   # Extension entry point — events, commands, shortcuts, flags, UI
├── utils.ts   # PLAN.md parsing, file ops, step tracking, safe command checking
└── README.md  # This file
```

### Key Extension APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerFlag()` | `--plan` and `--plan-file` CLI flags |
| `pi.registerShortcut()` | `alt+q` toggle |
| `pi.registerCommand()` | `/plan` command with subcommands |
| `pi.on("tool_call")` | Block writes/destructive bash in PLAN mode |
| `pi.on("before_agent_start")` | Inject plan context per turn |
| `pi.on("context")` | Filter stale mode context messages |
| `pi.on("turn_end")` | Detect `[DONE:n]` markers, update progress |
| `pi.on("session_before_compact")` | Include plan state in compaction summary |
| `pi.on("session_compact")` | Mark next turn for full context re-injection |
| `pi.on("session_start")` | Initialize state, show session start dialog |
| `pi.setActiveTools()` | Restrict tool set per mode |
| `pi.appendEntry()` | Persist mode state across restarts |
| `pi.sendMessage()` | Send completion celebration message |
| `ctx.ui.setStatus()` | Footer mode indicator |
| `ctx.ui.setWidget()` | Step checklist widget |
| `ctx.ui.select()` | Session start dialog |
| `ctx.ui.confirm()` | .gitignore prompt |
| `ctx.ui.notify()` | Mode switch notifications |


## License

MIT License, see ´LiCENSE`-file for details.
