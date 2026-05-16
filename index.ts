/**
 * EE Pi Plan/Build Extension
 *
 * Two-mode workflow for Pi: PLAN mode for read-only exploration and planning,
 * BUILD mode for full execution. Plan is stored in a PLAN.md file.
 *
 * Features:
 * - alt+q or /plan to toggle between PLAN and BUILD modes
 * - PLAN mode: read-only tools + write access only to PLAN.md
 * - BUILD mode: full tool access with plan context injection
 * - Progress tracking: [DONE:n] markers update PLAN.md checkboxes
 * - Session start dialog: continue, start fresh, or ignore existing plan
 * - Custom compaction summary includes plan state
 * - --plan flag to start in PLAN mode
 * - --plan-file flag for custom plan file path
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve, basename } from "node:path";
import {
	readPlanFile,
	writePlanFile,
	emptyPlanFile,
	planFileHasContent,
	planFileExists,
	formatPlanContent,
	markCompletedSteps,
	updatePlanFileCompletions,
	getRemainingSteps,
	getCompletedCount,
	formatStepsForContext,
	formatProgressSummary,
	isSafeCommand,
	isInGitignore,
	addToGitignore,
	type PlanFile,
} from "./utils.js";

// ── Constants ────────────────────────────────────────────────────────────────

type Mode = "plan" | "build";

const PLAN_MODE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const BUILD_MODE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const DEFAULT_PLAN_FILENAME = "PLAN.md";

// ── Helpers ──────────────────────────────────────────────────────────────────

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function eeplanBuildExtension(pi: ExtensionAPI): void {
	let mode: Mode = "build";
	let currentPlan: PlanFile | null = null;
	let planPath: string = "";
	let planFilename: string = DEFAULT_PLAN_FILENAME;
	let firstBuildTurn = true;
	let postCompaction = false;
	let gitignoreChecked = false;

	// ── Flags ────────────────────────────────────────────────────────────────

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("plan-file", {
		description: "Path to plan file (default: PLAN.md in project root)",
		type: "string",
		default: DEFAULT_PLAN_FILENAME,
	});

	// ── State Helpers ────────────────────────────────────────────────────────

	function resolvePlanPath(cwd: string): string {
		const flagValue = pi.getFlag("plan-file") as string | undefined;
		const filename = flagValue && flagValue !== DEFAULT_PLAN_FILENAME ? flagValue : planFilename;
		return resolve(cwd, filename);
	}

	async function loadPlan(): Promise<void> {
		currentPlan = await readPlanFile(planPath);
	}

	async function savePlan(): Promise<void> {
		if (currentPlan) {
			await writePlanFile(planPath, currentPlan);
		}
	}

	function persistState(): void {
		pi.appendEntry("ee-plan-build", {
			mode,
			planFilename,
			firstBuildTurn,
		});
	}

	// ── UI Updates ───────────────────────────────────────────────────────────

	function updateUI(ctx: ExtensionContext): void {
		updateStatus(ctx);
		updateWidget(ctx);
	}

	function updateStatus(ctx: ExtensionContext): void {
		const theme = ctx.ui.theme;
		const hint = theme.fg("dim", " (alt+q)");

		if (mode === "plan") {
			ctx.ui.setStatus("ee-plan-build", theme.fg("warning", "📋 PLAN") + hint);
		} else if (currentPlan && currentPlan.steps.length > 0) {
			const completed = getCompletedCount(currentPlan.steps);
			const total = currentPlan.steps.length;
			ctx.ui.setStatus(
				"ee-plan-build",
				theme.fg("success", `🔨 BUILD ${completed}/${total}`) + hint,
			);
		} else {
			ctx.ui.setStatus("ee-plan-build", theme.fg("success", "🔨 BUILD") + hint);
		}
	}

	function updateWidget(ctx: ExtensionContext): void {
		const theme = ctx.ui.theme;

		if (mode === "plan" && currentPlan && currentPlan.steps.length > 0) {
			// Show all steps in PLAN mode
			const lines = currentPlan.steps.map((step) => {
				if (step.completed) {
					return theme.fg("success", "  ☑ ") + theme.fg("muted", theme.strikethrough(step.text));
				}
				return theme.fg("muted", "  ☐ ") + step.text;
			});
			ctx.ui.setWidget("ee-plan-steps", lines);
		} else if (mode === "build" && currentPlan && currentPlan.steps.length > 0) {
			// Show remaining steps in BUILD mode
			const remaining = getRemainingSteps(currentPlan.steps);
			if (remaining.length > 0) {
				const completed = getCompletedCount(currentPlan.steps);
				const total = currentPlan.steps.length;
				const header = theme.fg("accent", `  📋 Plan: ${completed}/${total} done`);
				const lines = [
					header,
					...remaining.map((step) => theme.fg("muted", `  ☐ `) + step.text),
				];
				ctx.ui.setWidget("ee-plan-steps", lines);
			} else {
				ctx.ui.setWidget("ee-plan-steps", [theme.fg("success", "  ✅ All steps completed!")]);
			}
		} else {
			ctx.ui.setWidget("ee-plan-steps", undefined);
		}
	}

	// ── Mode Switching ───────────────────────────────────────────────────────

	async function switchMode(newMode: Mode, ctx: ExtensionContext): Promise<void> {
		mode = newMode;

		if (mode === "plan") {
			pi.setActiveTools(PLAN_MODE_TOOLS);
			await loadPlan();
		} else {
			pi.setActiveTools(BUILD_MODE_TOOLS);
			firstBuildTurn = true;
			await loadPlan();
		}

		updateUI(ctx);
		persistState();

		const modeLabel = mode === "plan" ? "PLAN" : "BUILD";
		ctx.ui.notify(`Switched to ${modeLabel} mode`, "info");
	}

	async function toggleMode(ctx: ExtensionContext): Promise<void> {
		await switchMode(mode === "plan" ? "build" : "plan", ctx);
	}

	// ── .gitignore Check ─────────────────────────────────────────────────────

	async function checkGitignore(ctx: ExtensionContext): Promise<void> {
		if (gitignoreChecked) return;
		gitignoreChecked = true;

		const filename = basename(planPath);
		const alreadyIgnored = await isInGitignore(ctx.cwd, filename);
		if (alreadyIgnored) return;

		if (!ctx.hasUI) return;

		const shouldAdd = await ctx.ui.confirm(
			`Add ${filename} to .gitignore?`,
			"Keeps the plan file out of version control.",
		);

		if (shouldAdd) {
			await addToGitignore(ctx.cwd, filename);
			ctx.ui.notify(`Added ${filename} to .gitignore`, "info");
		}
	}

	// ── Shortcut ─────────────────────────────────────────────────────────────

	pi.registerShortcut("alt+q", {
		description: "Toggle between PLAN and BUILD mode",
		handler: async (ctx) => toggleMode(ctx),
	});

	// ── Commands ─────────────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Toggle between PLAN and BUILD mode, or use subcommands: status, reset",
		handler: async (args, ctx) => {
			const subcommand = args?.trim().toLowerCase();

			if (!subcommand || subcommand === "") {
				// Toggle mode
				await toggleMode(ctx);
				return;
			}

			if (subcommand === "status") {
				await loadPlan();
				if (!currentPlan || currentPlan.steps.length === 0) {
					ctx.ui.notify("No plan found. Switch to PLAN mode to create one.", "info");
					return;
				}
				ctx.ui.notify(formatProgressSummary(currentPlan.steps), "info");
				return;
			}

			if (subcommand === "reset") {
				await emptyPlanFile(planPath);
				currentPlan = null;
				await switchMode("plan", ctx);
				ctx.ui.notify("PLAN.md cleared. Ready for a new plan.", "info");
				return;
			}

			ctx.ui.notify(`Unknown subcommand: ${subcommand}. Use: /plan, /plan status, /plan reset`, "warning");
		},
	});

	// ── Tool Call Interception (PLAN mode restrictions) ──────────────────────

	pi.on("tool_call", async (event, ctx) => {
		if (mode !== "plan") return;

		const planBase = basename(planPath);

		// Block write/edit to anything except PLAN.md
		if (event.toolName === "write" || event.toolName === "edit") {
			const targetPath = event.input.path as string | undefined;
			if (targetPath) {
				const resolvedTarget = resolve(ctx.cwd, targetPath.replace(/^@/, ""));
				const resolvedPlan = resolve(planPath);
				if (resolvedTarget !== resolvedPlan) {
					return {
						block: true,
						reason: `PLAN mode: writes are only allowed to ${planBase}. Switch to BUILD mode (alt+q) to modify other files.`,
					};
				}
			}
		}

		// Block destructive bash commands
		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `PLAN mode: command blocked (not allowlisted). Switch to BUILD mode (alt+q) first.\nCommand: ${command}`,
				};
			}
		}
	});

	// ── Context Injection (BUILD mode) ───────────────────────────────────────

	pi.on("before_agent_start", async (_event, ctx) => {
		if (mode === "plan") {
			return {
				message: {
					customType: "ee-plan-context",
					content: `[PLAN MODE ACTIVE]
You are in PLAN mode — a read-only exploration mode for safe code analysis and planning.

Restrictions:
- You can read files, grep, find, and ls freely
- You can ONLY write/edit the plan file: ${basename(planPath)}
- Bash is restricted to read-only commands
- You CANNOT modify any other files

Your task: Explore the codebase and create/refine a plan in ${basename(planPath)}.
The plan file uses this format:

# Plan: <title>

## Context
Brief description of the goal, constraints, relevant decisions.

## Steps
1. [ ] First step description
2. [ ] Second step description

## Notes
Any freeform notes, open questions, etc.

Create a detailed, actionable plan. Do NOT attempt to execute it — just plan.`,
					display: false,
				},
			};
		}

		if (mode === "build") {
			await loadPlan();
			if (!currentPlan || currentPlan.steps.length === 0) return;

			const shouldInjectFull = firstBuildTurn || postCompaction;
			firstBuildTurn = false;
			postCompaction = false;

			if (shouldInjectFull) {
				// Full PLAN.md content on first turn and after compaction
				const fullContent = formatPlanContent(currentPlan);
				return {
					message: {
						customType: "ee-build-context",
						content: `[BUILD MODE — Full Plan]
You are executing a plan. Here is the complete plan:

${fullContent}

Execute the remaining unchecked steps in order.
After completing each step, include a [DONE:n] tag (e.g. [DONE:1]) in your response.`,
						display: false,
					},
				};
			}

			// Subsequent turns: only remaining steps
			const remaining = getRemainingSteps(currentPlan.steps);
			if (remaining.length === 0) return;

			const stepsText = formatStepsForContext(currentPlan.steps, true);
			return {
				message: {
					customType: "ee-build-context",
					content: `[BUILD MODE — Remaining Steps]
${stepsText}

Execute these steps in order. Include [DONE:n] after completing each step.`,
					display: false,
				},
			};
		}
	});

	// ── Filter stale plan context when not relevant ──────────────────────────

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "ee-plan-context" && mode !== "plan") return false;
				if (msg.customType === "ee-build-context" && mode !== "build") return false;
				return true;
			}),
		};
	});

	// ── Progress Tracking (BUILD mode) ───────────────────────────────────────

	pi.on("turn_end", async (event, ctx) => {
		if (mode !== "build" || !currentPlan || currentPlan.steps.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		const newlyCompleted = markCompletedSteps(text, currentPlan.steps);

		if (newlyCompleted > 0) {
			// Update the file on disk
			const completedNums = currentPlan.steps
				.filter((s) => s.completed)
				.map((s) => s.number);
			await updatePlanFileCompletions(planPath, completedNums);
			updateUI(ctx);
			persistState();
		}

		// Check if all done
		if (currentPlan.steps.every((s) => s.completed)) {
			pi.sendMessage(
				{
					customType: "ee-plan-complete",
					content: `**🎉 Plan Complete!** All ${currentPlan.steps.length} steps finished.`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}
	});

	// ── Compaction Hook ──────────────────────────────────────────────────────

	pi.on("session_before_compact", async (event, ctx) => {
		await loadPlan();
		if (!currentPlan || currentPlan.steps.length === 0) return;

		const completed = getCompletedCount(currentPlan.steps);
		const total = currentPlan.steps.length;
		const remaining = getRemainingSteps(currentPlan.steps);

		const planSummary = [
			``,
			`[EE Plan/Build Extension State]`,
			`Mode: ${mode.toUpperCase()}`,
			`Plan: ${currentPlan.title || "(untitled)"}`,
			`Progress: ${completed}/${total} steps completed`,
		];

		if (remaining.length > 0) {
			planSummary.push(`Remaining steps:`);
			for (const step of remaining) {
				planSummary.push(`  ${step.number}. ${step.text}`);
			}
		}

		// Augment custom instructions so the default compaction summary includes plan state
		event.customInstructions = (event.customInstructions ?? "") + planSummary.join("\n");
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Mark that next BUILD turn should inject full PLAN.md
		postCompaction = true;
		updateUI(ctx);
	});

	// ── Session Start ────────────────────────────────────────────────────────

	pi.on("session_start", async (event, ctx) => {
		planPath = resolvePlanPath(ctx.cwd);
		planFilename = basename(planPath);

		// Restore persisted state
		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "ee-plan-build")
			.pop() as { data?: { mode: Mode; planFilename?: string; firstBuildTurn?: boolean } } | undefined;

		if (stateEntry?.data) {
			mode = stateEntry.data.mode ?? "build";
			if (stateEntry.data.planFilename) {
				planFilename = stateEntry.data.planFilename;
				planPath = resolvePlanPath(ctx.cwd);
			}
			firstBuildTurn = stateEntry.data.firstBuildTurn ?? true;
		}

		// --plan flag overrides
		if (pi.getFlag("plan") === true) {
			mode = "plan";
		}

		// Load current plan
		await loadPlan();

		// Session start dialog (only on fresh launch and /new)
		const shouldPrompt = event.reason === "startup" || event.reason === "new";

		if (shouldPrompt && ctx.hasUI) {
			const hasContent = await planFileHasContent(planPath);

			if (hasContent && pi.getFlag("plan") !== true) {
				const choice = await ctx.ui.select("Existing plan found in " + planFilename, [
					"Continue existing plan",
					"Start a new plan",
					"Ignore plan",
				]);

				if (choice === "Continue existing plan") {
					mode = "plan";
				} else if (choice === "Start a new plan") {
					await emptyPlanFile(planPath);
					currentPlan = null;
					mode = "plan";
				} else {
					// Ignore — stay in build mode
					mode = "build";
				}
			}
		}

		// Create PLAN.md if in plan mode and file doesn't exist
		if (mode === "plan") {
			const exists = await planFileExists(planPath);
			if (!exists) {
				const empty: PlanFile = {
					title: "",
					context: "",
					steps: [],
					notes: "",
					raw: "",
				};
				await writePlanFile(planPath, empty);
				await checkGitignore(ctx);
			} else if (!gitignoreChecked) {
				await checkGitignore(ctx);
			}
		}

		// Set active tools based on mode
		if (mode === "plan") {
			pi.setActiveTools(PLAN_MODE_TOOLS);
		} else {
			pi.setActiveTools(BUILD_MODE_TOOLS);
		}

		// Rebuild completion state on resume
		if (event.reason === "resume" && currentPlan && currentPlan.steps.length > 0) {
			const messages: AssistantMessage[] = [];
			for (const entry of entries) {
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, currentPlan.steps);
		}

		updateUI(ctx);
	});

	// ── Session Shutdown ─────────────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		// Clean up UI
		// Status and widget are cleaned up by pi on shutdown
	});
}
