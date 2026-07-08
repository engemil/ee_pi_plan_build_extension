/**
 * PlanBuildController — the mode state machine for the EE Plan/Build extension.
 *
 * Three modes (NORMAL / PLAN / BUILD), opencode-style transitions, tool-set
 * management that never clobbers user-configured tools, and no-modal session
 * start. See IMPROVEMENT_PLAN.md.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import {
	DEFAULT_PLAN_FILENAME,
	ensureDirGitignored,
	ensurePlanDir,
	emptyPlanFile,
	formatPlanContent,
	formatProgressSummary,
	formatStepsForContext,
	getCompletedCount,
	getRemainingSteps,
	isSafeCommand,
	markCompletedSteps,
	planFileExists,
	planFileHasContent,
	readPlanFile,
	updatePlanFileCompletions,
	writePlanFile,
	type PlanFile,
} from "./utils.js";
import {
	BUILD_SWITCH_REMINDER,
	buildFullPlanPrompt,
	buildRemainingPrompt,
	planWorkflowPrompt,
} from "./prompts.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type Mode = "normal" | "plan" | "build";

interface ToolInput {
	path?: string;
	command?: string;
}

interface PersistedState {
	schemaVersion: number;
	mode: Mode;
	planRelPath: string;
	firstBuildTurn: boolean;
}

interface InjectedMessage {
	customType: string;
	content: string;
	display: false;
}

const SCHEMA_VERSION = 2;
const STATE_CUSTOM_TYPE = "ee-plan-build";
const PLAN_CTX = "ee-plan-context";
const BUILD_CTX = "ee-build-context";

/** Tools this extension toggles. Everything else is left to the user/pi. */
const TRANSITION_TOOLS = ["plan_enter", "plan_exit"];

const MODE_ORDER: Mode[] = ["normal", "plan", "build"];

// ── Helpers ──────────────────────────────────────────────────────────────────

