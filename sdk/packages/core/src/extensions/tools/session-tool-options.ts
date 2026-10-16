import { resolveCodeIntelligenceSettings } from "../../settings/code-intelligence";
import { resolveContextLimits } from "../../settings/context-limits";
import type { CoreSessionConfig } from "../../types/config";
import type { CreateBuiltinToolsOptions } from "./index";

export type SessionToolOptions = Pick<
	CreateBuiltinToolsOptions,
	| "limits"
	| "fileReadTimeoutMs"
	| "searchTimeoutMs"
	| "webFetchTimeoutMs"
	| "applyPatchTimeoutMs"
	| "editorTimeoutMs"
	| "codeIntelligence"
> & { ripgrepTimeoutMs?: number };

/** The limits, timeouts and code intelligence a session's builtin tools share; the one place the code_intelligence tool is switched off. */
export function resolveSessionToolOptions(
	config: Pick<
		CoreSessionConfig,
		| "contextLimits"
		| "toolTimeouts"
		| "codeIntelligence"
		| "codeIntelligenceTool"
	>,
): SessionToolOptions {
	return {
		...config.toolTimeouts,
		limits: resolveContextLimits(config.contextLimits ?? {}).tool,
		...(config.codeIntelligence &&
		resolveCodeIntelligenceSettings(config).codeIntelligenceTool
			? { codeIntelligence: config.codeIntelligence }
			: {}),
	};
}

/**
 * Spreads session options into `createBuiltinTools` input. The ripgrep and
 * web-fetch timeouts also go to the executors, which enforce their own.
 */
export function applySessionToolOptions(
	options: CreateBuiltinToolsOptions,
	sessionOptions: SessionToolOptions | undefined,
): CreateBuiltinToolsOptions {
	if (!sessionOptions) {
		return options;
	}
	const { ripgrepTimeoutMs, ...toolOptions } = sessionOptions;
	const webFetchTimeoutMs =
		options.webFetchTimeoutMs ?? toolOptions.webFetchTimeoutMs;
	const executorOptions = { ...options.executorOptions };
	if (ripgrepTimeoutMs !== undefined) {
		executorOptions.search = {
			ripgrepTimeoutMs,
			...options.executorOptions?.search,
		};
	}
	if (webFetchTimeoutMs !== undefined) {
		executorOptions.webFetch = {
			timeoutMs: webFetchTimeoutMs,
			...options.executorOptions?.webFetch,
		};
	}
	return {
		...toolOptions,
		...options,
		executorOptions:
			Object.keys(executorOptions).length > 0
				? executorOptions
				: options.executorOptions,
	};
}
