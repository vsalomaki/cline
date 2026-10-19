import type { AgentConfig } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDelegatedAgentConfigProvider } from "./delegated-agent";

type AgentExtension = NonNullable<AgentConfig["extensions"]>[number];

const runMock = vi.fn();
const getAgentIdMock = vi.fn(() => "sub-agent-1");
const getConversationIdMock = vi.fn(() => "conv-sub-1");
const agentConstructorSpy = vi.fn();
const subscribeEventsMock = vi.fn();
const getMessagesMock = vi.fn((): unknown[] => []);

vi.mock("../../../runtime/orchestration/session-runtime-orchestrator", () => {
	return {
		SessionRuntime: class MockSessionRuntime {
			constructor(config: unknown) {
				agentConstructorSpy(config);
			}

			getAgentId(): string {
				return getAgentIdMock();
			}

			getConversationId(): string {
				return getConversationIdMock();
			}

			subscribeEvents(listener: (event: unknown) => void): () => void {
				subscribeEventsMock(listener);
				return () => {};
			}

			getMessages(): unknown[] {
				return getMessagesMock();
			}

			async run(input: string): Promise<unknown> {
				return runMock(input);
			}
		},
	};
});

describe("createSpawnAgentTool", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("creates a sub-agent, forwards callbacks, and returns normalized output", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "sub-agent result",
			iterations: 2,
			finishReason: "completed",
			usage: { inputTokens: 11, outputTokens: 7 },
		});

		const onSubAgentStart = vi.fn();
		const onSubAgentEnd = vi.fn();
		const createSubAgentTools = vi.fn().mockResolvedValue([]);
		const extensions = [
			{
				name: "sample-ext",
				manifest: { capabilities: ["hooks"] },
				hooks: { onEvent: vi.fn() },
			} as AgentExtension,
		];

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
				extensions,
			}),
			defaultMaxIterations: 4,
			createSubAgentTools,
			onSubAgentStart,
			onSubAgentEnd,
		});

		const output = await tool.execute(
			{
				systemPrompt: "You are focused",
				task: "Do delegated work",
			},
			{
				agentId: "parent-1",
				conversationId: "conv-parent",
				iteration: 3,
			},
		);

		expect(createSubAgentTools).toHaveBeenCalledTimes(1);
		expect(runMock).toHaveBeenCalledWith("Do delegated work");
		expect(onSubAgentStart).toHaveBeenCalledTimes(1);
		expect(onSubAgentEnd).toHaveBeenCalledTimes(1);
		expect(output).toEqual({
			text: "sub-agent result",
			iterations: 2,
			finishReason: "completed",
			usage: {
				inputTokens: 11,
				outputTokens: 7,
			},
		});
		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				parentAgentId: "parent-1",
				maxIterations: 4,
				extensions,
			}),
		);
		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.not.objectContaining({
				prepareTurn: expect.anything(),
			}),
		);
	});

	it("passes extension hooks through delegated config", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "sub-agent result",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const extensions = [
			{
				name: "before-start-ext",
				manifest: {
					capabilities: ["hooks"],
				},
				hooks: { beforeModel: vi.fn() },
			} as AgentExtension,
		];

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
				extensions,
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "You are focused",
				task: "Do delegated work",
			},
			{
				agentId: "parent-1",
				conversationId: "conv-parent",
				iteration: 3,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				extensions,
			}),
		);
	});

	it("propagates sub-agent errors and still reports onSubAgentEnd", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockRejectedValue(new Error("sub-agent failed"));
		const onSubAgentEnd = vi.fn();

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
			onSubAgentEnd,
		});

		await expect(
			tool.execute(
				{
					systemPrompt: "System",
					task: "Fail task",
				},
				{
					agentId: "parent-2",
					conversationId: "conv-parent",
					iteration: 1,
				},
			),
		).rejects.toThrow("sub-agent failed");

		expect(onSubAgentEnd).toHaveBeenCalledTimes(1);
		expect(onSubAgentEnd).toHaveBeenCalledWith(
			expect.objectContaining({
				parentAgentId: "parent-2",
				error: expect.any(Error),
			}),
		);
	});

	it("reports each sub-agent turn with its messages", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const messages = [{ role: "user", content: "Do delegated work" }];
		getMessagesMock.mockReturnValue(messages);
		runMock.mockImplementation(async () => {
			const listener = subscribeEventsMock.mock.calls[0]?.[0];
			listener?.({ type: "iteration_start", iteration: 1 });
			listener?.({
				type: "iteration_end",
				iteration: 1,
				hadToolCalls: false,
				toolCallCount: 0,
			});
			return {
				text: "done",
				iterations: 1,
				finishReason: "completed",
				usage: { inputTokens: 1, outputTokens: 1 },
			};
		});
		const onSubAgentTurn = vi.fn();

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
			onSubAgentTurn,
		});
		await tool.execute(
			{ systemPrompt: "System", task: "Do delegated work" },
			{ agentId: "parent-1", conversationId: "conv-parent", iteration: 1 },
		);

		expect(onSubAgentTurn).toHaveBeenCalledTimes(1);
		expect(onSubAgentTurn).toHaveBeenCalledWith({
			subAgentId: "sub-agent-1",
			messages,
		});
	});

	it("leaves maxIterations unset when neither input nor default is provided", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "sub-agent result",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "System",
				task: "Do task",
			},
			{
				agentId: "parent-3",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				maxIterations: undefined,
			}),
		);
	});

	it("appends workspace metadata for cline sub-agents when missing", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const workspaceMetadata = `# Workspace Configuration
{
  "workspaces": {
    "/repo/demo": {
      "hint": "demo"
    }
  }
}`;

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "cline",
				modelId: "anthropic/claude-sonnet-4.6",
				cwd: "/repo/demo",
				workspaceMetadata,
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "You are a specialist teammate.",
				task: "Investigate module boundaries",
			},
			{
				agentId: "parent-4",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				systemPrompt: expect.stringContaining(workspaceMetadata),
			}),
		);
	});

	it("does not duplicate workspace metadata for cline sub-agents", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const inputSystemPrompt = `You are a specialist teammate.

# Workspace Configuration
{
  "workspaces": {
    "/repo/demo": {
      "hint": "demo"
    }
  }
}`;

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "cline",
				modelId: "anthropic/claude-sonnet-4.6",
				cwd: "/repo/demo",
				workspaceMetadata: "# Workspace Configuration\n{}",
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: inputSystemPrompt,
				task: "Investigate module boundaries",
			},
			{
				agentId: "parent-5",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		const { systemPrompt } = agentConstructorSpy.mock.calls.at(-1)?.[0] as {
			systemPrompt: string;
		};
		expect(systemPrompt).toContain(inputSystemPrompt);
		expect(systemPrompt.split("# Workspace Configuration")).toHaveLength(2);
	});

	it("gives sub-agents Cline's rules and environment around the role, for any provider", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "openai-compatible",
				modelId: "local-model",
				cwd: "/repo/demo",
				clineIdeName: "VS Code",
				clinePlatform: "linux",
				mode: "plan",
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{ systemPrompt: "You map module boundaries.", task: "Investigate" },
			{ agentId: "parent-6", conversationId: "conv-parent", iteration: 1 },
		);

		const { systemPrompt } = agentConstructorSpy.mock.calls.at(-1)?.[0] as {
			systemPrompt: string;
		};
		expect(systemPrompt).toContain(
			"<role>\nYou map module boundaries.\n</role>",
		);
		expect(systemPrompt).toContain("Working Directory: /repo/demo");
		expect(systemPrompt).toContain("IDE: VS Code");
		expect(systemPrompt).toContain("investigate only");
	});

	it("builds a configured agent's compaction on its own connection", async () => {
		const { createConfiguredAgentTools } = await import(
			"./configured-agent-tool.js"
		);
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		const createPrepareTurn = vi.fn(() => async () => undefined);
		const [tool] = createConfiguredAgentTools({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
			}),
			agents: [
				{
					name: "local-reviewer",
					description: "Reviews code",
					systemPrompt: "You review code.",
					providerId: "openai-compatible",
					modelId: "local-model",
				},
			],
			createPrepareTurn,
		});

		await tool?.execute(
			{ prompt: "Review" },
			{ agentId: "parent-9", conversationId: "conv-parent", iteration: 1 },
		);

		expect(createPrepareTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "openai-compatible",
				modelId: "local-model",
			}),
		);
	});

	it("passes a fresh prepareTurn to each sub-agent", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		const createPrepareTurn = vi.fn(() => async () => undefined);
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
			}),
			subAgentTools: [],
			createPrepareTurn,
		});

		for (const agentId of ["parent-7", "parent-8"]) {
			await tool.execute(
				{ systemPrompt: "Helper.", task: "Do it" },
				{ agentId, conversationId: "conv-parent", iteration: 1 },
			);
		}

		expect(createPrepareTurn).toHaveBeenCalledTimes(2);
		const [first, second] = agentConstructorSpy.mock.calls
			.slice(-2)
			.map(([config]) => (config as { prepareTurn?: unknown }).prepareTurn);
		expect(first).toBeTypeOf("function");
		expect(second).not.toBe(first);
	});

	it("resolves connection settings lazily at execution time", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "cline",
			modelId: "stale-model",
			apiKey: "oauth-access-old",
			temperature: 0.3,
		});
		const updateConnectionDefaults = vi.spyOn(
			configProvider,
			"updateConnectionDefaults",
		);
		configProvider.updateConnectionDefaults({
			apiKey: "oauth-access-new",
			modelId: "updated-model",
		});

		const tool = createSpawnAgentTool({
			configProvider,
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "System",
				task: "Do task",
			},
			{
				agentId: "parent-6",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(updateConnectionDefaults).toHaveBeenCalledTimes(1);
		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "oauth-access-new",
				modelId: "updated-model",
				temperature: 0.3,
			}),
		);
	});
});

