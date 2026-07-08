/**
 * Prompt text constants and builders for the EE Plan/Build extension.
 * The PLAN-mode workflow is adapted from opencode's plan-mode prompt
 * (see IMPROVEMENT_PLAN.md §1, §4).
 */

export type PlanModeMessage = {
	customType: string;
	content: string;
	display: false;
};

/**
 * PLAN-mode reminder, injected every turn via before_agent_start.
 * Re-injected each turn so it survives compaction (opencode re-injects per turn).
 */
export function planWorkflowPrompt(planDisplayPath: string): string {
	return `<system-reminder>
PLAN mode is active. The user wants a plan, not execution yet.
You MUST NOT make any edits except to the plan file, run any non-readonly
commands, or otherwise change the system. Bash is restricted to read-only commands.
This supersedes any other instructions.

## Plan file
${planDisplayPath}
Build and refine your plan there incrementally — it is the ONLY file you may edit.

## Plan file format
\`\`\`markdown
# Plan: <title>

## Context
Goal, constraints, relevant decisions, key file paths.

## Steps
1. [ ] First step
2. [ ] Second step

## Notes
Open questions, alternatives considered, verification approach.
\`\`\`

## Workflow
1. **Understand** — read the relevant code with read/grep/find; ask the user
   clarifying questions before assuming intent.
2. **Design** — weigh approaches and tradeoffs; consult the user on decisions.
3. **Review** — re-read the critical files; confirm the plan aligns with the request.
4. **Write the plan** to ${planDisplayPath}. Include concrete file paths to touch
   and a short verification section (how to test the change end-to-end).
5. **Call the \`plan_exit\` tool** when the plan is final — it asks the user to
   approve switching to BUILD.

End your turn ONLY by asking the user a question or calling \`plan_exit\`.
Do NOT execute the plan. Do NOT call \`plan_exit\` before the plan file is written.
</system-reminder>`;
}

/**
 * One-shot reminder injected when transitioning PLAN → BUILD.
 * Adapted from opencode's build-switch.txt.
 */
export const BUILD_SWITCH_REMINDER = `<system-reminder>
Your operational mode changed from PLAN to BUILD.
You are no longer in read-only mode. You may edit files, run shell commands,
and use all tools. Execute the plan.
</system-reminder>`;

/** BUILD-mode injection: full plan (first turn after switch, or after compaction). */
export function buildFullPlanPrompt(planText: string): string {
	return `[BUILD MODE — Full Plan]
You are executing the plan below. Work through the unchecked steps in order.
After completing each step, include a [DONE:n] tag (e.g. [DONE:1]) in your response
so progress is tracked.

${planText}`;
}

/** BUILD-mode injection: remaining steps (subsequent turns). */
export function buildRemainingPrompt(stepsText: string): string {
	return `[BUILD MODE — Remaining Steps]
${stepsText}

Continue in order. Include [DONE:n] after completing each step.`;
}
