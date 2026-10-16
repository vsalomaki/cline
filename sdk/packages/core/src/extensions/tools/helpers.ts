import { validateWithZod } from "@cline/shared";
import { DEFAULT_CONTEXT_LIMITS } from "../../settings/context-limits";
import {
	EDITOR_INPUT_CHAR_LIMIT,
	type EditFileInput,
	type ReadFileRequest,
	ReadFilesInputUnionSchema,
	RunCommandsInputUnionSchema,
	SearchCodebaseUnionInputSchema,
	type StructuredCommandInput,
} from "./schemas";

/**
 * Format an error into a string message
 */
export function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function getEditorSizeError(
	input: EditFileInput,
	limit: number = EDITOR_INPUT_CHAR_LIMIT,
): string | null {
	if (typeof input.old_text === "string" && input.old_text.length > limit) {
		return `Editor input too large: old_text was ${input.old_text.length} characters, over the ${limit} limit. Target a smaller region, or edit the file in sections.`;
	}

	if (input.new_text.length > limit) {
		return `Editor input too large: new_text was ${input.new_text.length} characters, over the ${limit} limit. Target a smaller region, or edit the file in sections.`;
	}

	return null;
}

/**
 * Create a timeout-wrapped promise
 */
export class TimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(message: string, timeoutMs: number) {
		super(message);
		this.name = "TimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	message: string,
): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new TimeoutError(message, ms)), ms);
		}),
	]);
}

export function formatReadFileQuery(request: ReadFileRequest): string {
	const { path, start_line, end_line } = request;
	if (start_line == null && end_line == null) {
		return path;
	}
	const start = start_line ?? 1;
	const end = end_line ?? "EOF";
	return `${path}:${start}-${end}`;
}

export function getReadFileRangeError(request: ReadFileRequest): string | null {
	const { start_line, end_line } = request;
	if (start_line == null || end_line == null || start_line <= end_line) {
		return null;
	}

	return `start_line must be less than or equal to end_line (received start_line: ${start_line}, end_line: ${end_line})`;
}

const READ_RANGE_KEYS = new Set(["start_line", "end_line"]);

function isOrphanReadRangeEntry(
	value: unknown,
): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const keys = Object.keys(value);
	return keys.length > 0 && keys.every((key) => READ_RANGE_KEYS.has(key));
}

function coalesceOrphanReadRangeEntries(entries: unknown[]): unknown[] {
	const coalesced: unknown[] = [];
	for (const entry of entries) {
		if (isOrphanReadRangeEntry(entry)) {
			const previous = coalesced[coalesced.length - 1];
			if (typeof previous === "string") {
				coalesced[coalesced.length - 1] = { path: previous, ...entry };
				continue;
			}
			if (
				previous !== null &&
				typeof previous === "object" &&
				!Array.isArray(previous) &&
				"path" in previous &&
				Object.keys(entry).every((key) => !(key in previous))
			) {
				coalesced[coalesced.length - 1] = { ...previous, ...entry };
				continue;
			}
		}
		coalesced.push(entry);
	}
	return coalesced;
}

/**
 * Some models emit a file's line range as a separate array element instead of
 * placing start_line/end_line on the same object as its path. Fold such
 * orphan range entries into the preceding file entry before validation.
 */
export function coalesceOrphanReadRanges(input: unknown): unknown {
	if (Array.isArray(input)) {
		return coalesceOrphanReadRangeEntries(input);
	}
	if (input !== null && typeof input === "object") {
		for (const key of ["files", "paths"] as const) {
			const value = (input as Record<string, unknown>)[key];
			if (Array.isArray(value)) {
				return { ...input, [key]: coalesceOrphanReadRangeEntries(value) };
			}
		}
	}
	return input;
}

function toLineCount(value: unknown): number | undefined {
	const number = typeof value === "string" ? Number(value) : value;
	return typeof number === "number" && Number.isInteger(number) && number >= 0
		? number
		: undefined;
}

/**
 * Maps other agents' read-request fields (`absolute_path`, `target_file`,
 * `offset`/`limit`, Cursor's one-indexed line fields) onto
 * path/start_line/end_line.
 */
function normalizeReadRequestAliases(entry: unknown): unknown {
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
		return entry;
	}
	const {
		absolute_path,
		target_file,
		start_line_one_indexed,
		end_line_one_indexed_inclusive,
		offset,
		limit,
		...normalized
	} = entry as Record<string, unknown>;
	const pathAlias = absolute_path ?? target_file;
	if (
		pathAlias !== undefined &&
		normalized.path === undefined &&
		normalized.file_path === undefined &&
		normalized.filePath === undefined
	) {
		normalized.path = pathAlias;
	}
	if (
		normalized.start_line === undefined &&
		start_line_one_indexed !== undefined
	) {
		normalized.start_line = start_line_one_indexed;
	}
	if (
		normalized.end_line === undefined &&
		end_line_one_indexed_inclusive !== undefined
	) {
		normalized.end_line = end_line_one_indexed_inclusive;
	}
	const start = toLineCount(offset);
	const count = toLineCount(limit);
	if (
		normalized.start_line === undefined &&
		normalized.end_line === undefined &&
		(start !== undefined || count !== undefined)
	) {
		// `offset` is one-based for some agents and zero-based for others; this
		// range covers both readings.
		const startLine = Math.max(1, start ?? 1);
		normalized.start_line = startLine;
		if (count !== undefined) {
			normalized.end_line = Math.max(startLine, (start ?? 0) + count);
		}
	}
	return normalized;
}

