import { describe, expect, it } from "vitest";
import { type ContextUsageSnapshot, scaleContextUsage } from "./context-usage";

const snapshot: ContextUsageSnapshot = {
	estimatedTotal: 200,
	windowTokens: 1_000,
	compactAtTokens: 800,
	categories: {
		systemPrompt: 40,
		rules: [
			{
				id: "rules",
				source: "workspace",
				tokens: 20,
				files: [{ name: "style", tokens: 10 }],
			},
			{ id: "other", tokens: 10 },
		],
		memory: 10,
		tools: {
			builtin: 30,
			extension: 10,
			mcp: [{ server: "docs", tokens: 20 }],
		},
		messages: {
			conversation: 30,
			toolCalls: 10,
			toolResults: 15,
			filesAndImages: 5,
			summary: 0,
		},
	},
};

describe("scaleContextUsage", () => {
	it("scales every category by the provider's input count", () => {
		const scaled = scaleContextUsage(snapshot, 400);

		expect(scaled.estimatedTotal).toBe(400);
		expect(scaled.categories.systemPrompt).toBe(80);
		expect(scaled.categories.rules).toEqual([
			{
				id: "rules",
				source: "workspace",
				tokens: 40,
				files: [{ name: "style", tokens: 20 }],
			},
			{ id: "other", tokens: 20 },
		]);
		expect(scaled.categories.memory).toBe(20);
		expect(scaled.categories.tools).toEqual({
			builtin: 60,
			extension: 20,
			mcp: [{ server: "docs", tokens: 40 }],
		});
		expect(scaled.categories.messages).toEqual({
			conversation: 60,
			toolCalls: 20,
			toolResults: 30,
			filesAndImages: 10,
			summary: 0,
		});
	});

	it("keeps the window and the compaction point as they are", () => {
		const scaled = scaleContextUsage(snapshot, 400);

		expect(scaled.windowTokens).toBe(1_000);
		expect(scaled.compactAtTokens).toBe(800);
	});

	it("scales an empty estimate to zero", () => {
		const scaled = scaleContextUsage({ ...snapshot, estimatedTotal: 0 }, 400);

		expect(scaled.estimatedTotal).toBe(400);
		expect(scaled.categories.systemPrompt).toBe(0);
	});
});
