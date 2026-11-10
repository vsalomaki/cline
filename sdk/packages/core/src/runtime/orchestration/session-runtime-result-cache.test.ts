import { createAgentRuntime } from "@cline/agents";
import type {
	AgentConfig,
	AgentMessage,
	AgentModel,
	AgentToolResultPart,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	MemoryToolOutputStore,
	type ToolOutputStore,
} from "../../services/tool-output/store";
import { prepareToolResultRecovery } from "../../session/services/tool-result-cache";
import { SessionRuntime } from "./session-runtime-orchestrator";

type SessionConfig = ConstructorParameters<typeof SessionRuntime>[0];

const NOTICE_ID = /stored as tool output ([0-9a-f]{8})/;

function findResult(
	messages: readonly AgentMessage[],
	name: string,
): AgentToolResultPart | undefined {
	return messages
		.flatMap((message) => [...message.content])
		.filter(
			(part): part is AgentToolResultPart =>
				part.type === "tool-result" && part.toolName === name,
		)
		.at(-1);
}

type Step = { tool: string; input: unknown } | undefined;

function scriptedModel(
	plan: (call: number, request: { messages: readonly AgentMessage[] }) => Step,
): { model: AgentModel; calls: () => number } {
	let calls = 0;
	const model: AgentModel = {
		async stream(request) {
			const call = calls++;
			const step = plan(call, request);
			return (async function* () {
				if (step) {
					yield {
						type: "tool-call-delta" as const,
						toolCallId: `call_${call}`,
						toolName: step.tool,
						inputText: JSON.stringify(step.input),
					};
					yield { type: "finish" as const, reason: "tool-calls" as const };
				} else {
					yield { type: "text-delta" as const, text: "done" };
					yield { type: "finish" as const, reason: "stop" as const };
				}
			})();
		},
	};
	return { model, calls: () => calls };
}

function makeSession(
	model: AgentModel,
	store: ToolOutputStore,
	config: Partial<SessionConfig>,
): SessionRuntime {
	return new SessionRuntime(
		{
			providerId: "anthropic",
			modelId: "claude-3-5-sonnet",
			apiKey: "test",
			sessionId: "session",
			systemPrompt: "test",
			tools: [],
			...config,
		},
		{
			toolOutputStore: store,
			createAgentRuntimeImpl: (runtimeConfig) =>
				createAgentRuntime({ ...runtimeConfig, model }),
		},
	);
}

function outputText(result: AgentToolResultPart | undefined): string {
	const output = result?.output;
	return typeof output === "string" ? output : JSON.stringify(output);
}

