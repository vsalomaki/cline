import { diagnostics } from "@cline/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Logger } from "@/shared/services/Logger"
import { DiagnosticsLog } from "./diagnostics-log"

describe("DiagnosticsLog", () => {
	let lines: string[]

	beforeEach(() => {
		vi.useFakeTimers()
		lines = []
		vi.spyOn(Logger, "info").mockImplementation((message: string) => {
			lines.push(message)
		})
	})

	afterEach(() => {
		diagnostics.disable()
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("enables the registry while running and disables it on stop", () => {
		const log = new DiagnosticsLog()

		log.setEnabled(true)
		expect(log.running).toBe(true)
		expect(diagnostics.enabled).toBe(true)
		expect(lines[0]).toMatch(/^\[diag\] start heap_size_limit=/)

		log.setEnabled(false)
		expect(log.running).toBe(false)
		expect(diagnostics.enabled).toBe(false)
		expect(lines.at(-1)).toBe("[diag] stop")
	})

	it("logs counter deltas, maxima and gauges once a second", () => {
		const log = new DiagnosticsLog()
		const removeGauge = diagnostics.gauge("test.subs", () => 3)
		log.start()

		diagnostics.bump("test.calls", 2)
		diagnostics.max("test.size", 7)
		vi.advanceTimersByTime(1000)

		const line = lines.find((l) => l.startsWith("[diag] #1 "))
		expect(line).toContain("d: test.calls=2")
		expect(line).toContain("max: test.size=7")
		expect(line).toContain("test.subs=3")

		log.stop()
		removeGauge()
	})

	it("stops logging after stop", () => {
		const log = new DiagnosticsLog()
		log.start()
		log.stop()
		const count = lines.length

		diagnostics.bump("test.calls")
		vi.advanceTimersByTime(5000)
		log.tick()

		expect(lines.length).toBe(count)
		expect(diagnostics.totals().size).toBe(0)
	})
})
