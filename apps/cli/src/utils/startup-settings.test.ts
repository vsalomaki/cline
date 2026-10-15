import type { GlobalSettings } from "@cline/core";
import { describe, expect, it } from "vitest";
import {
	resolveStartupCompactionMode,
	resolveStartupMaxParallelToolCalls,
	resolveStartupMode,
	resolveStartupParallelToolCalls,
	resolveStartupToolAutoApprove,
} from "./startup-settings";

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
	return {
		autoUpdateEnabled: true,
		telemetryOptOut: false,
		...overrides,
	};
}

describe("resolveStartupMode", () => {
	it("uses the parsed default when nothing is persisted", () => {
		expect(
			resolveStartupMode(
				{ mode: "act", modeExplicitlySet: false },
				makeSettings(),
			),
		).toBe("act");
	});

	it("restores the persisted plan/act mode when no mode flag is provided", () => {
		expect(
			resolveStartupMode(
				{ mode: "act", modeExplicitlySet: false },
				makeSettings({ planActMode: "plan" }),
			),
		).toBe("plan");
	});

	it("prefers an explicit mode flag over the persisted mode", () => {
		expect(
			resolveStartupMode(
				{ mode: "act", modeExplicitlySet: true },
				makeSettings({ planActMode: "plan" }),
			),
		).toBe("act");
		expect(
			resolveStartupMode(
				{ mode: "yolo", modeExplicitlySet: true },
				makeSettings({ planActMode: "plan" }),
			),
		).toBe("yolo");
	});
});

describe("resolveStartupToolAutoApprove", () => {
	it("falls back to the built-in default when nothing is persisted", () => {
		expect(resolveStartupToolAutoApprove({}, makeSettings(), true)).toBe(true);
	});

	it("restores the persisted auto-approve setting", () => {
		expect(
			resolveStartupToolAutoApprove(
				{},
				makeSettings({ toolAutoApprove: false }),
				true,
			),
		).toBe(false);
	});

	it("prefers an explicit --auto-approve flag over the persisted setting", () => {
		expect(
			resolveStartupToolAutoApprove(
				{ autoApproveOverride: true },
				makeSettings({ toolAutoApprove: false }),
				true,
			),
		).toBe(true);
		expect(
			resolveStartupToolAutoApprove(
				{ autoApproveOverride: false },
				makeSettings({ toolAutoApprove: true }),
				true,
			),
		).toBe(false);
	});
});

describe("resolveStartupCompactionMode", () => {
	it("returns undefined so Core's default applies when nothing is persisted", () => {
		expect(resolveStartupCompactionMode({}, makeSettings())).toBeUndefined();
	});

	it("restores the persisted strategy", () => {
		expect(
			resolveStartupCompactionMode(
				{},
				makeSettings({ compactionEnabled: true, compactionStrategy: "basic" }),
			),
		).toBe("basic");
	});

	it("restores the off state even when a strategy is retained on disk", () => {
		expect(
			resolveStartupCompactionMode(
				{},
				makeSettings({ compactionEnabled: false, compactionStrategy: "basic" }),
			),
		).toBe("off");
	});

	it("prefers an explicit --compaction flag over the persisted mode", () => {
		expect(
			resolveStartupCompactionMode(
				{ compactionMode: "agentic" },
				makeSettings({ compactionEnabled: false }),
			),
		).toBe("agentic");
	});
});

describe("resolveStartupMaxParallelToolCalls", () => {
	it("returns undefined so Core's env/default applies when nothing is set", () => {
		expect(
			resolveStartupMaxParallelToolCalls({}, makeSettings()),
		).toBeUndefined();
	});

	it("restores the persisted value", () => {
		expect(
			resolveStartupMaxParallelToolCalls(
				{},
				makeSettings({ maxParallelToolCalls: 8 }),
			),
		).toBe(8);
	});

	it("prefers the flag over the persisted value", () => {
		expect(
			resolveStartupMaxParallelToolCalls(
				{ maxParallelToolCalls: 1 },
				makeSettings({ maxParallelToolCalls: 8 }),
			),
		).toBe(1);
	});
});

describe("resolveStartupParallelToolCalls", () => {
	it("returns undefined so Core's env/default applies when nothing is set", () => {
		expect(resolveStartupParallelToolCalls({}, makeSettings())).toBeUndefined();
	});

	it("restores a persisted false", () => {
		expect(
			resolveStartupParallelToolCalls(
				{},
				makeSettings({ parallelToolCalls: false }),
			),
		).toBe(false);
	});

	it("prefers the flag over the persisted value, including false", () => {
		expect(
			resolveStartupParallelToolCalls(
				{ parallelToolCalls: true },
				makeSettings({ parallelToolCalls: false }),
			),
		).toBe(true);
		expect(
			resolveStartupParallelToolCalls(
				{ parallelToolCalls: false },
				makeSettings({ parallelToolCalls: true }),
			),
		).toBe(false);
	});
});
