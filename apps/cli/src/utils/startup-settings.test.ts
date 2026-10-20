import type { GlobalSettings } from "@cline/core";
import { describe, expect, it } from "vitest";
import {
	resolveStartupCodeIntelligenceTool,
	resolveStartupCompactionMode,
	resolveStartupLanguageServers,
	resolveStartupMaxParallelToolCalls,
	resolveStartupMode,
	resolveStartupNestedSubagents,
	resolveStartupParallelToolCalls,
	resolveStartupProblemsAfterEdit,
	resolveStartupProblemsTimeoutMs,
	resolveStartupReadBeforeWrite,
	resolveStartupRevertDetection,
	resolveStartupReviewBeforeFinish,
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

describe("resolveStartupReadBeforeWrite", () => {
	it("prefers the flag over the persisted value and leaves unset to Core", () => {
		expect(resolveStartupReadBeforeWrite({}, makeSettings())).toBeUndefined();
		expect(
			resolveStartupReadBeforeWrite(
				{},
				makeSettings({ readBeforeWrite: false }),
			),
		).toBe(false);
		expect(
			resolveStartupReadBeforeWrite(
				{ readBeforeWrite: true },
				makeSettings({ readBeforeWrite: false }),
			),
		).toBe(true);
	});
});

describe("resolveStartupRevertDetection", () => {
	it("prefers the flag over the persisted value and leaves unset to Core", () => {
		expect(resolveStartupRevertDetection({}, makeSettings())).toBeUndefined();
		expect(
			resolveStartupRevertDetection(
				{},
				makeSettings({ revertDetection: false }),
			),
		).toBe(false);
		expect(
			resolveStartupRevertDetection(
				{ revertDetection: true },
				makeSettings({ revertDetection: false }),
			),
		).toBe(true);
	});
});

describe("resolveStartupReviewBeforeFinish", () => {
	it("prefers the flag over the persisted value and leaves unset to Core", () => {
		expect(
			resolveStartupReviewBeforeFinish({}, makeSettings()),
		).toBeUndefined();
		expect(
			resolveStartupReviewBeforeFinish(
				{ reviewBeforeFinish: false },
				makeSettings({ reviewBeforeFinish: true }),
			),
		).toBe(false);
		expect(
			resolveStartupReviewBeforeFinish(
				{},
				makeSettings({ reviewBeforeFinish: false }),
			),
		).toBe(false);
	});
});

describe("language-server startup settings", () => {
	const servers = {
		go: { command: ["gopls"], extensions: [".go"] },
	};

	it("keeps the persisted servers and lets the flag switch them on or off", () => {
		expect(resolveStartupLanguageServers({}, makeSettings())).toBeUndefined();
		expect(
			resolveStartupLanguageServers(
				{},
				makeSettings({ languageServers: { servers } }),
			),
		).toEqual({ servers });
		expect(
			resolveStartupLanguageServers(
				{ languageServers: false },
				makeSettings({ languageServers: { enabled: true, servers } }),
			),
		).toEqual({ enabled: false, servers });
	});

	it("prefers the flag over the persisted code-intelligence tool switch", () => {
		expect(
			resolveStartupCodeIntelligenceTool({}, makeSettings()),
		).toBeUndefined();
		expect(
			resolveStartupCodeIntelligenceTool(
				{},
				makeSettings({ codeIntelligenceTool: false }),
			),
		).toBe(false);
		expect(
			resolveStartupCodeIntelligenceTool(
				{ codeIntelligenceTool: true },
				makeSettings({ codeIntelligenceTool: false }),
			),
		).toBe(true);
	});

	it("prefers the flags over the persisted problem settings", () => {
		expect(resolveStartupProblemsAfterEdit({}, makeSettings())).toBeUndefined();
		expect(
			resolveStartupProblemsAfterEdit(
				{},
				makeSettings({ problemsAfterEdit: "warnings" }),
			),
		).toBe("warnings");
		expect(
			resolveStartupProblemsAfterEdit(
				{ problemsAfterEdit: "off" },
				makeSettings({ problemsAfterEdit: "warnings" }),
			),
		).toBe("off");
		expect(
			resolveStartupProblemsTimeoutMs(
				{ problemsTimeoutMs: 0 },
				makeSettings({ problemsTimeoutMs: 5000 }),
			),
		).toBe(0);
		expect(
			resolveStartupProblemsTimeoutMs(
				{},
				makeSettings({ problemsTimeoutMs: 5000 }),
			),
		).toBe(5000);
	});
});

describe("resolveStartupNestedSubagents", () => {
	it("prefers the flag over the persisted value and leaves unset to Core", () => {
		expect(resolveStartupNestedSubagents({}, makeSettings())).toBeUndefined();
		expect(
			resolveStartupNestedSubagents(
				{ nestedSubagents: false },
				makeSettings({ nestedSubagents: true }),
			),
		).toBe(false);
		expect(
			resolveStartupNestedSubagents(
				{},
				makeSettings({ nestedSubagents: true }),
			),
		).toBe(true);
	});
});
