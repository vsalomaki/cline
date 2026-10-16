import { describe, expect, it } from "bun:test"
import { applyAgentLimitUpdates, getAgentLimitValue, normalizeAgentLimitValue } from "./AgentLimits"

describe("normalizeAgentLimitValue", () => {
	it("resets on negative, non-finite or unknown input", () => {
		expect(normalizeAgentLimitValue("tool.readLines", -1)).toBeUndefined()
		expect(normalizeAgentLimitValue("tool.readLines", Number.NaN)).toBeUndefined()
		expect(normalizeAgentLimitValue("tool.unknown", 10)).toBeUndefined()
	})

	it("rounds and clamps into the limit's range", () => {
		expect(normalizeAgentLimitValue("tool.readLines", 500.6)).toBe(501)
		expect(normalizeAgentLimitValue("tool.commandOutputChars", 10)).toBe(1_000)
		expect(normalizeAgentLimitValue("timeout.hook", 10 ** 12)).toBe(24 * 60 * 60 * 1000)
	})

	it("keeps 0 where the limit allows it and maps toggles to 0/1", () => {
		expect(normalizeAgentLimitValue("message.minOutdatedRewriteBytes", 0)).toBe(0)
		expect(normalizeAgentLimitValue("session.loopDetection", 0)).toBe(0)
		expect(normalizeAgentLimitValue("session.loopDetection", 5)).toBe(1)
	})

	it("keeps only a choice's listed values", () => {
		expect(normalizeAgentLimitValue("session.problemsAfterEdit", 0)).toBe(0)
		expect(normalizeAgentLimitValue("session.problemsAfterEdit", 2)).toBe(2)
		expect(normalizeAgentLimitValue("session.problemsAfterEdit", 3)).toBeUndefined()
		expect(normalizeAgentLimitValue("session.problemsAfterEdit", 1.5)).toBeUndefined()
	})
})

describe("applyAgentLimitUpdates", () => {
	it("sets, replaces and resets values", () => {
		const next = applyAgentLimitUpdates(
			{ "tool.readLines": 500, "timeout.search": 60_000 },
			{ "tool.readLines": 800, "timeout.search": -1, "compaction.triggerPercent": 75 },
		)

		expect(next).toEqual({ "tool.readLines": 800, "compaction.triggerPercent": 75 })
	})
})

describe("getAgentLimitValue", () => {
	it("falls back to the default", () => {
		expect(getAgentLimitValue(undefined, "session.maxConsecutiveMistakes")).toBe(6)
		expect(getAgentLimitValue({ "session.maxConsecutiveMistakes": 10 }, "session.maxConsecutiveMistakes")).toBe(10)
	})
})
