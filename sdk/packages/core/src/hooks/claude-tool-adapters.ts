import { existsSync } from "node:fs";
import { validateWithZod } from "@cline/shared";
import {
	formatRunCommandQuery,
	normalizeReadFileRequests,
	normalizeRunCommandsInput,
	normalizeSearchQueries,
} from "../extensions/tools/helpers";
import {
	FetchWebContentUnionInputSchema,
	type ReadFileRequest,
} from "../extensions/tools/schemas";

type JsonRecord = Record<string, unknown>;

/**
 * A tool call as Claude Code hooks see it: Claude Code's tool name and one
 * input per item. A Cline call that runs several commands or reads several
 * files is several items, because Claude Code's tools take one each.
 */
export interface ClaudeToolView {
	name: string;
	inputs: JsonRecord[];
	/** The Cline input with items replaced by hooks' `updatedInput`, by index. */
	withUpdates(updates: ReadonlyMap<number, JsonRecord>): unknown;
	/** Claude Code's `tool_response` for item `index`. */
	response(output: unknown, index: number): unknown;
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function stringField(record: JsonRecord, key: string): string | undefined {
	return typeof record[key] === "string" ? (record[key] as string) : undefined;
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

/** The per-item result of a tool that returns one result per item. */
function itemOutput(
	output: unknown,
	index: number,
): { result: unknown; error?: string } {
	if (
		Array.isArray(output) &&
		output[index] &&
		typeof output[index] === "object"
	) {
		const item = output[index] as JsonRecord;
		return {
			result: item.result,
			error: typeof item.error === "string" ? item.error : undefined,
		};
	}
	return { result: output };
}

function nativeView(name: string, input: unknown): ClaudeToolView {
	return {
		name,
		inputs: [asRecord(input)],
		withUpdates: (updates) => updates.get(0) ?? input,
		response: (output) => output,
	};
}

function runCommandsView(input: unknown): ClaudeToolView {
	const commands = normalizeRunCommandsInput(input);
	return {
		name: "Bash",
		inputs: commands.map((command) => ({
			command: formatRunCommandQuery(command),
		})),
		withUpdates: (updates) => ({
			commands: commands.map((command, index) => {
				const updated = updates.get(index);
				return (updated && stringField(updated, "command")) ?? command;
			}),
		}),
		response: (output, index) => {
			const item = itemOutput(output, index);
			return {
				stdout: text(item.result),
				stderr: item.error ?? "",
				interrupted: false,
				isImage: false,
			};
		},
	};
}

function readFilesView(input: unknown): ClaudeToolView {
	const requests = normalizeReadFileRequests(input);
	return {
		name: "Read",
		inputs: requests.map((request) => {
			const start = request.start_line ?? undefined;
			const end = request.end_line ?? undefined;
			return {
				file_path: request.path,
				...(start !== undefined ? { offset: start } : {}),
				...(end !== undefined ? { limit: end - (start ?? 1) + 1 } : {}),
			};
		}),
		withUpdates: (updates) => ({
			files: requests.map((request, index): ReadFileRequest => {
				const updated = updates.get(index);
				if (!updated) {
					return request;
				}
				const start =
					positiveInt(updated.offset) ?? request.start_line ?? undefined;
				const limit = positiveInt(updated.limit);
				return {
					...request,
					path: stringField(updated, "file_path") ?? request.path,
					...(start !== undefined ? { start_line: start } : {}),
					...(limit !== undefined
						? { end_line: (start ?? 1) + limit - 1 }
						: {}),
				};
			}),
		}),
		response: (output, index) => ({
			type: "text",
			file: {
				filePath: requests[index]?.path,
				content: text(itemOutput(output, index).result),
			},
		}),
	};
}

function searchView(input: unknown, cwd: string): ClaudeToolView {
	const queries = normalizeSearchQueries(input);
	return {
		name: "Grep",
		inputs: queries.map((pattern) => ({ pattern, path: cwd })),
		withUpdates: (updates) => ({
			queries: queries.map((query, index) => {
				const updated = updates.get(index);
				return (updated && stringField(updated, "pattern")) ?? query;
			}),
		}),
		response: (output, index) => ({
			mode: "content",
			content: text(itemOutput(output, index).result),
		}),
	};
}

function fetchView(input: unknown): ClaudeToolView {
	const { requests } = validateWithZod(FetchWebContentUnionInputSchema, input);
	return {
		name: "WebFetch",
		inputs: requests.map((request) => ({
			url: request.url,
			prompt: request.prompt,
		})),
		withUpdates: (updates) => ({
			requests: requests.map((request, index) => {
				const updated = updates.get(index);
				return updated
					? {
							url: stringField(updated, "url") ?? request.url,
							prompt: stringField(updated, "prompt") ?? request.prompt,
						}
					: request;
			}),
		}),
		response: (output, index) => ({
			url: requests[index]?.url,
			result: text(itemOutput(output, index).result),
		}),
	};
}

function editorView(input: unknown): ClaudeToolView | undefined {
	const record = asRecord(input);
	const path = stringField(record, "path");
	const newText = stringField(record, "new_text");
	if (
		path === undefined ||
		newText === undefined ||
		record.insert_line != null
	) {
		return undefined;
	}
	const oldText = stringField(record, "old_text");
	if (oldText !== undefined) {
		return {
			name: "Edit",
			inputs: [{ file_path: path, old_string: oldText, new_string: newText }],
			withUpdates: (updates) => {
				const updated = updates.get(0) ?? {};
				return {
					...record,
					path: stringField(updated, "file_path") ?? path,
					old_text: stringField(updated, "old_string") ?? oldText,
					new_text: stringField(updated, "new_string") ?? newText,
				};
			},
			response: (output) => ({ filePath: path, result: text(output) }),
		};
	}
	if (existsSync(path)) {
		return undefined;
	}
	return {
		name: "Write",
		inputs: [{ file_path: path, content: newText }],
		withUpdates: (updates) => {
			const updated = updates.get(0) ?? {};
			return {
				...record,
				path: stringField(updated, "file_path") ?? path,
				new_text: stringField(updated, "content") ?? newText,
			};
		},
		response: (output) => ({ filePath: path, result: text(output) }),
	};
}

function spawnAgentView(input: unknown): ClaudeToolView | undefined {
	const record = asRecord(input);
	const task = stringField(record, "task");
	if (task === undefined) {
		return undefined;
	}
	return {
		name: "Agent",
		inputs: [{ prompt: task, description: task.slice(0, 80) }],
		withUpdates: (updates) => {
			const updated = updates.get(0) ?? {};
			return {
				...record,
				task: stringField(updated, "prompt") ?? task,
			};
		},
		response: (output) => ({
			content: [{ type: "text", text: text(output) }],
		}),
	};
}

function createView(
	toolName: string,
	input: unknown,
	cwd: string,
): ClaudeToolView | undefined {
	switch (toolName) {
		case "run_commands":
			return runCommandsView(input);
		case "read_files":
			return readFilesView(input);
		case "search_codebase":
			return searchView(input, cwd);
		case "fetch_web_content":
			return fetchView(input);
		case "editor":
			return editorView(input);
		case "spawn_agent":
			return spawnAgentView(input);
		default:
			// MCP tools are named `<server>__<tool>`; Claude Code calls them
			// `mcp__<server>__<tool>`.
			return toolName.includes("__")
				? nativeView(`mcp__${toolName}`, input)
				: undefined;
	}
}

/**
 * Shows a Cline tool call the way Claude Code hooks expect it. Tools without
 * a Claude Code counterpart, and inputs a tool would reject, keep their Cline
 * name and input.
 */
export function claudeToolView(
	toolName: string,
	input: unknown,
	cwd: string,
): ClaudeToolView {
	try {
		return createView(toolName, input, cwd) ?? nativeView(toolName, input);
	} catch {
		return nativeView(toolName, input);
	}
}
