import { describe, expect, it } from "bun:test"
import { MAX_COMMAND_TIMEOUT_MS, MIN_COMMAND_TIMEOUT_MS, normalizeCommandTimeoutMs } from "./CommandTimeouts"

describe("normalizeCommandTimeoutMs", () => {
	it("treats missing, zero, negative and non-finite values as a reset to the default", () => {
		expect(normalizeCommandTimeoutMs(undefined)).toBeUndefined()
		expect(normalizeCommandTimeoutMs(0)).toBeUndefined()
		expect(normalizeCommandTimeoutMs(-5_000)).toBeUndefined()
		expect(normalizeCommandTimeoutMs(Number.NaN)).toBeUndefined()
		expect(normalizeCommandTimeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined()
	})

	it("keeps in-range values, rounded to whole milliseconds", () => {
		expect(normalizeCommandTimeoutMs(120_000)).toBe(120_000)
		expect(normalizeCommandTimeoutMs(1_500.4)).toBe(1_500)
	})

	it("clamps out-of-range values", () => {
		expect(normalizeCommandTimeoutMs(1)).toBe(MIN_COMMAND_TIMEOUT_MS)
		expect(normalizeCommandTimeoutMs(MAX_COMMAND_TIMEOUT_MS + 1)).toBe(MAX_COMMAND_TIMEOUT_MS)
	})
})
