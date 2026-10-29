import { describe, expect, it } from "vitest";
import { DiagnosticCounters } from "./diagnostics";

describe("DiagnosticCounters", () => {
	it("records nothing while disabled", () => {
		const counters = new DiagnosticCounters();

		counters.bump("calls");
		counters.max("size", 10);
		counters.level("inFlight", 1);

		expect(counters.enabled).toBe(false);
		expect(counters.totals().size).toBe(0);
		expect(counters.takeMaxes()).toEqual([]);
		expect(counters.levels().size).toBe(0);
		expect(counters.startTimer()).toBe(0);
		expect(counters.bumpElapsed("ms", 0)).toBe(0);
	});

	it("records totals, maxes and levels while enabled", () => {
		const counters = new DiagnosticCounters();
		counters.enable();

		counters.bump("calls");
		counters.bump("chars", 40);
		counters.bump("chars", 2);
		counters.max("size", 5);
		counters.max("size", 9);
		counters.max("size", 7);
		counters.level("inFlight", 1);
		counters.level("inFlight", 1);
		counters.level("inFlight", -1);

		expect([...counters.totals()]).toEqual([
			["calls", 1],
			["chars", 42],
		]);
		expect(counters.takeMaxes()).toEqual([["size", 9]]);
		expect(counters.takeMaxes()).toEqual([]);
		expect(counters.levels().get("inFlight")).toBe(1);
	});

	it("adds elapsed time only when the timer started while enabled", () => {
		const counters = new DiagnosticCounters();
		const startedDisabled = counters.startTimer();
		counters.enable();

		expect(counters.bumpElapsed("ms", startedDisabled)).toBe(0);
		expect(counters.totals().has("ms")).toBe(false);

		const start = counters.startTimer();
		expect(start).toBeGreaterThan(0);
		expect(counters.bumpElapsed("ms", start)).toBeGreaterThanOrEqual(0);
		expect(counters.totals().has("ms")).toBe(true);
	});

	it("clears recorded values on disable but keeps gauges", () => {
		const counters = new DiagnosticCounters();
		counters.enable();
		counters.bump("calls");
		counters.max("size", 3);
		counters.level("inFlight", 1);
		counters.gauge("subs", () => 2);

		counters.disable();
		counters.enable();

		expect(counters.totals().size).toBe(0);
		expect(counters.takeMaxes()).toEqual([]);
		expect(counters.levels().size).toBe(0);
		expect(counters.gauges().get("subs")?.()).toBe(2);
	});

	it("removes a gauge only if it is still the registered one", () => {
		const counters = new DiagnosticCounters();
		const removeFirst = counters.gauge("subs", () => 1);
		const removeSecond = counters.gauge("subs", () => 2);

		removeFirst();
		expect(counters.gauges().get("subs")?.()).toBe(2);

		removeSecond();
		expect(counters.gauges().has("subs")).toBe(false);
	});
});
