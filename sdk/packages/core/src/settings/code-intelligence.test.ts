import { describe, expect, it } from "vitest";
import {
	DEFAULT_PROBLEMS_TIMEOUT_MS,
	getCodeIntelligenceEnvSources,
	resolveCodeIntelligenceSettings,
} from "./code-intelligence";

describe("resolveCodeIntelligenceSettings", () => {
	it("uses defaults when nothing is configured", () => {
		expect(resolveCodeIntelligenceSettings({}, {})).toEqual({
			languageServers: true,
			codeIntelligenceTool: true,
			problemsAfterEdit: "errors",
			problemsTimeoutMs: DEFAULT_PROBLEMS_TIMEOUT_MS,
		});
	});

	it("uses session config when no env var is set", () => {
		expect(
			resolveCodeIntelligenceSettings(
				{
					languageServers: { enabled: false },
					codeIntelligenceTool: false,
					problemsAfterEdit: "warnings",
					problemsTimeoutMs: 0,
				},
				{},
			),
		).toEqual({
			languageServers: false,
			codeIntelligenceTool: false,
			problemsAfterEdit: "warnings",
			problemsTimeoutMs: 0,
		});
	});

	it("lets env vars override session config", () => {
		const env = {
			CLINE_LANGUAGE_SERVERS: "0",
			CLINE_CODE_INTELLIGENCE_TOOL: "0",
			CLINE_PROBLEMS_AFTER_EDIT: "OFF",
			CLINE_PROBLEMS_TIMEOUT_MS: "750",
		};
		expect(
			resolveCodeIntelligenceSettings(
				{
					languageServers: { enabled: true },
					codeIntelligenceTool: true,
					problemsAfterEdit: "warnings",
					problemsTimeoutMs: 5000,
				},
				env,
			),
		).toEqual({
			languageServers: false,
			codeIntelligenceTool: false,
			problemsAfterEdit: "off",
			problemsTimeoutMs: 750,
		});
		expect(getCodeIntelligenceEnvSources(env)).toEqual({
			languageServers: "CLINE_LANGUAGE_SERVERS",
			codeIntelligenceTool: "CLINE_CODE_INTELLIGENCE_TOOL",
			problemsAfterEdit: "CLINE_PROBLEMS_AFTER_EDIT",
			problemsTimeoutMs: "CLINE_PROBLEMS_TIMEOUT_MS",
		});
	});

	it("ignores values that are not valid", () => {
		const env = {
			CLINE_LANGUAGE_SERVERS: "maybe",
			CLINE_CODE_INTELLIGENCE_TOOL: "maybe",
			CLINE_PROBLEMS_AFTER_EDIT: "all",
			CLINE_PROBLEMS_TIMEOUT_MS: "-5",
		};
		expect(
			resolveCodeIntelligenceSettings(
				{ problemsAfterEdit: "loud", problemsTimeoutMs: -1 },
				env,
			),
		).toEqual({
			languageServers: true,
			codeIntelligenceTool: true,
			problemsAfterEdit: "errors",
			problemsTimeoutMs: DEFAULT_PROBLEMS_TIMEOUT_MS,
		});
		expect(getCodeIntelligenceEnvSources(env)).toEqual({});
	});
});