describe("runtime tool output recovery", () => {
	it("stores quote-heavy MCP output when persisted JSON exceeds the limit but YAML does not", async () => {
		const output = {
			content: [
				{
					type: "text",
					text: Array.from({ length: 100 }, () => '"'.repeat(50)).join("\n"),
				},
			],
		};
		expect(JSON.stringify(output).length).toBeGreaterThan(8000);
		expect(prepareToolResultRecovery(output).text?.length).toBeLessThan(8000);
		const store = new MemoryToolOutputStore();
		let outputId = "";
		const { model, calls } = scriptedModel((call, request) => {
			if (call === 0) return { tool: "external", input: {} };
			if (call === 1) {
				const projected = outputText(findResult(request.messages, "external"));
				expect(projected).toContain("truncated");
				outputId = projected.match(NOTICE_ID)?.[1] ?? "";
				expect(outputId).not.toBe("");
				return {
					tool: "tool_output",
					input: {
						action: "read",
						id: outputId,
						start_line: 103,
						end_line: 103,
					},
				};
			}
			if (call === 2) {
				const recovered = outputText(
					findResult(request.messages, "tool_output"),
				);
				expect(recovered).toContain('"'.repeat(50));
				expect(recovered).not.toContain("[line truncated]");
			}
			return undefined;
		});
		const session = makeSession(model, store, {
			contextLimits: { message: { toolResultChars: 8_000 } },
			tools: [
				{
					name: "external",
					description: "test",
					inputSchema: { type: "object" },
					execute: async () => output,
				},
			],
		});
		try {
			expect((await session.run("go")).text).toBe("done");
			expect(calls()).toBe(3);
			expect(store.get("session", outputId)?.toolName).toBe("external");
		} finally {
			await session.shutdown();
		}
	});

	it("reads and searches omitted content through tool_output and keeps it across follow-up turns and restore()", async () => {
		const full = Array.from(
			{ length: 4000 },
			(_, index) => `row_${index + 1}: original external response`,
		).join("\n");
		const externalOutput = { content: [{ type: "text", text: full }] };
		const store = new MemoryToolOutputStore();
		let outputId = "";
		let pending: Step;
		let lastRequest: readonly AgentMessage[] = [];
		const { model } = scriptedModel((call, request) => {
			lastRequest = request.messages;
			if (call === 0) return { tool: "custom_external_name", input: {} };
			if (call === 1) {
				const projected = outputText(
					findResult(request.messages, "custom_external_name"),
				);
				outputId = projected.match(NOTICE_ID)?.[1] ?? "";
				expect(outputId).not.toBe("");
				expect(projected).toContain("Use tool_output to search it");
				expect(projected).not.toContain("row_2000:");
				return {
					tool: "tool_output",
					input: {
						action: "read",
						id: outputId,
						start_line: 2003,
						end_line: 2004,
					},
				};
			}
			if (call === 2) {
				expect(
					outputText(findResult(request.messages, "tool_output")),
				).toContain("row_2000:");
				return {
					tool: "tool_output",
					input: { action: "search", pattern: "row_3999:", context_lines: 0 },
				};
			}
			if (call === 3) {
				const searched = outputText(
					findResult(request.messages, "tool_output"),
				);
				expect(searched).toContain("row_3999: original external response");
				expect(searched).toContain(outputId);
				return undefined;
			}
			const step = pending;
			pending = undefined;
			return step;
		});
		const config: Partial<SessionConfig> = {
			tools: [
				{
					name: "custom_external_name",
					description: "test",
					inputSchema: { type: "object" },
					execute: async () => externalOutput,
				},
			],
		};
		const session = makeSession(model, store, config);
		let resumed: SessionRuntime | undefined;
		try {
			expect((await session.run("go")).text).toBe("done");
			expect(store.readText("session", outputId)).toContain("row_4000:");

			for (let index = 0; index < 8; index++)
				await session.continue("follow up");
			expect(
				outputText(findResult(lastRequest, "custom_external_name")),
			).toContain(outputId);

			pending = {
				tool: "tool_output",
				input: {
					action: "read",
					id: outputId,
					start_line: 3500,
					end_line: 3500,
				},
			};
			await session.continue("read again");
			expect(outputText(findResult(lastRequest, "tool_output"))).toContain(
				"row_3497:",
			);

			const history = session.getMessages();
			session.restore(history);
			pending = {
				tool: "tool_output",
				input: { action: "read", id: outputId, start_line: 10, end_line: 10 },
			};
			await session.continue("read after restore");
			expect(outputText(findResult(lastRequest, "tool_output"))).toContain(
				"row_7:",
			);
			expect(
				outputText(findResult(lastRequest, "custom_external_name")),
			).toContain(outputId);

			await session.shutdown();
			resumed = makeSession(model, store, {
				...config,
				initialMessages: history,
			});
			pending = {
				tool: "tool_output",
				input: { action: "read", id: outputId, start_line: 20, end_line: 20 },
			};
			await resumed.continue("resume and read");
			expect(outputText(findResult(lastRequest, "tool_output"))).toContain(
				"row_17:",
			);
		} finally {
			await session.shutdown();
			await resumed?.shutdown();
		}
	});

	it("recovers structured output as YAML with preserved multiline text", async () => {
		const structured = {
			content: [{ type: "text", text: "alpha\nbeta needle\ngamma" }],
			structuredContent: {
				rows: Array.from({ length: 200 }, (_, id) => ({ id })),
			},
		};
		const store = new MemoryToolOutputStore();
		let searched = "";
		const { model } = scriptedModel((call, request) => {
			if (call === 0) return { tool: "external", input: { query: "x" } };
			if (call === 1)
				return {
					tool: "tool_output",
					input: { pattern: "needle", context_lines: 0 },
				};
			searched = outputText(findResult(request.messages, "tool_output"));
			return undefined;
		});
		const session = makeSession(model, store, {
			tools: [
				{
					name: "external",
					description: "test",
					inputSchema: { type: "object" },
					execute: async () => structured,
				},
			],
		});
		try {
			await session.run("go");
			const [record] = store.list("session", 10);
			expect(record.summary).toBe("x");
			const text = store.readText("session", record.id) ?? "";
			expect(text).toContain("text: |-");
			expect(text).toContain("beta needle");
			expect(searched).toMatch(/\d+: +beta needle/);
		} finally {
			await session.shutdown();
		}
	});

	it("keeps image bytes out of stored output", async () => {
		const image = {
			type: "image" as const,
			data: "x".repeat(200_000),
			mediaType: "image/png",
		};
		const store = new MemoryToolOutputStore();
		const { model } = scriptedModel((call) =>
			call === 0 ? { tool: "shot", input: {} } : undefined,
		);
		const session = makeSession(model, store, {
			tools: [
				{
					name: "shot",
					description: "test",
					inputSchema: { type: "object" },
					execute: async () => [
						{ type: "text", text: "caption ".repeat(400) },
						image,
					],
				},
			],
		});
		try {
			await session.run("go");
			const [record] = store.list("session", 10);
			const text = store.readText("session", record.id) ?? "";
			expect(text).toContain("[image attached]");
			expect(text).toContain("caption");
			expect(text).not.toContain(image.data);
		} finally {
			await session.shutdown();
		}
	});
});

