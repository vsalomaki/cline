import type {
	AgentModelEvent,
	AgentToolDefinition,
	GatewayProviderContext,
	GatewayStreamRequest,
} from "@cline/shared";
import { NoSuchToolError } from "ai";
import { describe, expect, it } from "vitest";
import {
	createOpenAICompatibleProvider,
	repairMalformedToolCall,
} from "./ai-sdk";

/**
 * Integration tests for malformed tool-call handling in the AI SDK adapter.
 *
 * Weaker models routinely emit tool calls with type mismatches (a bare string
 * where the schema wants an array) or arguments that are not valid JSON
 * (truncated payloads, single quotes). These tests drive the real adapter
 * with a fake OpenAI-compatible SSE response and assert that such calls are
 * coerced/repaired instead of being rejected before execution
 * (`metadata.inputParseError`), which surfaced as the
 * tool_call_type_validation / tool_call_invalid_json buckets under
 * task.provider_api_error.
 */

const RUN_COMMANDS_TOOL: AgentToolDefinition = {
	name: "run_commands",
	description: "Run shell commands",
	inputSchema: {
		type: "object",
		properties: {
			commands: { type: "array", items: { type: "string" } },
		},
		required: ["commands"],
	},
};

const LIST_FILES_TOOL: AgentToolDefinition = {
	name: "list_files",
	description: "List a directory",
	inputSchema: {
		type: "object",
		properties: { path: { type: "string" }, recursive: { type: "boolean" } },
		required: ["path"],
	},
};

const EDITOR_TOOL: AgentToolDefinition = {
	name: "editor",
	description: "Edit a file",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string" },
			old_text: { type: "string" },
			new_text: { type: "string" },
		},
		required: ["path", "new_text"],
	},
};

const READ_FILES_TOOL: AgentToolDefinition = {
	name: "read_files",
	description: "Read files",
	inputSchema: {
		type: "object",
		properties: {
			files: {
				type: "array",
				items: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
				},
			},
		},
		required: ["files"],
	},
};

