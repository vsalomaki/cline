import { ToggleHookRequest, ToggleHookResponse } from "@shared/proto/cline/file"
import fs from "fs/promises"
import path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { HookDiscoveryCache } from "../../hooks/HookDiscoveryCache"
import { CLAUDE_HOOKS_FILE, resolveRequestedHookFile } from "../../hooks/sdk-hook-files"
import { resolveExistingHookPath, resolveHooksDirectory } from "../../hooks/utils"
import { Controller } from ".."
import { refreshHooks } from "./refreshHooks"

export async function toggleHook(
	controller: Controller,
	request: ToggleHookRequest,
	globalHooksDirOverride?: string,
): Promise<ToggleHookResponse> {
	const { hookName, isGlobal, enabled, workspaceName, absolutePath } = request

	let hookPath: string | undefined
	if (absolutePath) {
		const { paths } = await HostProvider.workspace.getWorkspacePaths({})
		hookPath = await resolveRequestedHookFile(absolutePath, paths, globalHooksDirOverride)
		if (path.basename(hookPath) === CLAUDE_HOOKS_FILE) {
			throw new Error(`${CLAUDE_HOOKS_FILE} cannot be toggled; edit or delete it instead`)
		}
	} else {
		const hooksDir = await resolveHooksDirectory(isGlobal, workspaceName, globalHooksDirOverride)
		hookPath = await resolveExistingHookPath(hooksDir, hookName)
		if (!hookPath) {
			throw new Error(`Hook ${hookName} does not exist in ${hooksDir}`)
		}
	}

	// On Windows, we can't use chmod, so we just return the current state
	// without modifying the file. The frontend will disable the toggle.
	// TODO(PR-9552 follow-up): Replace this temporary behavior with a
	// JSON-backed cross-platform enabled/disabled hook state.
	if (process.platform !== "win32") {
		// Toggle executable bit (Unix-like systems only)
		// TODO(PR-9552 follow-up): Revisit chmod-driven enablement semantics
		// once cross-platform JSON-backed state is implemented.
		await fs.chmod(hookPath, enabled ? 0o755 : 0o644)
	}

	// Invalidate cache
	await HookDiscoveryCache.getInstance().invalidateAll()

	// Return updated state
	const hooksToggles = await refreshHooks(controller, undefined, globalHooksDirOverride)
	return ToggleHookResponse.create({ hooksToggles })
}
