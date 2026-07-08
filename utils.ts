/**
 * Utility functions for the EE Plan/Build extension.
 * Handles PLAN.md parsing, file ops, step tracking, safe command checking,
 * and gitignore management for the plan directory.
 */

import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PlanStep {
	number: number;
	text: string;
	completed: boolean;
}

export interface PlanFile {
	title: string;
	context: string;
	steps: PlanStep[];
	notes: string;
	raw: string;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

/** Default plan location, relative to the project root. */
export const DEFAULT_PLAN_FILENAME = "tmp/PLAN.md";

// ── PLAN.md Parsing ──────────────────────────────────────────────────────────

const STEP_PATTERN = /^\s*(\d+)\.\s+\[([ xX])\]\s+(.+)$/;

export function parsePlanContent(content: string): PlanFile {
	const raw = content;

	// Extract title from "# Plan: <title>"
	const titleMatch = content.match(/^#\s+Plan:\s*(.*)$/m);
	const title = titleMatch?.[1]?.trim() ?? "";

	// Split into sections
	const sections = splitSections(content);

	// Parse steps
	const steps: PlanStep[] = [];
	const stepsContent = sections.steps ?? "";
	for (const line of stepsContent.split("\n")) {
		const match = line.match(STEP_PATTERN);
		if (match) {
			steps.push({
				number: parseInt(match[1], 10),
				text: match[3].trim(),
				completed: match[2].toLowerCase() === "x",
			});
		}
	}

	return {
		title,
		context: sections.context ?? "",
		steps,
		notes: sections.notes ?? "",
		raw,
	};
}

function splitSections(content: string): Record<string, string> {
	const sections: Record<string, string> = {};
	const sectionPattern = /^##\s+(\w+)\s*$/gm;
	const matches: { name: string; index: number }[] = [];

	let match: RegExpExecArray | null;
	while ((match = sectionPattern.exec(content)) !== null) {
		matches.push({ name: match[1].toLowerCase(), index: match.index + match[0].length });
	}

	for (let i = 0; i < matches.length; i++) {
		const start = matches[i].index;
		const end = i + 1 < matches.length ? matches[i + 1].index - matches[i + 1].name.length - 4 : content.length;
		sections[matches[i].name] = content.slice(start, end).trim();
	}

	return sections;
}

export function formatPlanContent(plan: PlanFile): string {
	const lines: string[] = [];

	lines.push(`# Plan: ${plan.title}`);
	lines.push("");
	lines.push("## Context");
	if (plan.context.trim()) {
		lines.push(plan.context.trim());
	}
	lines.push("");
	lines.push("## Steps");
	for (const step of plan.steps) {
		const checkbox = step.completed ? "[x]" : "[ ]";
		lines.push(`${step.number}. ${checkbox} ${step.text}`);
	}
	lines.push("");
	lines.push("## Notes");
	if (plan.notes.trim()) {
		lines.push(plan.notes.trim());
	}
	lines.push("");

	return lines.join("\n");
}

// ── PLAN.md File Operations ──────────────────────────────────────────────────

export async function ensureDir(dirPath: string): Promise<void> {
	await mkdir(dirPath, { recursive: true });
}

/** Ensure the parent directory of a plan file exists (e.g. `tmp/`). */
export async function ensurePlanDir(planAbsPath: string): Promise<void> {
	const dir = dirname(planAbsPath);
	await ensureDir(dir);
}

export async function readPlanFile(planPath: string): Promise<PlanFile | null> {
	try {
		const content = await readFile(planPath, "utf8");
		if (!content.trim()) return null;
		return parsePlanContent(content);
	} catch {
		return null;
	}
}

export async function writePlanFile(planPath: string, plan: PlanFile): Promise<void> {
	await ensurePlanDir(planPath);
	await writeFile(planPath, formatPlanContent(plan), "utf8");
}

export async function emptyPlanFile(planPath: string): Promise<void> {
	const empty: PlanFile = {
		title: "",
		context: "",
		steps: [],
		notes: "",
		raw: "",
	};
	await writePlanFile(planPath, empty);
}

export async function planFileExists(planPath: string): Promise<boolean> {
	try {
		await access(planPath);
		return true;
	} catch {
		return false;
	}
}

export async function planFileHasContent(planPath: string): Promise<boolean> {
	try {
		const content = await readFile(planPath, "utf8");
		// Check if there's meaningful content beyond the empty template
		const plan = parsePlanContent(content);
		return plan.title.length > 0 || plan.steps.length > 0 || plan.context.trim().length > 0;
	} catch {
		return false;
	}
}

// ── Step Tracking ────────────────────────────────────────────────────────────

export function extractDoneMarkers(text: string): number[] {
	const steps: number[] = [];
	for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

/**
 * Mark steps as completed based on [DONE:n] markers in text.
 * Returns the number of newly completed steps.
 */
export function markCompletedSteps(text: string, steps: PlanStep[]): number {
	const doneMarkers = extractDoneMarkers(text);
	let newlyCompleted = 0;
	for (const stepNum of doneMarkers) {
		const step = steps.find((s) => s.number === stepNum && !s.completed);
		if (step) {
			step.completed = true;
			newlyCompleted++;
		}
	}
	return newlyCompleted;
}

/**
 * Update PLAN.md file with completed step checkboxes.
 * Reads the file, updates checkboxes, writes back.
 */
export async function updatePlanFileCompletions(planPath: string, completedStepNumbers: number[]): Promise<void> {
	try {
		const content = await readFile(planPath, "utf8");
		let updated = content;

		for (const stepNum of completedStepNumbers) {
			// Match the specific step line and replace [ ] with [x]
			const pattern = new RegExp(`(\\s*${stepNum}\\.\\s+)\\[ \\]`, "m");
			updated = updated.replace(pattern, "$1[x]");
		}

		if (updated !== content) {
			await writeFile(planPath, updated, "utf8");
		}
	} catch {
		// File may not exist yet, ignore
	}
}

export function getRemainingSteps(steps: PlanStep[]): PlanStep[] {
	return steps.filter((s) => !s.completed);
}

export function getCompletedCount(steps: PlanStep[]): number {
	return steps.filter((s) => s.completed).length;
}

export function formatStepsForContext(steps: PlanStep[], remainingOnly: boolean): string {
	const filtered = remainingOnly ? getRemainingSteps(steps) : steps;
	return filtered.map((s) => {
		const checkbox = s.completed ? "[x]" : "[ ]";
		return `${s.number}. ${checkbox} ${s.text}`;
	}).join("\n");
}

export function formatProgressSummary(steps: PlanStep[]): string {
	const completed = getCompletedCount(steps);
	const total = steps.length;
	if (total === 0) return "No steps defined";
	const remaining = getRemainingSteps(steps);
	let summary = `Progress: ${completed}/${total} steps completed`;
	if (remaining.length > 0) {
		summary += `\nRemaining:\n${remaining.map((s) => `  ${s.number}. ${s.text}`).join("\n")}`;
	} else {
		summary += "\nAll steps completed! 🎉";
	}
	return summary;
}

// ── .gitignore Management (folder-aware) ─────────────────────────────────────

/**
 * Normalize a gitignore entry for comparison: strip a leading "/" and any
 * trailing "/". e.g. "/tmp/", "tmp/", "/tmp", "tmp" all → "tmp".
 */
function normalizeEntry(entry: string): string {
	return entry.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Returns true if `entry` (a file or folder name like "tmp" or "PLAN.md")
 * is already present in `.gitignore`.
 */
export async function isEntryInGitignore(cwd: string, entry: string): Promise<boolean> {
	try {
		const gitignorePath = join(cwd, ".gitignore");
		const content = await readFile(gitignorePath, "utf8");
		const target = normalizeEntry(entry);
		return content
			.split("\n")
			.map((l) => normalizeEntry(l))
			.some((line) => line === target);
	} catch {
		return false;
	}
}

/** Append an entry to `.gitignore`, creating the file if needed. */
export async function addToGitignore(cwd: string, entry: string): Promise<void> {
	const gitignorePath = join(cwd, ".gitignore");
	let content = "";
	try {
		content = await readFile(gitignorePath, "utf8");
	} catch {
		// .gitignore doesn't exist, we'll create it
	}

	const newline = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
	content += `${newline}${entry}\n`;
	await writeFile(gitignorePath, content, "utf8");
}

/**
 * Ensure a directory (e.g. "tmp") is ignored by git.
 * Returns true if it was already ignored, false if it was just added.
 */
export async function ensureDirGitignored(cwd: string, dirName: string): Promise<boolean> {
	const already = await isEntryInGitignore(cwd, dirName);
	if (already) return true;
	// Add with a trailing slash to make clear it's a directory.
	await addToGitignore(cwd, `${dirName}/`);
	return false;
}

// ── Safe Command Checking (Plan Mode) ────────────────────────────────────────

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

/**
 * Determine whether a shell command is safe to run in PLAN (read-only) mode.
 *
 * Splits compound commands on `;`, `&&`, `||`, and `|` and requires EVERY
 * non-empty segment to match a safe read-only pattern. A destructive pattern
 * anywhere in the command (including inside `$(...)` substitution) blocks it.
 */
export function isSafeCommand(command: string): boolean {
	// Belt-and-suspenders: a destructive token anywhere blocks the whole command.
	// This catches command substitution like `$(rm -rf x)` even if the leading
	// command is benign.
	if (DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) return false;

	const segments = command
		.split(/\s*(?:&&|\|\||;|\|)\s*/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (segments.length === 0) return false;

	return segments.every((seg) => SAFE_PATTERNS.some((p) => p.test(seg)));
}
