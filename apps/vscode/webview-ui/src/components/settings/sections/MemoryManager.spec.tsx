import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import MemoryManager from "./MemoryManager"

const mocks = vi.hoisted(() => ({
	listMemories: vi.fn(),
	deleteMemory: vi.fn(),
	openMemory: vi.fn(),
	openMemoryIndex: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({ MemoryServiceClient: mocks }))

const item = (scope: string, slug: string, name: string, description: string) => ({ scope, slug, name, description })

const fullList = {
	projectKey: "/repo/.git",
	project: [item("project", "build-quirk", "Build quirk", "Run protos before vitest")],
	user: [item("user", "terse", "Terse", "Short answers")],
}

async function openManager() {
	render(<MemoryManager />)
	fireEvent.click(screen.getByRole("button", { name: "Manage memories" }))
	await screen.findByText("Build quirk")
}

describe("MemoryManager", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.listMemories.mockResolvedValue(fullList)
		mocks.openMemory.mockResolvedValue({})
		mocks.openMemoryIndex.mockResolvedValue({})
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("lists project and user memories once opened", async () => {
		render(<MemoryManager />)
		expect(mocks.listMemories).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "Manage memories" }))

		expect(await screen.findByText("Build quirk")).toBeTruthy()
		expect(screen.getByText("Terse")).toBeTruthy()
		expect(screen.getByText("/repo/.git")).toBeTruthy()
		expect(screen.getByText(/Run protos before vitest/)).toBeTruthy()
	})

	it("deletes a memory only after a second click and shows the list the extension returns", async () => {
		mocks.deleteMemory.mockResolvedValue({ ...fullList, project: [] })
		await openManager()
		const deleteButton = screen.getByRole("button", { name: "Delete Build quirk" })

		fireEvent.click(deleteButton)
		expect(mocks.deleteMemory).not.toHaveBeenCalled()
		expect(deleteButton.textContent).toBe("Confirm delete")
		fireEvent.click(deleteButton)

		expect(mocks.deleteMemory).toHaveBeenCalledWith(expect.objectContaining({ scope: "project", name: "build-quirk" }))
		await waitFor(() => expect(screen.queryByText("Build quirk")).toBeNull())
		expect(screen.getByText("No project memories yet.")).toBeTruthy()
	})

	it("drops the pending confirmation after a few seconds", async () => {
		await openManager()
		vi.useFakeTimers()
		const deleteButton = screen.getByRole("button", { name: "Delete Terse" })

		fireEvent.click(deleteButton)
		act(() => vi.advanceTimersByTime(5000))
		fireEvent.click(deleteButton)

		expect(mocks.deleteMemory).not.toHaveBeenCalled()
		expect(deleteButton.textContent).toBe("Confirm delete")
	})

	it("opens a memory and a scope's index", async () => {
		await openManager()

		fireEvent.click(screen.getByRole("button", { name: "Open Terse" }))
		fireEvent.click(screen.getAllByRole("button", { name: "Open index" })[1])

		expect(mocks.openMemory).toHaveBeenCalledWith(expect.objectContaining({ scope: "user", name: "terse" }))
		expect(mocks.openMemoryIndex).toHaveBeenCalledWith(expect.objectContaining({ scope: "user" }))
	})
})