describe("runtime tool output storing", () => {
	function storingSession(
		store: ToolOutputStore,
		tools: NonNullable<AgentConfig["tools"]>,
		inputFor: (call: number) => Step,
	): SessionRuntime {
		const { model } = scriptedModel((call) => inputFor(call));
		return makeSession(model, store, { tools });
	}

	function tool(
		name: string,
		execute: NonNullable<AgentConfig["tools"]>[number]["execute"],
		extra: Partial<NonNullable<AgentConfig["tools"]>[number]> = {},
	): NonNullable<AgentConfig["tools"]>[number] {
		return {
			name,
			description: "test",
			inputSchema: { type: "object" },
			execute,
			...extra,
		};
	}

	it("stores a result of at least 2000 characters with a summary of the call", async () => {
		const store = new MemoryToolOutputStore();
		const session = storingSession(
			store,
			[tool("big", async () => "x".repeat(2000))],
			(call) =>
				call === 0
					? { tool: "big", input: { command: "ls -la", ignored: 1 } }
					: undefined,
		);
		try {
			await session.run("go");
			const records = store.list("session", 10);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				toolName: "big",
				toolCallId: "call_0",
				summary: "ls -la",
				chars: 2000,
			});
			expect(store.readText("session", records[0].id)).toBe("x".repeat(2000));
		} finally {
			await session.shutdown();
		}
	});

	it("does not store a shorter result", async () => {
		const store = new MemoryToolOutputStore();
		const session = storingSession(
			store,
			[tool("small", async () => "x".repeat(1999))],
			(call) => (call === 0 ? { tool: "small", input: {} } : undefined),
		);
		try {
			await session.run("go");
			expect(store.list("session", 10)).toEqual([]);
		} finally {
			await session.shutdown();
		}
	});

	it("does not store output of a no-store tool", async () => {
		const store = new MemoryToolOutputStore();
		const session = storingSession(
			store,
			[
				tool("private", async () => "x".repeat(5000), {
					resultPolicy: "no-store",
				}),
			],
			(call) => (call === 0 ? { tool: "private", input: {} } : undefined),
		);
		try {
			await session.run("go");
			expect(store.list("session", 10)).toEqual([]);
		} finally {
			await session.shutdown();
		}
	});

	it("does not store tool_output results themselves", async () => {
		const store = new MemoryToolOutputStore();
		const session = storingSession(
			store,
			[tool("big", async () => "row\n".repeat(1000))],
			(call) => {
				if (call === 0) return { tool: "big", input: {} };
				if (call === 1)
					return {
						tool: "tool_output",
						input: { action: "search", pattern: "row" },
					};
				return undefined;
			},
		);
		try {
			await session.run("go");
			expect(
				store.list("session", 10).map((record) => record.toolName),
			).toEqual(["big"]);
		} finally {
			await session.shutdown();
		}
	});

	it("stores the call's result next to the executor's full copy and recovers the result", async () => {
		const store = new MemoryToolOutputStore();
		const full = "line\n".repeat(5000);
		const session = storingSession(
			store,
			[
				tool("shell", async (_input, context) => {
					const put = (
						context.metadata?.toolOutputStore as ToolOutputStore
					).put({
						sessionId: context.sessionId ?? context.agentId,
						toolCallId: `${context.toolCallId ?? ""}/command`,
						toolName: "shell",
						summary: "make all",
						text: full,
					});
					return `[truncated, stored as ${put?.id}]\n${"x".repeat(2500)}`;
				}),
			],
			(call) => (call === 0 ? { tool: "shell", input: {} } : undefined),
		);
		try {
			await session.run("go");
			const records = store.list("session", 10);
			expect(records).toHaveLength(2);
			const executorCopy = records.find(
				(record) => record.summary === "make all",
			);
			expect(executorCopy && store.readText("session", executorCopy.id)).toBe(
				full,
			);
			const callResult = records.find((record) => record !== executorCopy);
			expect(callResult && store.readText("session", callResult.id)).toContain(
				`stored as ${executorCopy?.id}`,
			);
		} finally {
			await session.shutdown();
		}
	});

	it("passes the store to executors in the tool context metadata", async () => {
		const store = new MemoryToolOutputStore();
		let seen: unknown;
		const session = storingSession(
			store,
			[
				tool("probe", async (_input, context) => {
					seen = context.metadata?.toolOutputStore;
					return "ok";
				}),
			],
			(call) => (call === 0 ? { tool: "probe", input: {} } : undefined),
		);
		try {
			await session.run("go");
			expect(seen).toBe(store);
		} finally {
			await session.shutdown();
		}
	});
});
