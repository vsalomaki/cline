import { describe, it } from "bun:test"
import { strict as assert } from "node:assert"
import type { ClineMessage } from "../ExtensionMessage"
import { getApiMetrics, getContextUsedTokens, getLastApiReqTotalTokens, getLastContextUsage } from "../getApiMetrics"

describe("getApiMetrics", () => {
	it("includes subagent_usage in aggregate totals", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 10,
					tokensOut: 20,
					cacheWrites: 3,
					cacheReads: 1,
					cost: 0.12,
				}),
			},
			{
				ts: 2,
				type: "say",
				say: "subagent_usage",
				text: JSON.stringify({
					source: "subagents",
					tokensIn: 4,
					tokensOut: 8,
					cacheWrites: 2,
					cacheReads: 1,
					cost: 0.05,
				}),
			},
			{
				ts: 3,
				type: "say",
				say: "deleted_api_reqs",
				text: JSON.stringify({
					tokensIn: 6,
					tokensOut: 9,
					cacheWrites: 1,
					cacheReads: 0,
					cost: 0.03,
				}),
			},
		]

		const metrics = getApiMetrics(messages)

		assert.equal(metrics.totalTokensIn, 20)
		assert.equal(metrics.totalTokensOut, 37)
		assert.equal(metrics.totalCacheWrites, 6)
		assert.equal(metrics.totalCacheReads, 2)
		assert.ok(Math.abs(metrics.totalCost - 0.2) < 1e-9)
	})

	it("ignores malformed usage payloads", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "subagent_usage",
				text: "{not-json",
			},
		]

		const metrics = getApiMetrics(messages)
		assert.equal(metrics.totalTokensIn, 0)
		assert.equal(metrics.totalTokensOut, 0)
		assert.equal(metrics.totalCost, 0)
	})
})

describe("getLastApiReqTotalTokens", () => {
	it("uses only the latest api_req_started payload", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "subagent_usage",
				text: JSON.stringify({
					source: "subagents",
					tokensIn: 100,
					tokensOut: 200,
				}),
			},
			{
				ts: 2,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 11,
					tokensOut: 7,
					cacheWrites: 2,
					cacheReads: 3,
				}),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 23)
	})

	it("scales the last request by the shrink ratio of a compaction completed after it", () => {
		// The compaction counters are the SDK's estimate — a different scale from
		// the provider-reported request total. Only the ratio carries over.
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 90_000, tokensOut: 5_000, cacheReads: 5_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 200_000, tokensAfter: 50_000 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 25_000)
	})

	it("compounds multiple compactions completed since the last request", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 100_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 200_000, tokensAfter: 100_000 }),
			},
			{
				ts: 3,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 100_000, tokensAfter: 50_000 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 25_000)
	})

	it("grows the request total when a compaction made the estimated context larger", () => {
		// Compacting a tiny conversation can produce a summary bigger than the
		// original messages. The header must follow the divider's direction
		// instead of freezing at the pre-compaction value.
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 4_000, tokensOut: 1_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 1_000, tokensAfter: 1_300 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 6_500)
	})

	it("leaves the request total unscaled when a completed compaction lacks token counters", () => {
		// The coordinator's fallback divider carries only message counts.
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 40_000, tokensOut: 2_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", messagesBefore: 40, messagesAfter: 6 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 42_000)
	})

	it("returns 0 when a compaction completed but no request preceded it", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 95_000, tokensAfter: 30_000 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 0)
	})

	it("ignores compaction rows without a usable compacted size", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 11, tokensOut: 7, cacheWrites: 2, cacheReads: 3 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "started", mode: "auto" }),
			},
			{
				ts: 3,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "failed", mode: "auto" }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 23)
	})

	it("prefers a request newer than the last compaction", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "auto", tokensBefore: 95_000, tokensAfter: 30_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 31_000, tokensOut: 1_000 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 32_000)
	})
})

