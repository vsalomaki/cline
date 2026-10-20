import { openFile } from "@integrations/misc/open-file"
import { Empty } from "@shared/proto/cline/common"
import type { MemoryRequest } from "@shared/proto/cline/memory"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import type { Controller } from ".."
import { memoryFilePath, openWorkspaceMemory, parseMemoryScope } from "./memory-workspace"

export async function openMemory(controller: Controller, request: MemoryRequest): Promise<Empty> {
	const store = await openWorkspaceMemory(controller)
	const scope = parseMemoryScope(request.scope)
	const entry = scope && request.name ? store.get(scope, request.name) : undefined
	if (entry) {
		await openFile(memoryFilePath(store, entry))
	} else {
		HostProvider.window.showMessage({
			type: ShowMessageType.WARNING,
			message: `No ${request.scope} memory named "${request.name}" in this workspace.`,
		})
	}
	return Empty.create()
}
