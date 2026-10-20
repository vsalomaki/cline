import path from "node:path"
import { type MemoryEntry, type MemoryScope, MemoryStore, resolveMemoryLocation } from "@cline/core"
import { MemoryItem, MemoryList } from "@shared/proto/cline/memory"
import type { Controller } from ".."

/** The memory store of the workspace the active task's memory tool uses. */
export async function openWorkspaceMemory(controller: Controller): Promise<MemoryStore> {
	return new MemoryStore(await resolveMemoryLocation(await controller.getMemoryWorkspaceRoot()))
}

export function parseMemoryScope(value: string): MemoryScope | undefined {
	return value === "project" || value === "user" ? value : undefined
}

export function memoryFilePath(store: MemoryStore, entry: Pick<MemoryEntry, "scope" | "slug">): string {
	return path.join(store.dir(entry.scope), `${entry.slug}.md`)
}

export function buildMemoryList(store: MemoryStore): MemoryList {
	const toItem = (entry: MemoryEntry) =>
		MemoryItem.create({ scope: entry.scope, slug: entry.slug, name: entry.name, description: entry.description })
	return MemoryList.create({
		project: store.list("project").map(toItem),
		user: store.list("user").map(toItem),
		projectKey: store.location.projectKey,
	})
}
