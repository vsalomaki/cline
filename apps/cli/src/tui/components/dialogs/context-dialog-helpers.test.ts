import type { LastContextUsage } from "@cline/core";
import { describe, expect, it, vi } from "vitest";
import { buildContextUsageView } from "./context-dialog-helpers";

vi.mock("@opentui/react", () => ({
	useTerminalDimensions: () => ({ width: 80, height: 24 }),
}));

function lastUsage(
	overrides: Partial<LastContextUsage> = {},
): LastContextUsage {
	return {
		snapshot: {
			estimatedTotal: 1_000,
			categories: {
				systemPrompt: 200,
				rules: [
					{
						id: "cline-combined-user-instructions:rules",
						source: "combined-user-instructions",
						tokens: 100,
						files: [
							{ name: "style", tokens: 60 },
							{ name: "tests", tokens: 30 },
						],
					},
					{ id: "plugin:rule", tokens: 50 },
				],
				memory: 50,
				tools: {
					builtin: 300,
					extension: 0,
					mcp: [{ server: "docs", tokens: 100 }],
				},
				messages: {
					conversation: 100,
					toolCalls: 50,
					toolResults: 50,
					filesAndImages: 0,
					summary: 0,
				},
			},
			windowTokens: 100_000,
			compactAtTokens: 80_000,
		},
		inputTokens: 2_000,
		compactedAfter: false,
		...overrides,
	};
}

describe("buildContextUsageView", () => {
	it("lists every category in provider tokens with its share of the window", () => {
		const view = buildContextUsageView(lastUsage());

		expect(view.summary).toBe("2,000 of 100,000 tokens (2%)");
		expect(
			view.rows.map((row) => [
				row.sub ? `  ${row.label}` : row.label,
				row.tokens,
				row.share,
			]),
		).toEqual([
			["System prompt", 400, "0.4%"],
			["Rules", 300, "0.3%"],
			["  style", 120, "0.1%"],
			["  tests", 60, "0.1%"],
			["  plugin:rule", 100, "0.1%"],
			["Memory", 100, "0.1%"],
			["Tools", 800, "0.8%"],
			["  Built-in", 600, "0.6%"],
			["  MCP: docs", 200, "0.2%"],
			["Messages", 400, "0.4%"],
			["  Conversation", 200, "0.2%"],
			["  Tool calls", 100, "0.1%"],
			["  Tool results", 100, "0.1%"],
			["Free space", 98_000, "98%"],
		]);
		expect(view.compaction).toBe("Compacts at 80,000 tokens (80%)");
		expect(view.note).toBeUndefined();
	});

	it("marks the compaction point on the bar", () => {
		const { bar } = buildContextUsageView(lastUsage());

		expect(bar.filled.length + bar.empty.length).toBe(40);
		expect(bar.filled.length + (bar.markerOffset ?? 0)).toBe(32);
	});

	it("labels a breakdown from before a compaction", () => {
		const view = buildContextUsageView(lastUsage({ compactedAfter: true }));

		expect(view.note).toMatch(/before the context was compacted/);
	});

	it("says when auto-compaction is off", () => {
		const usage = lastUsage();
		const { compactAtTokens: _, ...snapshot } = usage.snapshot;

		expect(buildContextUsageView({ ...usage, snapshot }).compaction).toBe(
			"Auto-compaction is off",
		);
	});
});
