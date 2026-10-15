import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_LIMITS } from "../../settings/context-limits";
import {
	applySessionToolOptions,
	resolveSessionToolOptions,
} from "./session-tool-options";

describe("resolveSessionToolOptions", () => {
	it("resolves limits from overrides and keeps timeouts", () => {
		const options = resolveSessionToolOptions({
			contextLimits: { tool: { readLines: 500 } },
			toolTimeouts: { editorTimeoutMs: 60_000, ripgrepTimeoutMs: 20_000 },
		});

		expect(options.limits?.readLines).toBe(500);
		expect(options.limits?.lineChars).toBe(
			DEFAULT_CONTEXT_LIMITS.tool.lineChars,
		);
		expect(options.editorTimeoutMs).toBe(60_000);
		expect(options.ripgrepTimeoutMs).toBe(20_000);
	});
});

describe("applySessionToolOptions", () => {
	it("routes the ripgrep timeout to the search executor", () => {
		const applied = applySessionToolOptions(
			{ cwd: "/repo", executorOptions: { search: { maxResults: 10 } } },
			{ searchTimeoutMs: 45_000, ripgrepTimeoutMs: 20_000 },
		);

		expect(applied.searchTimeoutMs).toBe(45_000);
		expect(applied.executorOptions?.search).toEqual({
			ripgrepTimeoutMs: 20_000,
			maxResults: 10,
		});
		expect("ripgrepTimeoutMs" in applied).toBe(false);
	});

	it("lets explicit call options win over session options", () => {
		const applied = applySessionToolOptions(
			{ cwd: "/repo", searchTimeoutMs: 1_000 },
			{ searchTimeoutMs: 45_000 },
		);

		expect(applied.searchTimeoutMs).toBe(1_000);
	});
});
