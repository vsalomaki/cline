export const CLINE_REMOTE_SERVICES_ENV = "CLINE_REMOTE_SERVICES";

/**
 * Fork builds turn off telemetry and Cline's remote services unless built with
 * `CLINE_REMOTE_SERVICES=on`. Bundlers replace the lookup with a literal, so the
 * end user's environment cannot turn them back on.
 */
export function isRemoteServicesDisabled(): boolean {
	return (
		typeof process === "undefined" ||
		!process.env ||
		process.env.CLINE_REMOTE_SERVICES !== "on"
	);
}
