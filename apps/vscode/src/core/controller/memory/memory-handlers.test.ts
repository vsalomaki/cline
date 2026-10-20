import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { MemoryStore, resolveMemoryLocation } from "@cline/core"
import { EmptyRequest } from "@shared/proto/cline/common"
import { MemoryRequest } from "@shared/proto/cline/memory"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from ".."
import { deleteMemory } from "./deleteMemory"
import { listMemories } from "./listMemories"
import { openMemory } from "./openMemory"
import { openMemoryIndex } from "./openMemoryIndex"

const mocks = vi.hoisted(() => ({
	openFile: vi.fn(async () => undefined),
	showMessage: vi.fn(),
}))

vi.mock("@/hosts/host-provider", () => ({ HostProvider: { window: { showMessage: mocks.showMessage } } }))
vi.mock("@integrations/misc/open-file", () => ({ openFile: mocks.openFile }))

const previousDataDir = process.env.CLINE_DATA_DIR
let tempDir: string
let workspace: string
let controller: Controller

async function seed(scope: "project" | "user", name: string, description: string): Promise<void> {
	const store = new MemoryStore(await resolveMemoryLocation(workspace))
	expect(store.write(scope, { name, description, content: `${name} body` }, "save").ok).toBe(true)
}

function useRoot(root: string): void {
	workspace = root
	fs.mkdirSync(root, { recursive: true })
	controller = { getMemoryWorkspaceRoot: async () => root } as unknown as Controller
}

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-memory-handlers-"))
	process.env.CLINE_DATA_DIR = path.join(tempDir, "data")
	useRoot(path.join(tempDir, "workspace"))
	vi.clearAllMocks()
})

afterEach(() => {
	if (previousDataDir === undefined) {
		delete process.env.CLINE_DATA_DIR
	} else {
		process.env.CLINE_DATA_DIR = previousDataDir
	}
	fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("memory handlers", () => {
	it("lists the project memories of the session's root and the user memories", async () => {
		await seed("project", "Build quirk", "Run protos before vitest")
		await seed("user", "Terse", "Short answers")

		const list = await listMemories(controller, EmptyRequest.create())

		expect(list.projectKey).toBe(fs.realpathSync(workspace))
		expect(list.project).toEqual([
			{ scope: "project", slug: "build-quirk", name: "Build quirk", description: "Run protos before vitest" },
		])
		expect(list.user.map((item) => item.slug)).toEqual(["terse"])
	})

	it("lists and deletes project memories of the no-folder chat workspace", async () => {
		useRoot(path.join(tempDir, "data", "workspaces", "chat"))
		await seed("project", "Build quirk", "Run protos before vitest")
		await seed("project", "Flaky test", "Retry once")

		expect((await listMemories(controller, EmptyRequest.create())).project).toHaveLength(2)
		const list = await deleteMemory(controller, MemoryRequest.create({ scope: "project", name: "build-quirk" }))

		expect(list.project.map((item) => item.slug)).toEqual(["flaky-test"])
	})

	it("opens a memory by its name and warns when it is gone", async () => {
		await seed("user", "Terse", "Short answers")

		await openMemory(controller, MemoryRequest.create({ scope: "user", name: "Terse" }))
		await openMemory(controller, MemoryRequest.create({ scope: "user", name: "Missing" }))

		expect(mocks.openFile).toHaveBeenCalledWith(path.join(tempDir, "data", "memory", "terse.md"))
		expect(mocks.openFile).toHaveBeenCalledTimes(1)
		expect(mocks.showMessage).toHaveBeenCalledTimes(1)
	})

	it("opens a scope's index, or says there are no memories yet", async () => {
		await seed("user", "Terse", "Short answers")

		await openMemoryIndex(controller, MemoryRequest.create({ scope: "user" }))
		await openMemoryIndex(controller, MemoryRequest.create({ scope: "project" }))

		expect(mocks.openFile).toHaveBeenCalledWith(path.join(tempDir, "data", "memory", "MEMORY.md"))
		expect(mocks.openFile).toHaveBeenCalledTimes(1)
		expect(mocks.showMessage).toHaveBeenCalledWith(expect.objectContaining({ message: "No project memories yet." }))
	})
})
