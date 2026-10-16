/**
 * Language-server settings, resolved from env over session config over
 * defaults, like the tool-call settings.
 */

import type {
	LanguageServerSettings,
	ProblemsAfterEditLevel,
} from "../extensions/tools/code-intelligence/types";
import { parseBooleanEnv } from "./tool-calls";

export const DEFAULT_PROBLEMS_AFTER_EDIT: ProblemsAfterEditLevel = "errors";
export const DEFAULT_PROBLEMS_TIMEOUT_MS = 3000;

export const CODE_INTELLIGENCE_ENV = {
	languageServers: "CLINE_LANGUAGE_SERVERS",
	codeIntelligenceTool: "CLINE_CODE_INTELLIGENCE_TOOL",
	problemsAfterEdit: "CLINE_PROBLEMS_AFTER_EDIT",
	problemsTimeoutMs: "CLINE_PROBLEMS_TIMEOUT_MS",
} as const;

export interface CodeIntelligenceSettings {
	/** Whether the SDK may start its own language servers. */
	languageServers: boolean;
	/** Whether the code_intelligence tool is offered to the model. */
	codeIntelligenceTool: boolean;
	problemsAfterEdit: ProblemsAfterEditLevel;
	problemsTimeoutMs: number;
}

export interface CodeIntelligenceSettingsInput {
	languageServers?: LanguageServerSettings;
	codeIntelligenceTool?: boolean;
	problemsAfterEdit?: string;
	problemsTimeoutMs?: number;
}

export function parseProblemsAfterEditLevel(
	raw: string | undefined,
): ProblemsAfterEditLevel | undefined {
	const value = raw?.trim().toLowerCase();
	return value === "off" || value === "errors" || value === "warnings"
		? value
		: undefined;
}

function parseTimeoutMs(raw: string | undefined): number | undefined {
	const trimmed = raw?.trim();
	if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
	const value = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(value) ? value : undefined;
}

function validTimeoutMs(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

export function resolveCodeIntelligenceSettings(
	config: CodeIntelligenceSettingsInput = {},
	env: Record<string, string | undefined> = process.env,
): CodeIntelligenceSettings {
	return {
		languageServers:
			parseBooleanEnv(env[CODE_INTELLIGENCE_ENV.languageServers]) ??
			config.languageServers?.enabled ??
			true,
		codeIntelligenceTool:
			parseBooleanEnv(env[CODE_INTELLIGENCE_ENV.codeIntelligenceTool]) ??
			config.codeIntelligenceTool ??
			true,
		problemsAfterEdit:
			parseProblemsAfterEditLevel(
				env[CODE_INTELLIGENCE_ENV.problemsAfterEdit],
			) ??
			parseProblemsAfterEditLevel(config.problemsAfterEdit) ??
			DEFAULT_PROBLEMS_AFTER_EDIT,
		problemsTimeoutMs:
			parseTimeoutMs(env[CODE_INTELLIGENCE_ENV.problemsTimeoutMs]) ??
			validTimeoutMs(config.problemsTimeoutMs) ??
			DEFAULT_PROBLEMS_TIMEOUT_MS,
	};
}

/** The env var currently setting each code-intelligence setting, when one is. */
export function getCodeIntelligenceEnvSources(
	env: Record<string, string | undefined> = process.env,
): Partial<Record<keyof CodeIntelligenceSettings, string>> {
	const sources: Partial<Record<keyof CodeIntelligenceSettings, string>> = {};
	if (
		parseBooleanEnv(env[CODE_INTELLIGENCE_ENV.languageServers]) !== undefined
	) {
		sources.languageServers = CODE_INTELLIGENCE_ENV.languageServers;
	}
	if (
		parseBooleanEnv(env[CODE_INTELLIGENCE_ENV.codeIntelligenceTool]) !==
		undefined
	) {
		sources.codeIntelligenceTool = CODE_INTELLIGENCE_ENV.codeIntelligenceTool;
	}
	if (
		parseProblemsAfterEditLevel(
			env[CODE_INTELLIGENCE_ENV.problemsAfterEdit],
		) !== undefined
	) {
		sources.problemsAfterEdit = CODE_INTELLIGENCE_ENV.problemsAfterEdit;
	}
	if (
		parseTimeoutMs(env[CODE_INTELLIGENCE_ENV.problemsTimeoutMs]) !== undefined
	) {
		sources.problemsTimeoutMs = CODE_INTELLIGENCE_ENV.problemsTimeoutMs;
	}
	return sources;
}
