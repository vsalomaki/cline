import type { MessageWithMetadata } from "@cline/llms";
import { describe, expect, it } from "vitest";
import {
	getCurrentContextSize,
	getLastContextUsage,
	summarizeUsageFromMessages,
} from "./usage";

function assistant(
	metrics?: MessageWithMetadata["metrics"],
): MessageWithMetadata {
	return {
		role: "assistant",
		content: "ok",
		...(metrics ? { metrics } : {}),
	};
}

function user(): MessageWithMetadata {
	return { role: "user", content: "hi" };
}

describe("getCurrentContextSize", () => {
	it("returns undefined when there is no assistant message", () => {
		expect(getCurrentContextSize([user()])).toBeUndefined();
		expect(getCurrentContextSize([])).toBeUndefined();
	});

	it("returns undefined when the latest assistant message has no metrics", () => {
		expect(getCurrentContextSize([user(), assistant()])).toBeUndefined();
	});

	it("uses the latest assistant call's inputTokens", () => {
		const messages: MessageWithMetadata[] = [
			user(),
			assistant({ inputTokens: 100, outputTokens: 10 }),
			user(),
			assistant({ inputTokens: 5000, outputTokens: 50 }),
		];

		expect(getCurrentContextSize(messages)).toBe(5000);
	});

	it("ignores user messages after the latest assistant message", () => {
		expect(
			getCurrentContextSize([assistant({ inputTokens: 250 }), user()]),
		).toBe(250);
	});

	it("returns undefined when inputTokens is zero", () => {
		expect(
			getCurrentContextSize([assistant({ inputTokens: 0, outputTokens: 0 })]),
		).toBeUndefined();
	});

	it("does not double-count cache token details", () => {
		expect(
			getCurrentContextSize([
				assistant({ inputTokens: 9096, cacheReadTokens: 9090 }),
			]),
		).toBe(9096);
		expect(
			getCurrentContextSize([
				assistant({ inputTokens: 6538, cacheWriteTokens: 6535 }),
			]),
		).toBe(6538);
	});
});

describe("summarizeUsageFromMessages", () => {
	it("sums additive per-message cost", () => {
		expect(
			summarizeUsageFromMessages([
				assistant({ inputTokens: 100, outputTokens: 10, cost: 0.01 }),
				assistant({ inputTokens: 200, outputTokens: 20, cost: 0.02 }),
			]).totalCost,
		).toBe(0.03);
	});
});

describe("getLastContextUsage", () => {
	const snapshot = {
		estimatedTotal: 100,
		windowTokens: 1_000,
		categories: {},
	};
	function measured(): MessageWithMetadata {
		return {
			...assistant({ inputTokens: 150 }),
			metadata: { contextUsage: snapshot },
		};
	}

	it("reads the latest assistant message's breakdown", () => {
		expect(getLastContextUsage([user(), measured(), user()])).toEqual({
			snapshot,
			inputTokens: 150,
			compactedAfter: false,
		});
	});

	it("is undefined without a breakdown", () => {
		expect(getLastContextUsage([user(), assistant({ inputTokens: 5 })])).toBe(
			undefined,
		);
	});

	it("marks a compaction summary that came after the request", () => {
		const summary: MessageWithMetadata = {
			role: "user",
			content: "summary",
			metadata: { kind: "compaction_summary" },
		};
		expect(
			getLastContextUsage([user(), measured(), summary])?.compactedAfter,
		).toBe(true);
	});

	it("marks a request a saved compaction covers", () => {
		const messages = [user(), measured(), user()];
		expect(getLastContextUsage(messages, 2)?.compactedAfter).toBe(true);
		expect(getLastContextUsage(messages, 1)?.compactedAfter).toBe(false);
	});

	it("leaves display-only messages out of the compaction count", () => {
		const notice: MessageWithMetadata = {
			role: "user",
			content: "notice",
			metadata: { displayOnly: true },
		};
		const messages = [user(), notice, measured()];
		expect(getLastContextUsage(messages, 2)?.compactedAfter).toBe(true);
		expect(getLastContextUsage(messages, 1)?.compactedAfter).toBe(false);
	});
});
