import type { MemoryList, MemoryRequest } from "@shared/proto/cline/memory"
import type { Controller } from ".."
import { buildMemoryList, openWorkspaceMemory, parseMemoryScope } from "./memory-workspace"

export async function deleteMemory(controller: Controller, request: MemoryRequest): Promise<MemoryList> {
	const store = await openWorkspaceMemory(controller)
	const scope = parseMemoryScope(request.scope)
	if (scope && request.name) {
		store.delete(scope, request.name)
	}
	return buildMemoryList(store)
}
