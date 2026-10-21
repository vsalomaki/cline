import { describe, it } from "bun:test"
import { strict as assert } from "node:assert"
import { buildContextUsageView, formatWindowShare } from "../contextUsageView"

describe("buildContextUsageView", () => {
	const snapshot = {
		estimatedTotal: 1000,
		categories: {
			systemPrompt: 300,
			rules: [
				{
					id: "user-instructions",
					tokens: 100,
					files: [
						{ name: ".clinerules/style.md", tokens: 60 },
						{ name: "global.md", tokens: 40 },
					],
				},
				{ id: "plugin-rule", tokens: 20 },
			],
			memory: 0,
			tools: { builtin: 200, extension: 0, mcp: [{ server: "github", tokens: 80 }] },
			messages: { conversation: 150, toolCalls: 50, toolResults: 50, filesAndImages: 50, summary: 0 },
		},
		windowTokens: 100_000,
		compactAtTokens: 80_000,
	}

	it("scales every category to the request's input tokens and lists rule files and MCP servers", () => {
		const view = buildContextUsageView({ snapshot, inputTokens: 2_000, usedTokens: 2_000, compactedAfter: false })

		assert.equal(view.usedTokens, 2_000)
		assert.equal(view.freeTokens, 98_000)
		assert.equal(view.compactAtTokens, 80_000)
		assert.deepEqual(
			view.categories.map(({ id, tokens }) => [id, tokens]),
			[
				["system", 600],
				["rules", 240],
				["tools", 560],
				["messages", 500],
				["files", 100],
			],
		)
		const rules = view.categories.find((category) => category.id === "rules")
		assert.deepEqual(
			rules?.items.map(({ label, tokens }) => [label, tokens]),
			[
				[".clinerules/style.md", 120],
				["global.md", 80],
				["plugin-rule", 40],
			],
		)
		const tools = view.categories.find((category) => category.id === "tools")
		assert.deepEqual(
			tools?.items.map(({ label }) => label),
			["Built-in", "MCP: github"],
		)
	})

	it("adds up the scaled parts so a category equals its rows", () => {
		const parts = {
			estimatedTotal: 8,
			categories: {
				systemPrompt: 1,
				rules: [
					{ id: "a", tokens: 1 },
					{ id: "b", tokens: 1 },
					{ id: "c", tokens: 1 },
				],
				memory: 0,
				tools: { builtin: 1, extension: 1, mcp: [] },
				messages: { conversation: 1, toolCalls: 1, toolResults: 0, filesAndImages: 0, summary: 0 },
			},
			windowTokens: 100,
		}
		const view = buildContextUsageView({ snapshot: parts, inputTokens: 4, usedTokens: 4, compactedAfter: false })

		for (const id of ["rules", "tools", "messages"]) {
			const category = view.categories.find((entry) => entry.id === id)
			assert.equal(
				category?.tokens,
				category?.items.reduce((total, item) => total + item.tokens, 0),
			)
		}
		assert.equal(view.categories.find((entry) => entry.id === "rules")?.tokens, 3)
	})

	it("shows the rescaled used tokens but keeps the rows on the request", () => {
		const view = buildContextUsageView({ snapshot, inputTokens: 2_000, usedTokens: 1_000, compactedAfter: true })

		assert.equal(view.usedTokens, 1_000)
		assert.equal(view.freeTokens, 98_000)
		assert.equal(view.categories.find((entry) => entry.id === "system")?.tokens, 600)
	})

	it("never reports negative free space and leaves out the compaction point when compaction is off", () => {
		const { compactAtTokens: _, ...noCompaction } = snapshot
		const view = buildContextUsageView({
			snapshot: noCompaction,
			inputTokens: 120_000,
			usedTokens: 120_000,
			compactedAfter: true,
		})

		assert.equal(view.freeTokens, 0)
		assert.equal(view.compactAtTokens, undefined)
		assert.equal(view.compactedAfter, true)
	})
})

describe("formatWindowShare", () => {
	it("keeps one decimal below ten percent", () => {
		assert.equal(formatWindowShare(4_200, 100_000), "4.2%")
		assert.equal(formatWindowShare(42_400, 100_000), "42%")
		assert.equal(formatWindowShare(10, 0), "0.0%")
	})
})
