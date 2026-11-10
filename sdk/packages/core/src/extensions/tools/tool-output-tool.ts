import { Readable } from "node:stream";
import {
	type AgentTool,
	type AgentToolContext,
	createTool,
	validateWithZod,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import {
	MIN_STORED_OUTPUT_CHARS,
	type ToolOutputRecord,
	type ToolOutputStore,
} from "../../services/tool-output/store";
import type { ToolContextLimits } from "../../settings/context-limits";
import { readTextWindow } from "./executors/file-read";

export const TOOL_OUTPUT_TOOL_NAME = "tool_output";

const LIST_LIMIT = 50;
const DEFAULT_CONTEXT_LINES = 2;
const NOTES_RESERVE_CHARS = 300;

const ToolOutputInputSchema = z.object({
	action: z
		.enum(["list", "search", "read"])
		.describe(
			'"list" shows stored outputs, "search" finds matching lines, "read" returns a line range.',
		),
	id: z
		.string()
		.optional()
		.describe(
			'Id of a stored output. Required for "read"; for "search", omit it to search every stored output of this task.',
		),
	pattern: z
		.string()
		.optional()
		.describe(
			'Regular expression to search for (JavaScript syntax). Required for "search".',
		),
	ignore_case: z.boolean().optional(),
	context_lines: z.coerce
		.number()
		.int()
		.min(0)
		.max(20)
		.optional()
		.describe(
			`Lines shown around each match. Default ${DEFAULT_CONTEXT_LINES}.`,
		),
	start_line: z.coerce.number().int().positive().optional(),
	end_line: z.coerce.number().int().positive().optional(),
});

type ToolOutputInput = z.infer<typeof ToolOutputInputSchema>;

/** Models often leave out `action`; infer it from the other fields. */
function normalizeInput(input: unknown): unknown {
	if (!input || typeof input !== "object" || "action" in input) return input;
	const record = input as Record<string, unknown>;
	const action = record.pattern ? "search" : record.id ? "read" : "list";
	return { ...record, action };
}

function storeKey(context: AgentToolContext): string {
	return context.sessionId ?? context.agentId;
}

function formatAge(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function describeRecord(record: ToolOutputRecord): string {
	return `${record.id} ${record.toolName}: ${record.summary} (${record.lines} lines, ${record.chars} chars)`;
}

function missingOutput(id: string): Error {
	return new Error(
		`No stored output "${id}" in this task. Call tool_output with action "list" to see what is stored.`,
	);
}

function compilePattern(
	pattern: string,
	ignoreCase: boolean,
): { regex: RegExp; literal: boolean } {
	const flags = ignoreCase ? "i" : "";
	try {
		return { regex: new RegExp(pattern, flags), literal: false };
	} catch {
		const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return { regex: new RegExp(escaped, flags), literal: true };
	}
}

interface SearchBudget {
	usedChars: number;
	maxChars: number;
	lineChars: number;
}

/**
 * Scans one output line by line, like grep -n with context. Stops collecting
 * once the shared budget is spent but keeps counting matches, so memory stays
 * bounded however large the output or broad the pattern.
 */
function searchText(
	text: string,
	regex: RegExp,
	contextLines: number,
	budget: SearchBudget,
	header: string,
): { lines: string[]; matches: number; truncated: boolean } {
	const lines: string[] = [];
	if (!text) return { lines, matches: 0, truncated: false };
	const before: { lineNumber: number; text: string }[] = [];
	let afterRemaining = 0;
	let lastEmitted = 0;
	let matches = 0;
	let truncated = false;

	const emit = (lineNumber: number, line: string, isMatch: boolean): void => {
		if (truncated) return;
		const separator = lastEmitted > 0 && lineNumber > lastEmitted + 1;
		let formatted = `${lineNumber}${isMatch ? ":" : "-"} ${line}`;
		if (formatted.length > budget.lineChars) {
			formatted = `${formatted.slice(0, budget.lineChars)} [line truncated]`;
		}
		// The section's header and the blank line before it count once, with its first line.
		const headerCost = lines.length === 0 ? header.length + 2 : 0;
		const cost = headerCost + formatted.length + 1 + (separator ? 3 : 0);
		if (budget.usedChars + cost > budget.maxChars) {
			truncated = true;
			return;
		}
		if (lines.length === 0) lines.push(header);
		if (separator) lines.push("--");
		lines.push(formatted);
		budget.usedChars += cost;
		lastEmitted = lineNumber;
	};

	let start = 0;
	for (let lineNumber = 1; ; lineNumber++) {
		const newline = text.indexOf("\n", start);
		const end = newline === -1 ? text.length : newline;
		const line = text.slice(start, end);
		if (regex.test(line)) {
			matches++;
			for (const entry of before) emit(entry.lineNumber, entry.text, false);
			before.length = 0;
			emit(lineNumber, line, true);
			afterRemaining = contextLines;
		} else if (afterRemaining > 0) {
			emit(lineNumber, line, false);
			afterRemaining--;
		} else if (contextLines > 0 && !truncated) {
			before.push({ lineNumber, text: line });
			if (before.length > contextLines) before.shift();
		}
		if (newline === -1 || newline === text.length - 1) break;
		start = newline + 1;
	}
	return { lines, matches, truncated };
}

export function createToolOutputTool(
	store: ToolOutputStore,
	limits: Pick<
		ToolContextLimits,
		"readLines" | "lineChars" | "readOutputChars" | "searchOutputChars"
	>,
): AgentTool<ToolOutputInput, string> {
	return createTool<ToolOutputInput, string>({
		name: TOOL_OUTPUT_TOOL_NAME,
		executionMode: "parallel",
		resultPolicy: "no-store",
		description:
			`Search or read output from earlier tool calls in this task without running them again. Results over ${MIN_STORED_OUTPUT_CHARS} characters are stored under a short id, ` +
			"and the full output of a command whose result was truncated is stored too; truncation notices name the id. " +
			'action "list" shows stored outputs, newest first. ' +
			'action "search" returns lines matching a regex pattern, numbered like grep -n with context_lines around each match, from one output (id) or from all of them. ' +
			'action "read" returns a line range (start_line/end_line) of one output. ' +
			"Use this instead of re-running a command, re-reading or re-fetching to see output again.",
		inputSchema: zodToJsonSchema(ToolOutputInputSchema),
		execute: async (rawInput, context) => {
			const input = validateWithZod(
				ToolOutputInputSchema,
				normalizeInput(rawInput),
			);
			const key = storeKey(context);

			if (input.action === "list") {
				const records = store.list(key, LIST_LIMIT);
				if (records.length === 0) return "No stored tool output in this task.";
				const now = Date.now();
				return records
					.map(
						(record) =>
							`${describeRecord(record)}, ${formatAge(now - record.createdAt)}`,
					)
					.join("\n");
			}

			if (input.action === "read") {
				if (!input.id) throw new Error('action "read" needs an id.');
				const record = store.get(key, input.id);
				const text = record && store.readText(key, input.id);
				if (!record || text === undefined) throw missingOutput(input.id);
				const window = await readTextWindow(
					Readable.from([text]),
					true,
					input.start_line,
					input.end_line,
					{
						maxReadLines: limits.readLines,
						maxLineChars: limits.lineChars,
						maxReadOutputChars: limits.readOutputChars,
					},
					context.signal,
				);
				return `${describeRecord(record)}\n${window}`;
			}

			if (!input.pattern) throw new Error('action "search" needs a pattern.');
			const records = input.id
				? [store.get(key, input.id)]
				: store.list(key, Number.MAX_SAFE_INTEGER);
			if (input.id && !records[0]) throw missingOutput(input.id);
			const { regex, literal } = compilePattern(
				input.pattern,
				input.ignore_case ?? false,
			);
			const contextLines = input.context_lines ?? DEFAULT_CONTEXT_LINES;
			const budget: SearchBudget = {
				usedChars: 0,
				// Leaves room for the notes appended after the sections.
				maxChars:
					limits.searchOutputChars -
					Math.min(
						NOTES_RESERVE_CHARS,
						Math.floor(limits.searchOutputChars / 2),
					),
				lineChars: limits.lineChars,
			};
			const sections: string[] = [];
			let totalMatches = 0;
			let truncated = false;
			let unsearched = 0;
			for (const [index, record] of records.entries()) {
				if (!record) continue;
				if (truncated) {
					unsearched = records.length - index;
					break;
				}
				const text = store.readText(key, record.id);
				if (text === undefined) continue;
				const result = searchText(
					text,
					regex,
					contextLines,
					budget,
					`== ${describeRecord(record)}`,
				);
				totalMatches += result.matches;
				truncated = result.truncated;
				if (result.lines.length > 0) sections.push(result.lines.join("\n"));
			}
			const notes: string[] = [];
			if (literal)
				notes.push(
					"[The pattern is not a valid regex; searched for it literally.]",
				);
			if (truncated)
				notes.push(
					unsearched > 0
						? `[Output limit reached after ${totalMatches} matching lines; ${unsearched} older stored outputs were not searched. Narrow the pattern, set id, or read a line range.]`
						: `[${totalMatches} matching lines in total; not all are shown. Narrow the pattern, set id, or read a line range.]`,
				);
			if (totalMatches === 0)
				return [
					`No lines match ${regex} in ${input.id ? `output ${input.id}` : "the stored output of this task"}.`,
					...notes,
				].join("\n");
			return [...sections, ...notes].join("\n\n");
		},
	});
}
