/**
 * How the tool calls in one model response are requested and run. Resolved
 * from env over session config over defaults, like the context limits.
 */

export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 4;

export const TOOL_CALL_ENV = {
	maxParallelToolCalls: "CLINE_MAX_PARALLEL_TOOL_CALLS",
	parallelToolCalls: "CLINE_PARALLEL_TOOL_CALLS",
	readBeforeWrite: "CLINE_READ_BEFORE_WRITE",
	reviewBeforeFinish: "CLINE_REVIEW_BEFORE_FINISH",
} as const;

export interface ToolCallSettings {
	maxParallelToolCalls: number;
	parallelToolCalls: boolean;
	/** Refuse edits to existing files that were not read, or changed since. */
	readBeforeWrite: boolean;
	/** Ask the agent to review a run that changed files before its final report. */
	reviewBeforeFinish: boolean;
}

function parsePositiveIntEnv(raw: string | undefined): number | undefined {
	const trimmed = raw?.trim();
	if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
	const value = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function parseBooleanEnv(raw: string | undefined): boolean | undefined {
	switch (raw?.trim().toLowerCase()) {
		case "1":
		case "true":
		case "on":
			return true;
		case "0":
		case "false":
		case "off":
			return false;
		default:
			return undefined;
	}
}

export function resolveToolCallSettings(
	config: Partial<ToolCallSettings> = {},
	env: Record<string, string | undefined> = process.env,
): ToolCallSettings {
	const configuredMax =
		typeof config.maxParallelToolCalls === "number" &&
		Number.isSafeInteger(config.maxParallelToolCalls) &&
		config.maxParallelToolCalls > 0
			? config.maxParallelToolCalls
			: undefined;
	return {
		maxParallelToolCalls:
			parsePositiveIntEnv(env[TOOL_CALL_ENV.maxParallelToolCalls]) ??
			configuredMax ??
			DEFAULT_MAX_PARALLEL_TOOL_CALLS,
		parallelToolCalls:
			parseBooleanEnv(env[TOOL_CALL_ENV.parallelToolCalls]) ??
			config.parallelToolCalls ??
			true,
		readBeforeWrite:
			parseBooleanEnv(env[TOOL_CALL_ENV.readBeforeWrite]) ??
			config.readBeforeWrite ??
			true,
		reviewBeforeFinish:
			parseBooleanEnv(env[TOOL_CALL_ENV.reviewBeforeFinish]) ??
			config.reviewBeforeFinish ??
			true,
	};
}

/** The env var currently setting each tool-call setting, when one is. */
export function getToolCallEnvSources(
	env: Record<string, string | undefined> = process.env,
): Partial<Record<keyof ToolCallSettings, string>> {
	const sources: Partial<Record<keyof ToolCallSettings, string>> = {};
	if (
		parsePositiveIntEnv(env[TOOL_CALL_ENV.maxParallelToolCalls]) !== undefined
	) {
		sources.maxParallelToolCalls = TOOL_CALL_ENV.maxParallelToolCalls;
	}
	if (parseBooleanEnv(env[TOOL_CALL_ENV.parallelToolCalls]) !== undefined) {
		sources.parallelToolCalls = TOOL_CALL_ENV.parallelToolCalls;
	}
	if (parseBooleanEnv(env[TOOL_CALL_ENV.readBeforeWrite]) !== undefined) {
		sources.readBeforeWrite = TOOL_CALL_ENV.readBeforeWrite;
	}
	if (parseBooleanEnv(env[TOOL_CALL_ENV.reviewBeforeFinish]) !== undefined) {
		sources.reviewBeforeFinish = TOOL_CALL_ENV.reviewBeforeFinish;
	}
	return sources;
}
