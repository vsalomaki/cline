import { describe, expect, it, vi } from "vitest";
import {
	buildConfiguredAgentToolName,
	createConfiguredAgentTools,
	withConfiguredAgentToolPolicies,
} from "./configured-agent-tool";

const sessionRuntime = vi.hoisted(() => ({
	listener: undefined as ((event: unknown) => void) | undefined,
}));

vi.mock("../../../runtime/orchestration/session-runtime-orchestrator", () => ({
	SessionRuntime: class MockSessionRuntime {
		getAgentId = () => "child-1";
		getConversationId = () => "conv-child-1";
		getMessages = () => [];
		subscribeEvents(listener: (event: unknown) => void) {
			sessionRuntime.listener = listener;
			return () => {};
		}
		async run() {
			sessionRuntime.listener?.({
				type: "content_start",
				contentType: "tool",
				toolName: "read_files",
			});
			sessionRuntime.listener?.({
				type: "usage",
				inputTokens: 100,
				outputTokens: 20,
				totalInputTokens: 100,
				totalOutputTokens: 20,
				totalCost: 0.5,
			});
			return {
				text: "done",
				iterations: 1,
				finishReason: "completed",
				usage: { inputTokens: 100, outputTokens: 20 },
			};
		}
	},
}));

describe("configured agent tools", () => {
	it("builds stable subagent tool names", () => {
		expect(buildConfiguredAgentToolName("Code Reviewer")).toBe(
			"subagent_code_reviewer",
		);
		expect(buildConfiguredAgentToolName("___")).toBe("subagent_agent");
	});

	it("matches spawn_agent timeout and retry policy", () => {
		const [tool] = createReviewerTools();

		expect(tool?.name).toBe("subagent_code_reviewer");
		expect(tool?.executionMode).toBe("parallel");
		expect(tool?.timeoutMs).toBe(300000);
		expect(tool?.retryable).toBe(false);
	});

	it("reports progress and cost as tool updates while the agent works", async () => {
		const [tool] = createReviewerTools();
		const emitUpdate = vi.fn();

		await tool?.execute(
			{ prompt: "Review it" },
			{ agentId: "lead", conversationId: "conv", iteration: 1, emitUpdate },
		);

		expect(emitUpdate.mock.calls.map(([update]) => update)).toEqual([
			expect.objectContaining({ toolCalls: 1, latestToolCall: "read_files" }),
			expect.objectContaining({
				inputTokens: 100,
				outputTokens: 20,
				contextTokens: 120,
				totalCost: 0.5,
			}),
		]);
	});

	it("gives configured agent tools spawn_agent's policy unless they have their own", () => {
		const tools = createReviewerTools();
		const other = { ...tools[0], name: "subagent_lookalike" };
		const spawnPolicy = { autoApprove: false };

		expect(
			withConfiguredAgentToolPolicies({ spawn_agent: spawnPolicy }, [
				...tools,
				other,
			]),
		).toEqual({
			spawn_agent: spawnPolicy,
			subagent_code_reviewer: spawnPolicy,
		});
		expect(
			withConfiguredAgentToolPolicies(
				{
					spawn_agent: spawnPolicy,
					subagent_code_reviewer: { autoApprove: true },
				},
				tools,
			)?.subagent_code_reviewer,
		).toEqual({ autoApprove: true });
		expect(withConfiguredAgentToolPolicies(undefined, tools)).toBeUndefined();
	});
});

function createReviewerTools() {
	return createConfiguredAgentTools({
		configProvider: {
			getRuntimeConfig: () => ({
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				apiKey: "key",
			}),
			getConnectionConfig: () => ({
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				apiKey: "key",
			}),
			updateConnectionDefaults: () => {},
		},
		agents: [
			{
				name: "code-reviewer",
				description: "Reviews code",
				systemPrompt: "You are a code reviewer.",
			},
		],
	});
}