/**
 * Normalizes read_files input before validation: other agents' field names,
 * then orphan line ranges (see `coalesceOrphanReadRanges`).
 */
export function normalizeReadFilesInput(input: unknown): unknown {
	let normalized = input;
	if (Array.isArray(input)) {
		normalized = input.map(normalizeReadRequestAliases);
	} else if (input !== null && typeof input === "object") {
		const record = input as Record<string, unknown>;
		const listKey = (["files", "paths"] as const).find(
			(key) => record[key] !== undefined,
		);
		if (listKey === undefined) {
			normalized = normalizeReadRequestAliases(record);
		} else {
			const value = record[listKey];
			normalized = {
				...record,
				[listKey]: Array.isArray(value)
					? value.map(normalizeReadRequestAliases)
					: normalizeReadRequestAliases(value),
			};
		}
	}
	return coalesceOrphanReadRanges(normalized);
}

/** The read requests in any read_files input form the tool accepts. */
export function normalizeReadFileRequests(input: unknown): ReadFileRequest[] {
	const validate = validateWithZod(
		ReadFilesInputUnionSchema,
		normalizeReadFilesInput(input),
	);
	if (typeof validate === "string") {
		return [{ path: validate }];
	}
	if (Array.isArray(validate)) {
		return validate.map((value) =>
			typeof value === "string" ? { path: value } : value,
		);
	}
	if ("files" in validate) {
		const files = Array.isArray(validate.files)
			? validate.files
			: [validate.files];
		return files.map((file) =>
			typeof file === "string" ? { path: file } : file,
		);
	}
	if ("file_paths" in validate) {
		const filePaths = Array.isArray(validate.file_paths)
			? validate.file_paths
			: [validate.file_paths];
		return filePaths.map((path) => ({ path }));
	}
	if ("paths" in validate) {
		const paths = Array.isArray(validate.paths)
			? validate.paths
			: [validate.paths];
		return paths.map((path) => (typeof path === "string" ? { path } : path));
	}
	return [validate];
}

/** The queries in any search_codebase input form the tool accepts. */
export function normalizeSearchQueries(input: unknown): string[] {
	const validate = validateWithZod(SearchCodebaseUnionInputSchema, input);
	if (Array.isArray(validate)) {
		return validate;
	}
	if (typeof validate === "object") {
		return Array.isArray(validate.queries)
			? validate.queries
			: [validate.queries];
	}
	return [validate];
}

export function normalizeRunCommandsInput(
	input: unknown,
): Array<string | StructuredCommandInput> {
	const validate = validateWithZod(RunCommandsInputUnionSchema, input);

	if (typeof validate === "string") {
		return [validate];
	}

	if (Array.isArray(validate)) {
		return validate;
	}

	if ("commands" in validate) {
		return Array.isArray(validate.commands)
			? validate.commands
			: [validate.commands];
	}

	if ("command" in validate) {
		return "args" in validate ? [validate] : [validate.command];
	}

	if ("cmd" in validate) {
		return [validate.cmd];
	}

	return [validate];
}

export function formatRunCommandQuery(
	command: string | StructuredCommandInput,
): string {
	if (typeof command === "string") {
		return command;
	}

	const args = command.args ?? [];
	if (args.length === 0) {
		return command.command;
	}

	const renderedArgs = args.map((arg) =>
		/[\s"]/u.test(arg) ? JSON.stringify(arg) : arg,
	);
	return `${command.command} ${renderedArgs.join(" ")}`;
}

/**
 * Max characters of the executed command echoed back in the tool result's
 * `query` field. The full command already exists in the assistant tool-call
 * input, so repeating it in the result only duplicates tokens in the
 * provider request (expensive for large heredoc/file-generation commands).
 */
export const RUN_COMMAND_QUERY_PREVIEW_LIMIT =
	DEFAULT_CONTEXT_LIMITS.tool.commandPreviewChars;

/**
 * Bound the command echo placed in a provider-facing tool result.
 * Short commands pass through unchanged; long commands keep a short
 * prefix plus a truncation note so the result is still identifiable.
 */
export function formatRunCommandQueryPreview(
	command: string | StructuredCommandInput,
	limit: number = RUN_COMMAND_QUERY_PREVIEW_LIMIT,
): string {
	const rendered = formatRunCommandQuery(command);
	if (rendered.length <= limit) {
		return rendered;
	}
	const truncatedChars = rendered.length - limit;
	return `${rendered.slice(0, limit)} ... [command truncated: ${truncatedChars} more chars; full command is in the tool call input]`;
}
