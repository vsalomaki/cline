import type {
	GlobalSettings,
	LanguageServerSettings,
	ProblemsAfterEditLevel,
} from "@cline/core";
import type { CliAgentMode, CliCompactionMode, ParsedArgs } from "./types";

/**
 * Resolves general settings at CLI startup with the precedence
 * explicit CLI flag -> persisted global setting -> built-in default,
 * so choices made in the TUI /settings panel survive restarts (see
 * https://github.com/cline/cline/issues/12158).
 */

export function resolveStartupMode(
	args: Pick<ParsedArgs, "mode" | "modeExplicitlySet">,
	settings: GlobalSettings,
): CliAgentMode {
	if (args.modeExplicitlySet) {
		return args.mode;
	}
	return settings.planActMode ?? args.mode;
}

export function resolveStartupToolAutoApprove(
	args: Pick<ParsedArgs, "autoApproveOverride">,
	settings: GlobalSettings,
	defaultToolAutoApprove: boolean,
): boolean {
	return (
		args.autoApproveOverride ??
		settings.toolAutoApprove ??
		defaultToolAutoApprove
	);
}

/**
 * Returns undefined when neither a flag nor a persisted value exists, so
 * Core's env/default resolution applies.
 */
export function resolveStartupMaxParallelToolCalls(
	args: Pick<ParsedArgs, "maxParallelToolCalls">,
	settings: GlobalSettings,
): number | undefined {
	return args.maxParallelToolCalls ?? settings.maxParallelToolCalls;
}

export function resolveStartupParallelToolCalls(
	args: Pick<ParsedArgs, "parallelToolCalls">,
	settings: GlobalSettings,
): boolean | undefined {
	return args.parallelToolCalls ?? settings.parallelToolCalls;
}

export function resolveStartupReadBeforeWrite(
	args: Pick<ParsedArgs, "readBeforeWrite">,
	settings: GlobalSettings,
): boolean | undefined {
	return args.readBeforeWrite ?? settings.readBeforeWrite;
}

export function resolveStartupRevertDetection(
	args: Pick<ParsedArgs, "revertDetection">,
	settings: GlobalSettings,
): boolean | undefined {
	return args.revertDetection ?? settings.revertDetection;
}

export function resolveStartupReviewBeforeFinish(
	args: Pick<ParsedArgs, "reviewBeforeFinish">,
	settings: GlobalSettings,
): boolean | undefined {
	return args.reviewBeforeFinish ?? settings.reviewBeforeFinish;
}

export function resolveStartupNestedSubagents(
	args: Pick<ParsedArgs, "nestedSubagents">,
	settings: GlobalSettings,
): boolean | undefined {
	return args.nestedSubagents ?? settings.nestedSubagents;
}

/** The flag only switches the servers on or off; the server list stays the persisted one. */
export function resolveStartupLanguageServers(
	args: Pick<ParsedArgs, "languageServers">,
	settings: GlobalSettings,
): LanguageServerSettings | undefined {
	if (args.languageServers === undefined) {
		return settings.languageServers;
	}
	return { ...settings.languageServers, enabled: args.languageServers };
}

export function resolveStartupCodeIntelligenceTool(
	args: Pick<ParsedArgs, "codeIntelligenceTool">,
	settings: GlobalSettings,
): boolean | undefined {
	return args.codeIntelligenceTool ?? settings.codeIntelligenceTool;
}

export function resolveStartupProblemsAfterEdit(
	args: Pick<ParsedArgs, "problemsAfterEdit">,
	settings: GlobalSettings,
): ProblemsAfterEditLevel | undefined {
	return args.problemsAfterEdit ?? settings.problemsAfterEdit;
}

export function resolveStartupProblemsTimeoutMs(
	args: Pick<ParsedArgs, "problemsTimeoutMs">,
	settings: GlobalSettings,
): number | undefined {
	return args.problemsTimeoutMs ?? settings.problemsTimeoutMs;
}

/**
 * Returns undefined when neither a flag nor a persisted value exists, so
 * callers fall through to Core's compaction default.
 */
export function resolveStartupCompactionMode(
	args: Pick<ParsedArgs, "compactionMode">,
	settings: GlobalSettings,
): CliCompactionMode | undefined {
	if (args.compactionMode) {
		return args.compactionMode;
	}
	if (settings.compactionEnabled === false) {
		return "off";
	}
	return settings.compactionStrategy;
}
