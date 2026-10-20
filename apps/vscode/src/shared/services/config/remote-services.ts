// Mirrors @cline/shared's isRemoteServicesDisabled for the webview, which doesn't import @cline/shared.
export function isRemoteServicesDisabled(): boolean {
	return process.env.CLINE_REMOTE_SERVICES !== "on"
}
