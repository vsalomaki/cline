import { parseBooleanEnv } from "./tool-calls";

export const MEMORY_ENV = {
	enabled: "CLINE_MEMORY",
	extractAfterRun: "CLINE_MEMORY_EXTRACT",
} as const;

export interface MemorySettings {
	enabled: boolean;
	/** Check a finished run for memories once the session has been idle a while. */
	extractAfterRun: boolean;
}

/** This process's env vars over the given values, for a host to pass on as config. */
export function applyMemoryEnv(
	config: Partial<MemorySettings>,
	env: Record<string, string | undefined> = process.env,
): Partial<MemorySettings> {
	return {
		enabled: parseBooleanEnv(env[MEMORY_ENV.enabled]) ?? config.enabled,
		extractAfterRun:
			parseBooleanEnv(env[MEMORY_ENV.extractAfterRun]) ??
			config.extractAfterRun,
	};
}

/**
 * Config over env: hosts fold their own env into the config first, so a hub
 * daemon's environment never overrides the client that started the session.
 */
export function resolveMemorySettings(
	config: Partial<MemorySettings> = {},
	env: Record<string, string | undefined> = process.env,
): MemorySettings {
	return {
		enabled:
			config.enabled ?? parseBooleanEnv(env[MEMORY_ENV.enabled]) ?? false,
		extractAfterRun:
			config.extractAfterRun ??
			parseBooleanEnv(env[MEMORY_ENV.extractAfterRun]) ??
			true,
	};
}
