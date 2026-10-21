import type { AgentEvent, ContextUsageSnapshot } from "@cline/core";
import { describe, expect, it } from "vitest";
import { contextUsageFromEvent, formatContextUsageStat } from "./context-usage";

const snapshot: ContextUsageSnapshot = {
	estimatedTotal: 100,
	categories: {
		systemPrompt: 100,
		rules: [],
		memory: 0,
		tools: { builtin: 0, extension: 0, mcp: [] },
		messages: {
			conversation: 0,
			toolCalls: 0,
			toolResults: 0,
			filesAndImages: 0,
			summary: 0,
		},
	},
	windowTokens: 200_000,
};

function usage(
	overrides: Partial<Extract<AgentEvent, { type: "usage" }>> = {},
): Extract<AgentEvent, { type: "usage" }> {
	return {
		type: "usage",
		inputTokens: 12_345,
		outputTokens: 10,
		totalInputTokens: 12_345,
		totalOutputTokens: 10,
		contextUsage: snapshot,
		...overrides,
	};
}

describe("contextUsageFromEvent", () => {
	it("takes the lead's breakdown with the request's input count", () => {
		expect(contextUsageFromEvent(usage())).toEqual({
			snapshot,
			inputTokens: 12_345,
			compactedAfter: false,
		});
	});

	it("ignores subagents and events without a breakdown", () => {
		expect(
			contextUsageFromEvent(usage({ parentAgentId: "lead" })),
		).toBeUndefined();
		expect(
			contextUsageFromEvent(usage({ contextUsage: undefined })),
		).toBeUndefined();
	});
});

describe("formatContextUsageStat", () => {
	it("reports the last request against the window", () => {
		expect(
			formatContextUsageStat({
				snapshot,
				inputTokens: 12_345,
				compactedAfter: false,
			}),
		).toBe("context 12,345 of 200,000 (6%)");
	});
});
