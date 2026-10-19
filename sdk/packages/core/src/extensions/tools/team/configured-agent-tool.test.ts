import { describe, expect, it } from "vitest";
import {
	buildConfiguredAgentToolName,
	createConfiguredAgentTools,
	withConfiguredAgentToolPolicies,
} from "./configured-agent-tool";

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