function sseToolCall(toolName: string, args: string): string {
	const chunk = (delta: unknown, finish: string | null = null) =>
		`data: ${JSON.stringify({
			id: "cmpl-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "test-model",
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;
	return (
		chunk({
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: "call_1",
					type: "function",
					function: { name: toolName, arguments: "" },
				},
			],
		}) +
		chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }) +
		chunk({}, "tool_calls") +
		"data: [DONE]\n\n"
	);
}

async function streamToolCallEvents(
	sseBody: string,
	tools: AgentToolDefinition[],
): Promise<AgentModelEvent[]> {
	const config = {
		providerId: "openai-compatible",
		apiKey: "test-key",
		baseUrl: "http://fake.local/v1",
		fetch: (async () =>
			new Response(sseBody, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})) as unknown as typeof fetch,
	};
	const provider = await createOpenAICompatibleProvider(config);
	const model = {
		id: "test-model",
		providerId: "openai-compatible",
		name: "test-model",
	};
	const context = {
		provider: {
			id: "openai-compatible",
			name: "OpenAI Compatible",
			defaultModelId: "test-model",
			models: [model],
		},
		model,
		config,
	} as unknown as GatewayProviderContext;
	const request = {
		providerId: "openai-compatible",
		modelId: "test-model",
		messages: [
			{
				id: "msg_user",
				role: "user",
				content: [{ type: "text", text: "do the thing" }],
				createdAt: new Date(),
			},
		],
		tools,
	} as unknown as GatewayStreamRequest;

	const events: AgentModelEvent[] = [];
	for await (const event of await provider.stream(request, context)) {
		events.push(event);
	}
	return events;
}

function findParseError(events: AgentModelEvent[]): string | undefined {
	for (const event of events) {
		if (event.type !== "tool-call-delta") continue;
		const metadata = event.metadata as Record<string, unknown> | undefined;
		if (typeof metadata?.inputParseError === "string") {
			return metadata.inputParseError;
		}
	}
	return undefined;
}

function findToolInput(events: AgentModelEvent[]): unknown {
	for (const event of events) {
		if (event.type === "tool-call-delta" && event.input !== undefined) {
			return event.input;
		}
	}
	return undefined;
}

describe("ai-sdk adapter malformed tool calls", () => {
	it("passes schema-mismatched input through to the tool instead of rejecting", async () => {
		// The executor's lenient union schema accepts a bare string for a
		// string[] property; rejecting at the adapter would prevent that.
		const events = await streamToolCallEvents(
			sseToolCall("run_commands", '{"commands": "ls -la"}'),
			[RUN_COMMANDS_TOOL],
		);

		expect(findParseError(events)).toBeUndefined();
		expect(findToolInput(events)).toEqual({ commands: "ls -la" });
	});

	it("passes well-formed input through unchanged", async () => {
		const events = await streamToolCallEvents(
			sseToolCall("run_commands", '{"commands": ["ls", "pwd"]}'),
			[RUN_COMMANDS_TOOL],
		);

		expect(findParseError(events)).toBeUndefined();
		expect(findToolInput(events)).toEqual({ commands: ["ls", "pwd"] });
	});

	it("repairs unclosed container brackets with complete string values", async () => {
		const events = await streamToolCallEvents(
			sseToolCall("read_files", '{"files": [{"path": "/tmp/a.txt"}]'),
			[READ_FILES_TOOL],
		);

		expect(findParseError(events)).toBeUndefined();
		expect(findToolInput(events)).toEqual({ files: [{ path: "/tmp/a.txt" }] });
	});

	it("surfaces parse error for truncated JSON with unterminated string value", async () => {
		const truncated = '{"commands": ["npm install';
		const events = await streamToolCallEvents(
			sseToolCall("run_commands", truncated),
			[RUN_COMMANDS_TOOL],
		);

		expect(findParseError(events)).toContain("Invalid input");
	});

	it("repairs single-quoted JSON arguments", async () => {
		const events = await streamToolCallEvents(
			sseToolCall("run_commands", "{'commands': ['ls']}"),
			[RUN_COMMANDS_TOOL],
		);

		expect(findParseError(events)).toBeUndefined();
		expect(findToolInput(events)).toEqual({ commands: ["ls"] });
	});

	it("still surfaces a parse error for unrepairable argument text", async () => {
		const events = await streamToolCallEvents(
			sseToolCall("run_commands", "run ls for me please"),
			[RUN_COMMANDS_TOOL],
		);

		expect(findParseError(events)).toContain("Invalid input");
	});

	it("keeps the unavailable-tool error for unknown tools", async () => {
		const events = await streamToolCallEvents(
			sseToolCall("editor", '{"path": "/tmp/a.txt", "new_text": "x"}'),
			[RUN_COMMANDS_TOOL, READ_FILES_TOOL],
		);

		expect(findParseError(events)).toContain("unavailable tool 'editor'");
	});

	it("runs another agent's listing tool as list_files", async () => {
		const events = await streamToolCallEvents(
			sseToolCall("list_directory", '{"dir_path": "/repo"}'),
			[LIST_FILES_TOOL, RUN_COMMANDS_TOOL],
		);

		expect(findParseError(events)).toBeUndefined();
		const call = events.find((event) => event.type === "tool-call-delta");
		expect(call).toMatchObject({ toolName: "list_files" });
		expect(findToolInput(events)).toEqual({ dir_path: "/repo" });
	});

	it("runs a glob call as list_files", async () => {
		const events = await streamToolCallEvents(
			sseToolCall("glob", '{"pattern": "**/*.ts", "path": "/repo"}'),
			[LIST_FILES_TOOL, RUN_COMMANDS_TOOL],
		);

		expect(findParseError(events)).toBeUndefined();
		const call = events.find((event) => event.type === "tool-call-delta");
		expect(call).toMatchObject({ toolName: "list_files" });
		expect(findToolInput(events)).toEqual({
			pattern: "**/*.ts",
			path: "/repo",
		});
	});

	it("runs a Claude Code Read call as read_files", async () => {
		const events = await streamToolCallEvents(
			sseToolCall("Read", '{"file_path": "/repo/a.ts", "offset": 10}'),
			[RUN_COMMANDS_TOOL, READ_FILES_TOOL],
		);

		expect(findParseError(events)).toBeUndefined();
		const call = events.find((event) => event.type === "tool-call-delta");
		expect(call).toMatchObject({ toolName: "read_files" });
	});

	it("runs a Claude Code Edit call as editor with the editor's fields", async () => {
		const events = await streamToolCallEvents(
			sseToolCall(
				"Edit",
				'{"file_path": "/repo/a.ts", "old_string": "a", "new_string": "b"}',
			),
			[EDITOR_TOOL, READ_FILES_TOOL],
		);

		expect(findParseError(events)).toBeUndefined();
		const call = events.find((event) => event.type === "tool-call-delta");
		expect(call).toMatchObject({ toolName: "editor" });
		expect(findToolInput(events)).toEqual({
			path: "/repo/a.ts",
			old_text: "a",
			new_text: "b",
		});
	});

	it("names the tool to use instead of an unknown one", async () => {
		const events = await streamToolCallEvents(
			sseToolCall("bash", '{"command": "ls", "cwd": "/elsewhere"}'),
			[RUN_COMMANDS_TOOL, READ_FILES_TOOL],
		);

		expect(findParseError(events)).toContain("Use run_commands instead.");
	});

	it("explains that edits are unavailable when no edit tool exists", async () => {
		const events = await streamToolCallEvents(
			sseToolCall("editor", '{"path": "/tmp/a.txt", "new_text": "x"}'),
			[RUN_COMMANDS_TOOL, READ_FILES_TOOL],
		);

		expect(findParseError(events)).toContain(
			"File edits are not available in this mode",
		);
	});
});

describe("repairMalformedToolCall", () => {
	const toolCall = (input: string) => ({
		toolCallId: "call_1",
		toolName: "run_commands",
		input,
	});

	it("repairs unclosed containers (brackets/braces) with complete string values", async () => {
		const repaired = await repairMalformedToolCall({
			toolCall: toolCall('{"commands": ["ls"'),
			error: new Error("JSON parsing failed"),
		});
		expect(repaired?.input).toBe('{"commands":["ls"]}');
	});

	it("returns null for unterminated string values in truncated JSON", async () => {
		const truncated = '{"commands": ["npm install ';
		const repaired = await repairMalformedToolCall({
			toolCall: toolCall(truncated),
			error: new Error("JSON parsing failed"),
		});
		expect(repaired).toBeNull();
	});

	it("repairs single-quoted JSON", async () => {
		const repaired = await repairMalformedToolCall({
			toolCall: toolCall("{'commands': ['ls']}"),
			error: new Error("JSON parsing failed"),
		});
		expect(repaired?.input).toBe('{"commands":["ls"]}');
	});

	it("returns null for already-valid JSON (schema failures are not repairable here)", async () => {
		const repaired = await repairMalformedToolCall({
			toolCall: toolCall('{"commands": "ls"}'),
			error: new Error("Type validation failed"),
		});
		expect(repaired).toBeNull();
	});

	it.each([
		["Read", "read_files", '{"file_path": "/repo/a.ts"}'],
		["read_many_files", "read_files", '{"paths": ["a.ts"]}'],
		["LS", "list_files", '{"path": "/repo"}'],
		["Glob", "list_files", '{"pattern": "**/*.ts"}'],
		["Grep", "search_codebase", '{"pattern": "foo"}'],
		["search_files", "search_codebase", '{"regex": "foo"}'],
		["Bash", "run_commands", '{"command": "ls", "description": "List"}'],
		["run_terminal_cmd", "run_commands", '{"command": "ls"}'],
		["WebFetch", "fetch_web_content", '{"url": "https://example.com"}'],
		["fetch_url", "fetch_web_content", '{"url": "https://example.com"}'],
	])("renames %s to %s only when the session has it", async (alias, canonical, input) => {
		const call = { toolCallId: "call_1", toolName: alias, input };
		const error = new NoSuchToolError({ toolName: alias });

		expect(
			await repairMalformedToolCall({
				toolCall: call,
				tools: { [canonical]: {} },
				error,
			}),
		).toEqual({ ...call, toolName: canonical });
		expect(
			await repairMalformedToolCall({
				toolCall: call,
				tools: { editor: {} },
				error,
			}),
		).toBeNull();
	});

	it("renames an MCP tool written the Claude Code way", async () => {
		const call = {
			toolCallId: "call_1",
			toolName: "mcp__plugin_acme_docs__search",
			input: '{"queries": ["x"]}',
		};
		expect(
			await repairMalformedToolCall({
				toolCall: call,
				tools: { "docs__search": {}, run_commands: {} },
				error: new NoSuchToolError({ toolName: call.toolName }),
			}),
		).toEqual({ ...call, toolName: "docs__search" });
	});

	it("keeps a shell alias that sets its own working directory un-renamed", async () => {
		for (const input of [
			'{"command": "ls", "cwd": "/elsewhere"}',
			'{"command": "ls", "directory": "packages/app"}',
			'{"command": ["ls"], "workdir": "/elsewhere"}',
		]) {
			expect(
				await repairMalformedToolCall({
					toolCall: { toolCallId: "call_1", toolName: "bash", input },
					tools: { run_commands: {} },
					error: new NoSuchToolError({ toolName: "bash" }),
				}),
			).toBeNull();
		}
	});

	it("renames Edit to editor along with its fields", async () => {
		const repaired = await repairMalformedToolCall({
			toolCall: {
				toolCallId: "call_1",
				toolName: "Edit",
				input:
					'{"file_path": "/repo/a.ts", "old_string": "a", "new_string": "b"}',
			},
			tools: { editor: {}, read_files: {} },
			error: new NoSuchToolError({ toolName: "Edit" }),
		});
		expect(repaired?.toolName).toBe("editor");
		expect(JSON.parse(repaired?.input ?? "")).toEqual({
			path: "/repo/a.ts",
			old_text: "a",
			new_text: "b",
		});
	});

	it("does not rename Edit without an editor, or other edit tools", async () => {
		for (const [toolName, tools] of [
			["Edit", { apply_patch: {}, read_files: {} }],
			["Write", { editor: {}, read_files: {} }],
			["MultiEdit", { editor: {}, read_files: {} }],
		] as const) {
			expect(
				await repairMalformedToolCall({
					toolCall: {
						toolCallId: "call_1",
						toolName,
						input: '{"file_path": "/repo/a.ts"}',
					},
					tools,
					error: new NoSuchToolError({ toolName }),
				}),
			).toBeNull();
		}
	});

	it("returns null for unknown-tool errors", async () => {
		const repaired = await repairMalformedToolCall({
			toolCall: toolCall('{"commands": ["ls"]}'),
			error: new NoSuchToolError({ toolName: "run_commands" }),
		});
		expect(repaired).toBeNull();
	});

	it("returns null for unrepairable garbage", async () => {
		const repaired = await repairMalformedToolCall({
			toolCall: toolCall("run ls for me"),
			error: new Error("JSON parsing failed"),
		});
		expect(repaired).toBeNull();
	});
});
