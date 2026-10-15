/**
 * Limits on how long the run_commands tool waits for a command, one per
 * terminal execution mode. They behave differently, so they are separate
 * settings:
 *
 *   - Background Exec: the command is killed when the timeout expires.
 *   - VS Code Terminal: Cline stops waiting and proceeds, leaving the command
 *     running in the terminal (VS Code has no API to kill it).
 *
 * Both are stored in milliseconds. An unset value keeps the default below.
 */

/** Matches the SDK shell executor's own default (createShellExecutor). */
export const DEFAULT_BACKGROUND_COMMAND_TIMEOUT_MS = 30_000

export const DEFAULT_FOREGROUND_COMMAND_AUTO_PROCEED_MS = 300_000

export const MIN_COMMAND_TIMEOUT_MS = 1_000

/** 24 hours; also keeps the value well inside the proto's int32 range. */
export const MAX_COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1000

/**
 * Normalizes a requested command timeout. Returns undefined (use the default)
 * for a missing, non-finite or non-positive value; otherwise rounds and clamps
 * it to [MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS].
 */
export function normalizeCommandTimeoutMs(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		return undefined
	}
	return Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(MIN_COMMAND_TIMEOUT_MS, Math.round(value)))
}
