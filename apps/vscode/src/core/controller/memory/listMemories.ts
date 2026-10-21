import type { EmptyRequest } from "@shared/proto/cline/common"
import type { MemoryList } from "@shared/proto/cline/memory"
import type { Controller } from ".."
import { buildMemoryList, openWorkspaceMemory } from "./memory-workspace"

export async function listMemories(controller: Controller, _request: EmptyRequest): Promise<MemoryList> {
	return buildMemoryList(await openWorkspaceMemory(controller))
}
