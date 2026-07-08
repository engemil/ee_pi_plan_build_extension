/**
 * Transition tools: plan_enter / plan_exit.
 *
 * These give the *model* the ability to propose a mode change, which the user
 * confirms via a dialog — mirroring opencode's plan_enter/plan_exit tools.
 * They are toggled active per-mode by the controller (see applyToolSet()).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PlanBuildController } from "./modes.js";

const PLAN_EXIT_DESCRIPTION = `Use this tool when you have finished planning and are ready to start implementing.

This tool asks the user whether to switch to BUILD mode and begin execution.

Call this tool when:
- You have written a complete plan to the plan file
- You have clarified any open questions with the user
- You are confident the plan is ready to implement

Do NOT call this tool:
- Before the plan file has been written or finalized
- If you still have unanswered questions
- If the user has indicated they want to keep planning`;

const PLAN_ENTER_DESCRIPTION = `Suggest switching to PLAN mode when the user's request would benefit from research and design before implementation.

This tool asks the user whether to switch to PLAN mode.

Call this tool when:
- The user explicitly asks to plan something
- The task is complex, touches many files, or has architectural impact
- You want to explore and design before making changes

Do NOT call this tool:
- For simple, straightforward tasks
- When the user explicitly wants immediate implementation`;

/** Register plan_enter and plan_exit, wired to the controller. */
export function registerTransitionTools(pi: ExtensionAPI, ctrl: PlanBuildController): void {
	pi.registerTool({
		name: "plan_exit",
		label: "Exit Plan",
		description: PLAN_EXIT_DESCRIPTION,
		promptSnippet: "Exit PLAN mode and offer to start BUILD",
		promptGuidelines: ["Use plan_exit when the plan file is complete and you are ready to implement."],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "No UI available to confirm the mode switch." }],
					details: {},
				};
			}
			const approved = await ctx.ui.confirm(
				"Plan ready — switch to BUILD?",
				`Switch to BUILD mode and start implementing the plan at ${ctrl.getPlanDisplayPath()}?`,
			);
			if (!approved) {
				return {
					content: [
						{
							type: "text",
							text: "User wants to keep refining the plan. Stay in PLAN mode and continue editing the plan file.",
						},
					],
					details: { approved: false },
				};
			}
			ctrl.setMode("build", ctx);
			return {
				content: [
					{
						type: "text",
						text: `User approved. BUILD mode is now active. Begin executing the plan at ${ctrl.getPlanDisplayPath()}. After completing each step, include a [DONE:n] tag in your response.`,
					},
				],
				details: { approved: true },
			};
		},
	});

	pi.registerTool({
		name: "plan_enter",
		label: "Enter Plan",
		description: PLAN_ENTER_DESCRIPTION,
		promptSnippet: "Suggest entering PLAN mode to research/design first",
		promptGuidelines: ["Use plan_enter to suggest planning before implementation on complex tasks."],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "No UI available to confirm the mode switch." }],
					details: {},
				};
			}
			const approved = await ctx.ui.confirm(
				"Switch to PLAN mode?",
				"Enter read-only PLAN mode to research and design before making changes?",
			);
			if (!approved) {
				return {
					content: [
						{
							type: "text",
							text: "User declined. Stay in the current mode and proceed.",
						},
					],
					details: { approved: false },
				};
			}
			ctrl.setMode("plan", ctx);
			return {
				content: [
					{
						type: "text",
						text: "User approved. PLAN mode is now active (read-only). Explore the codebase and build the plan in the plan file, then call plan_exit when ready.",
					},
				],
				details: { approved: true },
			};
		},
	});
}