describe("getLastContextUsage", () => {
	const snapshot = {
		estimatedTotal: 1000,
		categories: {
			systemPrompt: 500,
			rules: [],
			memory: 0,
			tools: { builtin: 250, extension: 0, mcp: [] },
			messages: { conversation: 250, toolCalls: 0, toolResults: 0, filesAndImages: 0, summary: 0 },
		},
		windowTokens: 200_000,
	}
	const request = (ts: number, info: object): ClineMessage => ({
		ts,
		type: "say",
		say: "api_req_started",
		text: JSON.stringify(info),
	})

	const compaction = (ts: number, info: object): ClineMessage => ({
		ts,
		type: "say",
		say: "compaction",
		text: JSON.stringify({ status: "completed", mode: "auto", ...info }),
	})

	it("returns the last breakdown with the request's raw input tokens", () => {
		const usage = getLastContextUsage([
			request(1, { tokensIn: 5, contextUsage: { ...snapshot, windowTokens: 1 } }),
			request(2, { tokensIn: 100, tokensOut: 40, cacheReads: 2_000, cacheWrites: 300, contextUsage: snapshot }),
		])

		assert.deepEqual(usage, { snapshot, inputTokens: 2_400, usedTokens: 2_400, compactedAfter: false })
	})

	it("returns nothing when the newest request has no breakdown, rather than an older one's", () => {
		assert.equal(
			getLastContextUsage([
				request(1, { tokensIn: 100, contextUsage: snapshot }),
				request(2, { tokensIn: 50, tokensOut: 10 }),
			]),
			undefined,
		)
	})

	it("returns undefined when no request carried a breakdown", () => {
		assert.equal(getLastContextUsage([request(1, { tokensIn: 10, tokensOut: 5 })]), undefined)
	})

	it("marks the breakdown as out of date when a compaction completed after it", () => {
		const failed: ClineMessage = { ts: 2, type: "say", say: "compaction", text: JSON.stringify({ status: "failed" }) }

		assert.equal(getLastContextUsage([request(1, { tokensIn: 10, contextUsage: snapshot }), failed])?.compactedAfter, false)
		assert.equal(
			getLastContextUsage([request(1, { tokensIn: 10, contextUsage: snapshot }), compaction(2, {})])?.compactedAfter,
			true,
		)
		assert.equal(
			getLastContextUsage([compaction(1, {}), request(2, { tokensIn: 10, contextUsage: snapshot })])?.compactedAfter,
			false,
		)
	})

	it("rescales the input by the compactions that report sizes and leaves it when none does", () => {
		const base = request(1, { tokensIn: 1_000, tokensOut: 500, contextUsage: snapshot })

		const scaled = getLastContextUsage([base, compaction(2, { tokensBefore: 1_000, tokensAfter: 400 })])
		assert.equal(scaled?.inputTokens, 1_000)
		assert.equal(scaled?.usedTokens, 400)
		assert.equal(scaled?.compactedAfter, true)

		const unsized = getLastContextUsage([base, compaction(2, { messagesBefore: 9, messagesAfter: 2 })])
		assert.equal(unsized?.usedTokens, 1_000)
		assert.equal(unsized?.compactedAfter, true)
	})
})

describe("getContextUsedTokens", () => {
	const snapshot = {
		estimatedTotal: 1000,
		categories: {
			systemPrompt: 1000,
			rules: [],
			memory: 0,
			tools: { builtin: 0, extension: 0, mcp: [] },
			messages: { conversation: 0, toolCalls: 0, toolResults: 0, filesAndImages: 0, summary: 0 },
		},
		windowTokens: 200_000,
	}
	const request = (info: object): ClineMessage => ({ ts: 1, type: "say", say: "api_req_started", text: JSON.stringify(info) })
	const compaction: ClineMessage = {
		ts: 2,
		type: "say",
		say: "compaction",
		text: JSON.stringify({ status: "completed", tokensBefore: 1_000, tokensAfter: 500 }),
	}

	it("is input-only, before and after a compaction, when the request has a breakdown", () => {
		const messages = [request({ tokensIn: 1_000, tokensOut: 300, contextUsage: snapshot })]

		assert.equal(getContextUsedTokens(messages), 1_000)
		assert.equal(getContextUsedTokens([...messages, compaction]), 500)
	})

	it("keeps input plus output for tasks without a breakdown", () => {
		assert.equal(getContextUsedTokens([request({ tokensIn: 1_000, tokensOut: 300 })]), 1_300)
	})
})
