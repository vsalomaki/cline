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
> & { ripgrepTimeoutMs?: number };

/** The limit and timeout options a session's builtin tools share. */
export function resolveSessionToolOptions(
	config: Pick<CoreSessionConfig, "contextLimits" | "toolTimeouts">,
): SessionToolOptions {
	return {
		...config.toolTimeouts,
		limits: resolveContextLimits(config.contextLimits ?? {}).tool,
	};
}

/**
 * Spreads session options into `createBuiltinTools` input, keeping the
 * ripgrep timeout with the search executor it configures.
 */
export function applySessionToolOptions(
	options: CreateBuiltinToolsOptions,
	sessionOptions: SessionToolOptions | undefined,
): CreateBuiltinToolsOptions {
	if (!sessionOptions) {
		return options;
	}
	const { ripgrepTimeoutMs, ...toolOptions } = sessionOptions;
	return {
		...toolOptions,
		...options,
		executorOptions:
			ripgrepTimeoutMs === undefined
				? options.executorOptions
				: {
						...options.executorOptions,
						search: {
							ripgrepTimeoutMs,
							...options.executorOptions?.search,
						},
					},
	};
}
