import { describe, expect, it } from "vitest";
import { nextUsageTokenDisplay, usageDeltaFromEvent } from "./session-context";

describe("nextUsageTokenDisplay", () => {
	it("uses streaming input tokens as an absolute context size", () => {
		let displayedTokens = 0;

		displayedTokens = nextUsageTokenDisplay(displayedTokens, {
			inputTokens: 633_000,
			outputTokens: 31_000,
		});
		displayedTokens = nextUsageTokenDisplay(displayedTokens, {
			inputTokens: 934_000,
			outputTokens: 266_000,
		});

		expect(displayedTokens).toBe(934_000);
	});

	it("ignores output-only usage events for the context size display", () => {
		expect(
			nextUsageTokenDisplay(633_000, {
				outputTokens: 31_000,
			}),
		).toBe(633_000);
	});
});

describe("usageDeltaFromEvent", () => {
	const usage = {
		type: "usage",
		inputTokens: 90_000,
		outputTokens: 10,
		cost: 0.5,
		totalInputTokens: 90_000,
		totalOutputTokens: 10,
	} as const;

	it("keeps a subagent's request size out of the context display but counts its cost", () => {
		const delta = usageDeltaFromEvent({ ...usage, parentAgentId: "lead" });
		expect(nextUsageTokenDisplay(1_000, delta)).toBe(1_000);
		expect(delta.cost).toBe(0.5);
	});

	it("takes the lead's request size as the context size", () => {
		expect(nextUsageTokenDisplay(1_000, usageDeltaFromEvent(usage))).toBe(
			90_000,
		);
	});
});
