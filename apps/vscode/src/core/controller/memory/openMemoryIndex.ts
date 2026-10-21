import { existsSync } from "node:fs"
import path from "node:path"
import { MEMORY_INDEX_FILE } from "@cline/core"
import { openFile } from "@integrations/misc/open-file"
import { Empty } from "@shared/proto/cline/common"
import type { MemoryRequest } from "@shared/proto/cline/memory"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import type { Controller } from ".."
import { openWorkspaceMemory, parseMemoryScope } from "./memory-workspace"

export async function openMemoryIndex(controller: Controller, request: MemoryRequest): Promise<Empty> {
	const scope = parseMemoryScope(request.scope)
	if (!scope) {
		return Empty.create()
	}
	const index = path.join((await openWorkspaceMemory(controller)).dir(scope), MEMORY_INDEX_FILE)
	if (existsSync(index)) {
		await openFile(index)
	} else {
		HostProvider.window.showMessage({ type: ShowMessageType.INFORMATION, message: `No ${scope} memories yet.` })
	}
	return Empty.create()
}
