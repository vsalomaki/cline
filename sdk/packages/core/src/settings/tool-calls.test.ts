import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_PARALLEL_TOOL_CALLS,
	getToolCallEnvSources,
	resolveToolCallSettings,
} from "./tool-calls";

describe("resolveToolCallSettings", () => {
	it("defaults to parallel calls with the default cap", () => {
		expect(resolveToolCallSettings({}, {})).toEqual({
			maxParallelToolCalls: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
			parallelToolCalls: true,
			readBeforeWrite: true,
			revertDetection: true,
			reviewBeforeFinish: true,
			nestedSubagents: false,
		});
	});

	it("uses session config when no env var is set", () => {
		expect(
			resolveToolCallSettings(
				{
					maxParallelToolCalls: 1,
					parallelToolCalls: false,
					readBeforeWrite: false,
					revertDetection: false,
					reviewBeforeFinish: false,
					nestedSubagents: true,
				},
				{},
			),
		).toEqual({
			maxParallelToolCalls: 1,
			parallelToolCalls: false,
			readBeforeWrite: false,
			revertDetection: false,
			reviewBeforeFinish: false,
			nestedSubagents: true,
		});
	});

	it("lets env vars override session config", () => {
		const env = {
			CLINE_MAX_PARALLEL_TOOL_CALLS: "8",
			CLINE_PARALLEL_TOOL_CALLS: "off",
			CLINE_READ_BEFORE_WRITE: "false",
			CLINE_REVERT_DETECTION: "off",
			CLINE_REVIEW_BEFORE_FINISH: "0",
			CLINE_NESTED_SUBAGENTS: "on",
		};
		expect(
			resolveToolCallSettings(
				{ maxParallelToolCalls: 2, parallelToolCalls: true },
				env,
			),
		).toEqual({
			maxParallelToolCalls: 8,
			parallelToolCalls: false,
			readBeforeWrite: false,
			revertDetection: false,
			reviewBeforeFinish: false,
			nestedSubagents: true,
		});
		expect(getToolCallEnvSources(env)).toEqual({
			maxParallelToolCalls: "CLINE_MAX_PARALLEL_TOOL_CALLS",
			parallelToolCalls: "CLINE_PARALLEL_TOOL_CALLS",
			readBeforeWrite: "CLINE_READ_BEFORE_WRITE",
			revertDetection: "CLINE_REVERT_DETECTION",
			reviewBeforeFinish: "CLINE_REVIEW_BEFORE_FINISH",
			nestedSubagents: "CLINE_NESTED_SUBAGENTS",
		});
	});

	it("ignores invalid values", () => {
		const env = {
			CLINE_MAX_PARALLEL_TOOL_CALLS: "0",
			CLINE_PARALLEL_TOOL_CALLS: "maybe",
		};
		expect(resolveToolCallSettings({ maxParallelToolCalls: -3 }, env)).toEqual({
			maxParallelToolCalls: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
			parallelToolCalls: true,
			readBeforeWrite: true,
			revertDetection: true,
			reviewBeforeFinish: true,
			nestedSubagents: false,
		});
		expect(getToolCallEnvSources(env)).toEqual({});
	});
});