describe("SubAgentProgress with a known context window", () => {
	it("reports the context usage percentage", async () => {
		const { SubAgentProgress } = await import("./spawn-agent-tool");
		const progress = new SubAgentProgress(1000);

		expect(
			progress.apply({
				type: "usage",
				inputTokens: 240,
				outputTokens: 10,
				totalInputTokens: 240,
				totalOutputTokens: 10,
			}),
		).toMatchObject({
			contextTokens: 250,
			contextWindow: 1000,
			contextUsagePercentage: 25,
		});
	});
});

describe("SubAgentProgress", () => {
	it("counts tool calls and keeps the sub-agent's usage totals", async () => {
		const { SubAgentProgress } = await import("./spawn-agent-tool");
		const progress = new SubAgentProgress();

		expect(
			progress.apply({
				type: "content_start",
				contentType: "tool",
				toolName: "read_files",
				toolCallId: "t1",
			}),
		).toEqual({
			toolCalls: 1,
			latestToolCall: "read_files",
			inputTokens: 0,
			outputTokens: 0,
			contextTokens: 0,
		});
		expect(
			progress.apply({
				type: "usage",
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 100,
				totalInputTokens: 30,
				totalOutputTokens: 12,
				totalCost: 0.01,
			}),
		).toEqual({
			toolCalls: 1,
			latestToolCall: "read_files",
			inputTokens: 30,
			outputTokens: 12,
			contextTokens: 15,
			totalCost: 0.01,
		});
		expect(
			progress.apply({
				type: "content_start",
				contentType: "text",
				text: "hi",
			}),
		).toBeUndefined();
	});
});
