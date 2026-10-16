import { describe, expect, it } from "vitest";
import { createFakeCodeIntelligence } from "../code-intelligence/fake-provider.fixtures";
import {
	buildDelegatedAgentConfig,
	createDelegatedAgentConfigProvider,
} from "./delegated-agent";

describe("buildDelegatedAgentConfig", () => {
	it("inherits the parent distinctId and sessionId for telemetry grouping", () => {
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-5",
			distinctId: "user-123",
			sessionId: "sess-parent",
		});

		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
			parentAgentId: "agent-lead",
		});

		expect(config.distinctId).toBe("user-123");
		expect(config.sessionId).toBe("sess-parent");
		expect(config.parentAgentId).toBe("agent-lead");
	});

	it("inherits the parent's context limits", () => {
		const contextLimits = { message: { toolResultChars: 100_000 } };
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-5",
			contextLimits,
		});

		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
		});

		expect(config.contextLimits).toBe(contextLimits);
	});

	it("inherits the parent's code intelligence and problem settings", () => {
		const codeIntelligence = createFakeCodeIntelligence();
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-5",
			codeIntelligence,
			problemsAfterEdit: "warnings",
			problemsTimeoutMs: 500,
		});

		const config = buildDelegatedAgentConfig({
			kind: "teammate",
			prompt: "review the diff",
			tools: [],
			configProvider,
		});

		expect(config.codeIntelligence).toBe(codeIntelligence);
		expect(config.problemsAfterEdit).toBe("warnings");
		expect(config.problemsTimeoutMs).toBe(500);
	});

	it("leaves identity fields undefined when the parent has none", () => {
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-5",
		});

		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
		});

		expect(config.distinctId).toBeUndefined();
		expect(config.sessionId).toBeUndefined();
	});
});
