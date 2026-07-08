/**
 * EE Pi Plan/Build Extension
 *
 * Three-mode workflow for Pi:
 * - NORMAL: vanilla pi — full tools, no plan overhead.
 * - PLAN:   read-only exploration + plan authoring (only the plan file is writable).
 * - BUILD:  full execution with plan context injection and [DONE:n] progress tracking.
 *
 * Transitions: alt+q cycle, /plan /build /normal commands, or the model-driven
 * plan_enter / plan_exit tools (user-confirmed). Inspired by opencode's plan/build
 * agent model. See IMPROVEMENT_PLAN.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PlanBuildController } from "./modes.js";
import { registerTransitionTools } from "./tools.js";
import { DEFAULT_PLAN_FILENAME } from "./utils.js";

export default function eePlanBuildExtension(pi: ExtensionAPI): void {
	const ctrl = new PlanBuildController(pi);

	// Register the plan_enter / plan_exit tools (toggled active per-mode by the controller)
	registerTransitionTools(pi, ctrl);

	// ── Flags ──────────────────────────────────────────────────────────────────

	pi.registerFlag("plan", {
		description: "Start in PLAN mode (read-only exploration + planning)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("build", {
		description: "Start in BUILD mode (execute a plan with progress tracking)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("normal", {
		description: "Start in NORMAL mode (vanilla pi, no plan overhead) — default",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("plan-file", {
		description: `Path to plan file (default: ${DEFAULT_PLAN_FILENAME} in project root)`,
		type: "string",
		default: DEFAULT_PLAN_FILENAME,
	});

	// ── Commands ───────────────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Enter PLAN mode, or use subcommands: status, reset",
		handler: async (args, ctx) => {
			const sub = args?.trim().toLowerCase();
			if (!sub) {
				ctrl.setMode("plan", ctx);
				return;
			}
			if (sub === "status") {
				await ctrl.showStatus(ctx);
				return;
			}
			if (sub === "reset") {
				await ctrl.resetPlan(ctx);
				return;
			}
			ctx.ui.notify(`Unknown subcommand: ${sub}. Use: /plan, /plan status, /plan reset`, "warning");
		},
	});

	pi.registerCommand("build", {
		description: "Enter BUILD mode (execute a plan)",
		handler: async (_args, ctx) => ctrl.setMode("build", ctx),
	});

	pi.registerCommand("normal", {
		description: "Enter NORMAL mode (vanilla pi, no plan overhead)",
		handler: async (_args, ctx) => ctrl.setMode("normal", ctx),
	});

	pi.registerCommand("mode", {
		description: "Show current Plan/Build mode",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Current mode: ${ctrl.getMode().toUpperCase()}`, "info");
		},
	});

	// ── Shortcut ───────────────────────────────────────────────────────────────

	pi.registerShortcut("alt+q", {
		description: "Cycle modes: NORMAL → PLAN → BUILD → NORMAL",
		handler: async (ctx) => ctrl.cycleMode(ctx),
	});

	// ── Events ─────────────────────────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as unknown as { path?: string; command?: string };
		return ctrl.onToolCall(event.toolName, input, ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const message = await ctrl.onBeforeAgentStart(ctx);
		return message ? { message } : undefined;
	});

	pi.on("context", async (event) => ctrl.onContext(event));

	pi.on("turn_end", async (event, ctx) => ctrl.onTurnEnd(event, ctx));

	pi.on("session_before_compact", async (event, ctx) => ctrl.onBeforeCompact(event, ctx));

	pi.on("session_compact", async (_event, ctx) => ctrl.onCompact(ctx));

	pi.on("session_start", async (event, ctx) => {
		await ctrl.onSessionStart(event, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Tidy UI; pi clears the rest on shutdown.
		try {
			ctx.ui.setWidget("ee-plan-steps", undefined);
		} catch {
			// ignore — ctx may be tearing down
		}
	});
}
