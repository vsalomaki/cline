import { describe, expect, it } from "vitest";
import { applyMemoryEnv, resolveMemorySettings } from "./memory";

describe("resolveMemorySettings", () => {
	it("is off by default and extracts after runs once on", () => {
		expect(resolveMemorySettings({}, {})).toEqual({
			enabled: false,
			extractAfterRun: true,
		});
		expect(
			resolveMemorySettings({ enabled: true, extractAfterRun: false }, {}),
		).toEqual({ enabled: true, extractAfterRun: false });
	});

	it("uses env only where config leaves a value unset", () => {
		expect(
			resolveMemorySettings(
				{ enabled: false, extractAfterRun: true },
				{ CLINE_MEMORY: "1", CLINE_MEMORY_EXTRACT: "0" },
			),
		).toEqual({ enabled: false, extractAfterRun: true });
		expect(
			resolveMemorySettings(
				{},
				{ CLINE_MEMORY: "on", CLINE_MEMORY_EXTRACT: "0" },
			),
		).toEqual({ enabled: true, extractAfterRun: false });
		expect(resolveMemorySettings({}, { CLINE_MEMORY: "maybe" }).enabled).toBe(
			false,
		);
	});

	it("folds a host's env over its own values", () => {
		expect(applyMemoryEnv({ enabled: true }, { CLINE_MEMORY: "off" })).toEqual({
			enabled: false,
			extractAfterRun: undefined,
		});
		expect(applyMemoryEnv({ enabled: true }, {})).toEqual({
			enabled: true,
			extractAfterRun: undefined,
		});
	});
});
