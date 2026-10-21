import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import MemoryActionRow from "./MemoryActionRow"

const mocks = vi.hoisted(() => ({ openMemory: vi.fn() }))

vi.mock("@/services/grpc-client", () => ({ MemoryServiceClient: { openMemory: mocks.openMemory } }))

describe("MemoryActionRow", () => {
	beforeEach(() => {
		mocks.openMemory.mockReset()
		mocks.openMemory.mockResolvedValue({})
	})

	it("shows a saved memory and opens its file on click", () => {
		render(
			<MemoryActionRow
				canOpen
				memory={{ action: "save", scope: "project", name: "Build quirk", description: "Run protos before vitest" }}
			/>,
		)

		expect(screen.getByText("Saved project memory")).toBeTruthy()
		expect(screen.getByText(/Run protos before vitest/)).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: /Build quirk/ }))

		expect(mocks.openMemory).toHaveBeenCalledWith(expect.objectContaining({ scope: "project", name: "Build quirk" }))
	})

	it("labels a memory saved without a tool call", () => {
		render(<MemoryActionRow canOpen memory={{ action: "save", scope: "user", name: "Terse", automatic: true }} />)

		expect(screen.getByText("Memory saved automatically (user)")).toBeTruthy()
	})

	it("shows a refusal without a link", () => {
		render(
			<MemoryActionRow
				canOpen
				memory={{ action: "save", scope: "user", name: "Terse", error: "The user memory is full (50 memories)." }}
			/>,
		)

		expect(screen.getByText("Couldn't save user memory")).toBeTruthy()
		expect(screen.getByText("The user memory is full (50 memories).")).toBeTruthy()
		expect(screen.queryByRole("button")).toBeNull()
	})

	it("does not link a deleted memory", () => {
		render(<MemoryActionRow canOpen memory={{ action: "delete", scope: "project", name: "Build quirk" }} />)

		expect(screen.getByText("Deleted project memory")).toBeTruthy()
		expect(screen.queryByRole("button")).toBeNull()
	})

	it("renders a view as one line", () => {
		const { container } = render(<MemoryActionRow canOpen memory={{ action: "view", scope: "project" }} />)

		expect(container.textContent).toBe("Viewed the project memory index")
	})
})
