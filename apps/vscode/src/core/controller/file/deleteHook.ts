import { DeleteHookRequest, DeleteHookResponse } from "@shared/proto/cline/file"
import fs from "fs/promises"
import { HostProvider } from "@/hosts/host-provider"
import { HookDiscoveryCache } from "../../hooks/HookDiscoveryCache"
import { resolveRequestedHookFile } from "../../hooks/sdk-hook-files"
import { resolveExistingHookPath, resolveHooksDirectory } from "../../hooks/utils"
import { Controller } from ".."
import { refreshHooks } from "./refreshHooks"

export async function deleteHook(
	controller: Controller,
	request: DeleteHookRequest,
	globalHooksDirOverride?: string,
): Promise<DeleteHookResponse> {
	const { hookName, isGlobal, workspaceName, absolutePath } = request

	let hookPath: string | undefined
	if (absolutePath) {
		const { paths } = await HostProvider.workspace.getWorkspacePaths({})
		hookPath = await resolveRequestedHookFile(absolutePath, paths, globalHooksDirOverride)
	} else {
		const hooksDir = await resolveHooksDirectory(isGlobal, workspaceName, globalHooksDirOverride)
		hookPath = await resolveExistingHookPath(hooksDir, hookName)
		if (!hookPath) {
			throw new Error(`Hook ${hookName} does not exist in ${hooksDir}`)
		}
	}

	// Delete the hook file
	await fs.unlink(hookPath)

	// Invalidate hook discovery cache
	await HookDiscoveryCache.getInstance().invalidateAll()

	// Return updated hooks state
	const hooksToggles = await refreshHooks(controller, undefined, globalHooksDirOverride)
	return DeleteHookResponse.create({ hooksToggles })
}
