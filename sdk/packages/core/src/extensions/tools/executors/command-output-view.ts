import type { AgentToolContext } from "@cline/shared";
import { getToolOutputStoreFromContext } from "../../../services/tool-output/store";
import type { RunCommandsView } from "../schemas";
import {
	compilePattern,
	searchText,
	toolOutputSearchCall,
} from "../tool-output-tool";
import { truncateCommandOutput } from "./output-limits";

const STORED_OUTPUT_ID = /stored as tool output ([0-9a-f]{8})/;
/** The note `createCommandOutputCapture` ends a stored copy with when it hit its cap. */
const STORED_COPY_CAPPED =
	/\[Output exceeded [^\]]*; the rest was not stored\]\n?$/;
const DEFAULT_GREP_CONTEXT_LINES = 2;

export interface CommandOutputViewOptions {
	context: Pick<
		AgentToolContext,
		"sessionId" | "agentId" | "toolCallId" | "metadata"
	>;
	/** The command, shown when the model lists stored output. */
	summary: string;
	maxChars: number;
	lineChars: number;
	durationMs?: number;
}

export function hasCommandOutputView(view: RunCommandsView): boolean {
	return (
		view.head_lines !== undefined ||
		view.tail_lines !== undefined ||
		view.grep !== undefined
	);
}

function splitLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function numbered(
	lines: string[],
	firstLineNumber: number,
	lineChars: number,
): string[] {
	return lines.map((line, index) => {
		const text = `${firstLineNumber + index}| ${line}`;
		return text.length > lineChars
			? `${text.slice(0, lineChars)} [line truncated]`
			: text;
	});
}

/**
 * Shows only the requested part of one command's output: its first lines,
 * the lines matching a pattern, its last lines. The whole output is stored
 * first, so nothing the view leaves out is lost.
 */
export function applyCommandOutputView(
	output: string,
	view: RunCommandsView,
	options: CommandOutputViewOptions,
): string {
	if (!output || !hasCommandOutputView(view)) return output;
	const { context } = options;
	const store = getToolOutputStoreFromContext(context);
	const key = context.sessionId ?? context.agentId;
	const noticeId = STORED_OUTPUT_ID.exec(output)?.[1];
	const storedText = noticeId ? store?.readText(key, noticeId) : undefined;
	let id = storedText === undefined ? undefined : noticeId;
	// A capped copy lacks the command's real end, which the result itself keeps.
	const storedCapped =
		storedText !== undefined && STORED_COPY_CAPPED.test(storedText);
	const full = (!storedCapped && storedText) || output;
	const lines = splitLines(full);
	const head = Math.min(view.head_lines ?? 0, lines.length);
	const tail = Math.min(view.tail_lines ?? 0, lines.length - head);
	if (view.grep === undefined && head + tail >= lines.length) return output;

	if (!id && store) {
		id = store.put({
			sessionId: key,
			agentId: context.agentId,
			toolCallId: `${context.toolCallId ?? ""}/command`,
			toolName: "run_commands",
			summary: options.summary,
			text: full,
			durationMs: options.durationMs,
		})?.id;
	}

	const shown: string[] = [];
	const sections: string[] = [];
	if (head > 0) {
		shown.push(`the first ${head}`);
		sections.push(
			`--- first ${head} lines ---`,
			...numbered(lines.slice(0, head), 1, options.lineChars),
		);
	}
	if (view.grep !== undefined) {
		const { regex, literal } = compilePattern(view.grep, false);
		shown.push(`the lines matching ${regex}`);
		const result = searchText(
			full,
			regex,
			view.context_lines ?? DEFAULT_GREP_CONTEXT_LINES,
			{
				usedChars: 0,
				maxChars: Math.floor(options.maxChars / 2),
				lineChars: options.lineChars,
			},
		);
		sections.push(
			result.matches === 0
				? `--- no lines match ${regex} ---`
				: `--- ${result.matches} lines match ${regex} ---`,
			...result.lines,
		);
		if (literal)
			sections.push(
				"[The pattern is not a valid regex; searched for it literally.]",
			);
		if (result.truncated)
			sections.push(
				"[Not all matches are shown. Narrow the pattern, or search the stored output with tool_output.]",
			);
	}
	if (tail > 0) {
		shown.push(`the last ${tail}`);
		sections.push(
			`--- last ${tail} lines ---`,
			...numbered(
				lines.slice(lines.length - tail),
				lines.length - tail + 1,
				options.lineChars,
			),
		);
	}

	const where = !id
		? "The rest of the output was not kept."
		: `The ${storedCapped ? "start of the" : "full"} output is stored as tool output ${id}. To see other parts, use ${toolOutputSearchCall(id)} instead of running the command again.`;
	const header = `[Showing ${shown.join(", ")} of ${lines.length} lines. ${where}]`;
	return truncateCommandOutput([header, ...sections].join("\n"), {
		maxChars: options.maxChars,
	});
}
