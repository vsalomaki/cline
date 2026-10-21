import { createAgentRuntime } from "@cline/agents";
import type {
	AgentConfig,
	AgentEvent,
	AgentExtension,
	AgentModel,
	AgentTool,
	ContextUsageSnapshot,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import { getLastContextUsage } from "../../services/usage";
import {
	SessionRuntime,
	type SessionRuntimeConfig,
} from "./session-runtime-orchestrator";

const MODEL_ID = "test-model";

function tool(name: string, mcpServer?: string): AgentTool {
	return {
		name,
		description: `The ${name} tool.`,
		inputSchema: { type: "object", properties: {} },
		execute: async () => `${name} output`,
		...(mcpServer ? { mcpServer } : {}),
	};
}

const rulesAndMemory: AgentExtension = {
	name: "rules-and-memory",
	manifest: { capabilities: ["rules", "tools"] },
	setup: (api) => {
		api.registerRule({
			id: "workspace:rules",
			source: "combined-user-instructions",
			content: "# Rules\n## style\nUse tabs.",
			files: () => [{ name: "style", chars: 18 }],
		});
		api.registerRule({
			id: "cline-memory:index",
			source: "memory",
			content: "# Memory\n- prefers bun",
		});
		api.registerTool(tool("memory"));
	},
};

/** Calls `lookup` once, then answers; each response reports its input tokens. */
function scriptedModel(): AgentModel {
	let requests = 0;
	return {
		async stream() {
			requests += 1;
			const turn = requests;
			return (async function* () {
				if (turn === 1) {
					yield {
						type: "tool-call-delta" as const,
						toolCallId: "call_1",
						toolName: "lookup",
						inputText: JSON.stringify({ query: "x" }),
					};
					yield {
						type: "usage" as const,
						usage: { inputTokens: 1_000, outputTokens: 10 },
					};
					yield { type: "finish" as const, reason: "tool-calls" as const };
					return;
				}
				yield { type: "text-delta" as const, text: "done" };
				yield {
					type: "usage" as const,
					usage: { inputTokens: 1_500, outputTokens: 5 },
				};
				yield { type: "finish" as const, reason: "stop" as const };
			})();
		},
	};
}

function createSession(overrides: Partial<SessionRuntimeConfig> = {}) {
	const config: AgentConfig & SessionRuntimeConfig = {
		providerId: "openai-compatible",
		modelId: MODEL_ID,
		apiKey: "test-key",
		knownModels: {
			[MODEL_ID]: { id: MODEL_ID, name: MODEL_ID, contextWindow: 200_000 },
		},
		systemPrompt: "You are a helpful assistant.",
		tools: [
			tool("lookup"),
			tool("docs__search", "docs"),
			tool("docs__fetch", "docs"),
			tool("git__log", "git"),
		],
		extensions: [rulesAndMemory],
		contextUsage: { compactionTriggerRatio: 0.8 },
		...overrides,
	};
	const session = new SessionRuntime(config, {
		createAgentRuntimeImpl: (runtimeConfig) =>
			createAgentRuntime({ ...runtimeConfig, model: scriptedModel() }),
	});
	const usageEvents: Extract<AgentEvent, { type: "usage" }>[] = [];
	session.subscribeEvents((event) => {
		if (event.type === "usage") usageEvents.push(event);
	});
	return { session, usageEvents };
}

function snapshots(
	events: Extract<AgentEvent, { type: "usage" }>[],
): ContextUsageSnapshot[] {
	return events.map((event) => {
		expect(event.contextUsage).toBeDefined();
		return event.contextUsage as ContextUsageSnapshot;
	});
}

describe("SessionRuntime context usage", () => {
	it("reports each request's breakdown on its usage event", async () => {
		const { session, usageEvents } = createSession();

		await session.run("go");

		const [first, second] = snapshots(usageEvents);
		expect(usageEvents.map((event) => event.inputTokens)).toEqual([
			1_000, 1_500,
		]);
		expect(first?.categories.rules).toEqual([
			{
				id: "workspace:rules",
				source: "combined-user-instructions",
				tokens: expect.any(Number),
				files: [{ name: "style", tokens: 6 }],
			},
		]);
		expect(first?.categories.memory).toBeGreaterThan(0);
		expect(first?.categories.tools.extension).toBeGreaterThan(0);
		expect(first?.categories.tools.mcp.map((entry) => entry.server)).toEqual([
			"docs",
			"git",
		]);
		expect(first?.windowTokens).toBe(200_000);
		expect(first?.compactAtTokens).toBe(160_000);
		expect(first?.categories.messages.toolCalls).toBe(0);
		expect(second?.categories.messages.toolCalls).toBeGreaterThan(0);
		expect(second?.categories.messages.toolResults).toBeGreaterThan(0);
	});

	it("keeps the last breakdown on the assistant message across a reload", async () => {
		const { session, usageEvents } = createSession();
		await session.run("go");

		const persisted = JSON.parse(JSON.stringify(session.getMessages()));
		const reloaded = createSession();
		reloaded.session.restore(persisted);

		expect(getLastContextUsage(reloaded.session.getMessages())).toEqual({
			snapshot: usageEvents.at(-1)?.contextUsage,
			inputTokens: 1_500,
			compactedAfter: false,
		});
	});

	it("reports nothing for agents that are not the lead", async () => {
		const { session, usageEvents } = createSession({
			contextUsage: undefined,
		});

		await session.run("go");

		expect(usageEvents).toHaveLength(2);
		expect(usageEvents.some((event) => event.contextUsage)).toBe(false);
		expect(getLastContextUsage(session.getMessages())).toBeUndefined();
	});

	it("counts a steer message the agent takes in before a request", async () => {
		const plain = createSession();
		await plain.session.run("go");
		const steers = ["Also check the docs. ".repeat(100)];
		const steered = createSession({
			consumePendingUserMessage: () => steers.splice(0),
		});
		await steered.session.run("go");

		const [plainFirst] = snapshots(plain.usageEvents);
		const [steeredFirst] = snapshots(steered.usageEvents);
		expect(steeredFirst?.categories.messages.conversation).toBeGreaterThan(
			(plainFirst?.categories.messages.conversation ?? 0) + 100,
		);
	});

	it("leaves out the compaction point when compaction is off", async () => {
		const { session, usageEvents } = createSession({ contextUsage: {} });

		await session.run("go");

		expect(snapshots(usageEvents)[0]).not.toHaveProperty("compactAtTokens");
	});

	it("counts tools a before-model hook adds", async () => {
		const plain = createSession();
		await plain.session.run("go");
		const hooked = createSession({
			hooks: {
				beforeModel: async ({ request }) => ({
					tools: [
						...request.tools,
						{
							name: "hook_tool",
							description: "Added by a hook.",
							inputSchema: { type: "object" },
						},
					],
				}),
			},
		});
		await hooked.session.run("go");

		expect(
			snapshots(hooked.usageEvents)[0]?.categories.tools.builtin,
		).toBeGreaterThan(
			snapshots(plain.usageEvents)[0]?.categories.tools.builtin ?? 0,
		);
	});

	it("counts a prompt swapped in by turn preparation as system prompt", async () => {
		const { session, usageEvents } = createSession({
			prepareTurn: async () => ({ systemPrompt: "A saved prompt." }),
		});

		await session.run("go");

		const [first] = snapshots(usageEvents);
		expect(first?.categories.rules).toEqual([]);
		expect(first?.categories.memory).toBe(0);
		expect(first?.categories.systemPrompt).toBe(
			Math.ceil("A saved prompt.".length / 3),
		);
	});
});
