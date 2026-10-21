import type { QueuedPrompt } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueuedPrompts } from "./QueuedPrompts"

const cancelQueuedPromptMock = vi.hoisted(() => vi.fn())
const updateQueuedPromptMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		cancelQueuedPrompt: (request: unknown) => cancelQueuedPromptMock(request),
		updateQueuedPrompt: (request: unknown) => updateQueuedPromptMock(request),
	},
}))

vi.mock("@shared/proto/cline/common", () => ({
	StringRequest: {
		create: (request: unknown) => request,
	},
}))

vi.mock("@shared/proto/cline/task", () => ({
	UpdateQueuedPromptRequest: {
		create: (request: unknown) => request,
	},
}))

const queuedPrompts: QueuedPrompt[] = [
	{
		id: "prompt-1",
		prompt: "First queued message",
		delivery: "queue",
		attachmentCount: 0,
	},
	{
		id: "prompt-2",
		prompt: "Second queued message",
		delivery: "steer",
		attachmentCount: 1,
	},
]

describe("QueuedPrompts", () => {
	beforeEach(() => {
		cancelQueuedPromptMock.mockReset()
		cancelQueuedPromptMock.mockResolvedValue({})
		updateQueuedPromptMock.mockReset()
		updateQueuedPromptMock.mockResolvedValue({})
	})

	it("shows when each message is delivered and switches it per row", async () => {
		render(<QueuedPrompts items={queuedPrompts} />)

		expect(screen.getByText("1 for the next step, 1 after the run")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Send at the next step instead" }))
		expect(updateQueuedPromptMock).toHaveBeenCalledWith({ promptId: "prompt-1", delivery: "steer" })

		const afterRun = screen.getByRole("button", { name: "Send after the run instead" })
		expect(afterRun).toHaveTextContent("Next step")
		fireEvent.click(afterRun)
		expect(updateQueuedPromptMock).toHaveBeenLastCalledWith({ promptId: "prompt-2", delivery: "queue" })
		await waitFor(() => expect(afterRun).not.toBeDisabled())
	})

	it("cancels a queued prompt from the row action", async () => {
		render(<QueuedPrompts items={queuedPrompts} />)

		const cancelButtons = screen.getAllByRole("button", { name: "Cancel queued message" })
		fireEvent.click(cancelButtons[0])

		expect(cancelQueuedPromptMock).toHaveBeenCalledTimes(1)
		expect(cancelQueuedPromptMock).toHaveBeenCalledWith({ value: "prompt-1" })
		expect(cancelButtons[0]).toBeDisabled()

		await waitFor(() => expect(cancelButtons[0]).not.toBeDisabled())
	})

	it("does not render an empty queue", () => {
		const { container } = render(<QueuedPrompts items={[]} />)

		expect(container).toBeEmptyDOMElement()
	})
})