function withoutManaged(tools: string[]): string[] {
	return tools.filter((t) => !TRANSITION_TOOLS.includes(t));
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// ── Controller ───────────────────────────────────────────────────────────────

export class PlanBuildController {
	private readonly pi: ExtensionAPI;

	private mode: Mode = "normal";
	private currentPlan: PlanFile | null = null;

	private planAbsPath = "";
	private planRelPath = DEFAULT_PLAN_FILENAME;
	private cwd = "";

	private baselineTools: string[] | undefined;
	private firstBuildTurn = true;
	private postCompaction = false;
	private announceBuildSwitch = false;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	// ── Accessors used by tools.ts ────────────────────────────────────────────

	getMode(): Mode {
		return this.mode;
	}

	getPlanDisplayPath(): string {
		return this.planRelPath;
	}

	/** Explicit mode switch (commands, shortcuts, transition tools). */
	setMode(newMode: Mode, ctx: ExtensionContext): void {
		const prev = this.mode;
		if (prev === newMode) {
			this.updateUI(ctx);
			return;
		}

		this.mode = newMode;

		if (newMode === "plan") {
			void this.loadPlan();
			void this.ensurePlanReady(ctx);
		} else if (newMode === "build") {
			this.firstBuildTurn = true;
			if (prev === "plan") this.announceBuildSwitch = true;
			void this.loadPlan();
		}

		this.applyToolSet();
		this.updateUI(ctx);
		this.persistState();

		const label = newMode.toUpperCase();
		ctx.ui.notify(`Switched to ${label} mode`, "info");
	}

	cycleMode(ctx: ExtensionContext): void {
		const idx = MODE_ORDER.indexOf(this.mode);
		const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
		this.setMode(next, ctx);
	}

	// ── Plan ops ──────────────────────────────────────────────────────────────

	async loadPlan(): Promise<void> {
		this.currentPlan = await readPlanFile(this.planAbsPath);
	}

	async resetPlan(ctx: ExtensionContext): Promise<void> {
		if (ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				`Reset ${this.planRelPath}?`,
				"This empties the plan file on disk.",
			);
			if (!ok) return;
		}
		await emptyPlanFile(this.planAbsPath);
		this.currentPlan = null;
		this.setMode("plan", ctx);
		ctx.ui.notify(`${this.planRelPath} cleared. Ready for a new plan.`, "info");
	}

	async showStatus(ctx: ExtensionContext): Promise<void> {
		await this.loadPlan();
		if (!this.currentPlan || this.currentPlan.steps.length === 0) {
			ctx.ui.notify("No plan found. Switch to PLAN mode (/plan) to create one.", "info");
			return;
		}
		ctx.ui.notify(formatProgressSummary(this.currentPlan.steps), "info");
	}

	// ── Tool-set management ───────────────────────────────────────────────────

	private captureBaselineOnce(): void {
		if (this.baselineTools === undefined) {
			this.baselineTools = withoutManaged(this.pi.getActiveTools());
		}
	}

	private applyToolSet(): void {
		this.captureBaselineOnce();
		const base = this.baselineTools ?? [];
		const tools = new Set(base);
		if (this.mode === "plan") {
			tools.add("plan_exit");
			tools.delete("plan_enter");
		} else {
			// normal + build can propose entering plan
			tools.add("plan_enter");
			tools.delete("plan_exit");
		}
		this.pi.setActiveTools([...tools]);
	}

	// ── Path resolution ───────────────────────────────────────────────────────

	private resolvePlanPath(cwd: string): void {
		this.cwd = cwd;
		const flagValue = this.pi.getFlag("plan-file") as string | undefined;
		const rel = flagValue && flagValue.trim() ? flagValue.trim() : DEFAULT_PLAN_FILENAME;
		this.planRelPath = rel;
		this.planAbsPath = resolve(cwd, rel);
	}

	private async ensurePlanDirAndGitignore(ctx: ExtensionContext): Promise<void> {
		await ensurePlanDir(this.planAbsPath);
		// Ignore the top-level segment of the plan path (e.g. "tmp").
		const topDir = this.planRelPath.split("/")[0] ?? "";
		if (!topDir || topDir === "." || topDir === ".." || topDir.includes("\\")) return;
		const added = await ensureDirGitignored(this.cwd, topDir); // true if already ignored
		if (!added && ctx.hasUI) {
			ctx.ui.notify(`Added ${topDir}/ to .gitignore`, "info");
		}
	}

	/** Ensure dir + gitignore, and seed an empty plan file if none exists yet. */
	private async ensurePlanReady(ctx: ExtensionContext): Promise<void> {
		await this.ensurePlanDirAndGitignore(ctx);
		if (!(await planFileExists(this.planAbsPath))) {
			await createEmptyPlan(this.planAbsPath);
		}
	}

	// ── UI ────────────────────────────────────────────────────────────────────

	updateUI(ctx: ExtensionContext): void {
		this.updateStatus(ctx);
		this.updateWidget(ctx);
	}

	private updateStatus(ctx: ExtensionContext): void {
		const theme = ctx.ui.theme;
		const hint = theme.fg("dim", " (alt+q)");

		if (this.mode === "plan") {
			ctx.ui.setStatus("ee-plan-build", theme.fg("warning", "📋 PLAN") + hint);
		} else if (this.mode === "build" && this.currentPlan && this.currentPlan.steps.length > 0) {
			const completed = getCompletedCount(this.currentPlan.steps);
			const total = this.currentPlan.steps.length;
			ctx.ui.setStatus("ee-plan-build", theme.fg("success", `🔨 BUILD ${completed}/${total}`) + hint);
		} else if (this.mode === "build") {
			ctx.ui.setStatus("ee-plan-build", theme.fg("success", "🔨 BUILD") + hint);
		} else {
			ctx.ui.setStatus("ee-plan-build", theme.fg("accent", "💬 NORMAL") + hint);
		}
	}

	private updateWidget(ctx: ExtensionContext): void {
		const theme = ctx.ui.theme;
		const steps = this.currentPlan?.steps ?? [];

		if (this.mode === "plan" && steps.length > 0) {
			const lines = steps.map((step) => {
				if (step.completed) {
					return theme.fg("success", "  ☑ ") + theme.fg("muted", theme.strikethrough(step.text));
				}
				return theme.fg("muted", "  ☐ ") + step.text;
			});
			ctx.ui.setWidget("ee-plan-steps", lines);
		} else if (this.mode === "build" && steps.length > 0) {
			const remaining = getRemainingSteps(steps);
			if (remaining.length > 0) {
				const completed = getCompletedCount(steps);
				const total = steps.length;
				const header = theme.fg("accent", `  📋 Plan: ${completed}/${total} done`);
				const lines = [header, ...remaining.map((s) => theme.fg("muted", "  ☐ ") + s.text)];
				ctx.ui.setWidget("ee-plan-steps", lines);
			} else {
				ctx.ui.setWidget("ee-plan-steps", [theme.fg("success", "  ✅ All steps completed!")]);
			}
		} else {
			ctx.ui.setWidget("ee-plan-steps", undefined);
		}
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	private persistState(): void {
		const data: PersistedState = {
			schemaVersion: SCHEMA_VERSION,
			mode: this.mode,
			planRelPath: this.planRelPath,
			firstBuildTurn: this.firstBuildTurn,
		};
		this.pi.appendEntry(STATE_CUSTOM_TYPE, data);
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	onToolCall(
		toolName: string,
		input: ToolInput,
		ctx: ExtensionContext,
	): { block: true; reason: string } | undefined {
		if (this.mode !== "plan") return undefined;

		// Block write/edit to anything except the plan file
		if (toolName === "write" || toolName === "edit") {
			const targetPath = input.path;
			if (targetPath) {
				const resolvedTarget = resolve(ctx.cwd, targetPath.replace(/^@/, ""));
				if (resolvedTarget !== resolve(this.planAbsPath)) {
					return {
						block: true,
						reason: `PLAN mode: writes are only allowed to ${this.planRelPath}. Call plan_exit (or alt+q) to switch to BUILD.`,
					};
				}
			}
		}

		// Block destructive/non-allowlisted bash
		if (toolName === "bash") {
			const command = input.command ?? "";
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `PLAN mode: command not allowlisted. Call plan_exit (or alt+q) to switch to BUILD.\nCommand: ${command}`,
				};
			}
		}

		return undefined;
	}

	async onBeforeAgentStart(_ctx: ExtensionContext): Promise<InjectedMessage | undefined> {
		if (this.mode === "plan") {
			return {
				customType: PLAN_CTX,
				content: planWorkflowPrompt(this.planRelPath),
				display: false,
			};
		}

		if (this.mode === "build") {
			await this.loadPlan();
			if (!this.currentPlan || this.currentPlan.steps.length === 0) return undefined;

			const injectFull = this.firstBuildTurn || this.postCompaction;
			this.firstBuildTurn = false;
			this.postCompaction = false;

			if (injectFull) {
				let content = buildFullPlanPrompt(formatPlanContent(this.currentPlan));
				if (this.announceBuildSwitch) {
					content = `${BUILD_SWITCH_REMINDER}\n\n${content}`;
					this.announceBuildSwitch = false;
				}
				return { customType: BUILD_CTX, content, display: false };
			}

			const remaining = getRemainingSteps(this.currentPlan.steps);
			if (remaining.length === 0) return undefined;
			return {
				customType: BUILD_CTX,
				content: buildRemainingPrompt(formatStepsForContext(this.currentPlan.steps, true)),
				display: false,
			};
		}

		// normal: no injection
		return undefined;
	}

	onContext(event: { messages: AgentMessage[] }): { messages: AgentMessage[] } {
		const messages = event.messages.filter((m) => {
			const customType = (m as AgentMessage & { customType?: string }).customType;
			if (customType === PLAN_CTX && this.mode !== "plan") return false;
			if (customType === BUILD_CTX && this.mode !== "build") return false;
			return true;
		});
		return { messages };
	}

	async onTurnEnd(event: { message: AgentMessage }, ctx: ExtensionContext): Promise<void> {
		if (this.mode !== "build" || !this.currentPlan || this.currentPlan.steps.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		const newlyCompleted = markCompletedSteps(text, this.currentPlan.steps);

		if (newlyCompleted > 0) {
			const completedNums = this.currentPlan.steps.filter((s) => s.completed).map((s) => s.number);
			await updatePlanFileCompletions(this.planAbsPath, completedNums);
			this.updateUI(ctx);
			this.persistState();
		}

		if (this.currentPlan.steps.every((s) => s.completed)) {
			this.pi.sendMessage(
				{
					customType: "ee-plan-complete",
					content: `**🎉 Plan Complete!** All ${this.currentPlan!.steps.length} steps finished.`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}
	}

	async onBeforeCompact(
		event: SessionBeforeCompactEvent,
		_ctx: ExtensionContext,
	): Promise<void> {
		await this.loadPlan();
		if (!this.currentPlan || this.currentPlan.steps.length === 0) return;

		const completed = getCompletedCount(this.currentPlan.steps);
		const total = this.currentPlan.steps.length;
		const remaining = getRemainingSteps(this.currentPlan.steps);

		const summary = [
			``,
			`[EE Plan/Build Extension State]`,
			`Mode: ${this.mode.toUpperCase()}`,
			`Plan file: ${this.planRelPath}`,
			`Plan: ${this.currentPlan.title || "(untitled)"}`,
			`Progress: ${completed}/${total} steps completed`,
		];

		if (remaining.length > 0) {
			summary.push(`Remaining steps:`);
			for (const step of remaining) summary.push(`  ${step.number}. ${step.text}`);
		}

		event.customInstructions = (event.customInstructions ?? "") + summary.join("\n");
	}

	onCompact(ctx: ExtensionContext): void {
		this.postCompaction = true;
		this.updateUI(ctx);
	}

	async onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
		this.resolvePlanPath(ctx.cwd);
		this.captureBaselineOnce();

		const entries = ctx.sessionManager.getEntries() as unknown as Array<Record<string, unknown>>;

		// Restore persisted state (per-session)
		let restored = false;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e?.type === "custom" && e.customType === STATE_CUSTOM_TYPE) {
				const data = e.data as Partial<PersistedState> | undefined;
				if (data) {
					if (data.mode) this.mode = data.mode as Mode;
					this.firstBuildTurn = data.firstBuildTurn ?? true;
					restored = true;
				}
				break;
			}
		}

		// Flags override restored state / defaults
		if (this.pi.getFlag("plan") === true) this.mode = "plan";
		else if (this.pi.getFlag("build") === true) this.mode = "build";
		else if (this.pi.getFlag("normal") === true) this.mode = "normal";
		else if (!restored) this.mode = "normal";

		await this.loadPlan();

		// Non-blocking heads-up when an existing plan is present (startup/new only)
		const shouldHint = event.reason === "startup" || event.reason === "new";
		if (shouldHint && ctx.hasUI) {
			if (await planFileHasContent(this.planAbsPath)) {
				ctx.ui.notify(
					`Plan found at ${this.planRelPath} — /plan to resume, /build to execute`,
					"info",
				);
			}
		}

		// Ensure plan dir + gitignore; seed an empty plan file when entering PLAN mode
		if (this.mode === "plan") {
			await this.ensurePlanReady(ctx);
		} else if (await planFileExists(this.planAbsPath)) {
			await this.ensurePlanDirAndGitignore(ctx);
		}

		this.applyToolSet();

		// Rebuild completion on resume/fork (scan only after the last build-context marker)
		if ((event.reason === "resume" || event.reason === "fork") && this.currentPlan && this.currentPlan.steps.length > 0) {
			this.rebuildCompletion(entries);
		}

		this.updateUI(ctx);
	}

	/**
	 * Re-scan assistant messages for [DONE:n] markers, but only those AFTER the
	 * last ee-build-context marker — avoids bleeding an earlier plan's markers
	 * into the current one.
	 */
	private rebuildCompletion(entries: Array<Record<string, unknown>>): void {
		if (!this.currentPlan) return;

		let markerIndex = -1;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			const msg = e?.message as AgentMessage | undefined;
			if (e?.type === "message" && msg && (msg as AgentMessage & { customType?: string }).customType === BUILD_CTX) {
				markerIndex = i;
				break;
			}
		}

		const texts: string[] = [];
		for (let i = markerIndex + 1; i < entries.length; i++) {
			const e = entries[i];
			const msg = e?.message as AgentMessage | undefined;
			if (e?.type === "message" && msg && "message" in e && isAssistantMessage(msg)) {
				texts.push(getTextContent(msg));
			}
		}
		if (texts.length > 0) {
			markCompletedSteps(texts.join("\n"), this.currentPlan.steps);
		}
	}
}

// Re-exported so index.ts can create an empty plan file when entering PLAN mode
export async function createEmptyPlan(planAbsPath: string): Promise<void> {
	const empty: PlanFile = { title: "", context: "", steps: [], notes: "", raw: "" };
	await writePlanFile(planAbsPath, empty);
}
