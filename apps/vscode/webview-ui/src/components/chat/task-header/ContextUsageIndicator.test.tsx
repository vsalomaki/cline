import type { LastContextUsage } from "@shared/getApiMetrics"
import { act, createEvent, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ContextUsageIndicator } from "./ContextUsageIndicator"

const usage: LastContextUsage = {
	snapshot: {
		estimatedTotal: 1000,
		categories: {
			systemPrompt: 300,
			rules: [
				{
					id: "user-instructions",
					tokens: 100,
					files: [
						{ name: ".clinerules/style.md", tokens: 60 },
						{ name: "global.md", tokens: 40 },
					],
				},
			],
			memory: 0,
			tools: { builtin: 200, extension: 0, mcp: [{ server: "github", tokens: 100 }] },
			messages: { conversation: 200, toolCalls: 50, toolResults: 50, filesAndImages: 0, summary: 0 },
		},
		windowTokens: 100_000,
		compactAtTokens: 80_000,
	},
	inputTokens: 40_000,
	usedTokens: 40_000,
	compactedAfter: false,
}

const triggerName = (share: string) => `Context usage ${share}`
const getTrigger = (share = "40%") => screen.getByRole("button", { name: triggerName(share) })
const touch = (type: "pointerEnter" | "pointerLeave", element: Element) => {
	// jsdom has no PointerEvent, so the init dictionary would drop pointerType.
	const event = createEvent[type](element)
	Object.defineProperty(event, "pointerType", { value: "touch" })
	fireEvent(element, event)
}
const getCard = () => screen.getByTestId("context-usage-card")

describe("ContextUsageIndicator", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class ResizeObserver {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("shows the request's share of the session's window and its breakdown", async () => {
		const user = userEvent.setup()
		render(<ContextUsageIndicator contextWindow={1_000_000} lastApiReqTotalTokens={41_000} usage={usage} />)

		expect(getTrigger().getAttribute("aria-expanded")).toBe("false")
		await user.click(getTrigger())
		expect(getTrigger().getAttribute("aria-expanded")).toBe("true")
		const card = getCard()
		expect(card.textContent).toContain("40.0k / 100.0k (40%)")
		expect(card.textContent).toContain("System prompt")
		expect(card.textContent).toContain("12.0k")
		expect(card.textContent).not.toContain("Memory")
		expect(card.textContent).toContain("Free space")
		expect(card.textContent).toContain("60.0k")
		expect(card.textContent).toContain("Compacts at 80.0k tokens (80%)")
		expect(screen.getByTestId("context-usage-compaction-marker").style.left).toBe("80%")
	})

	it("opens from the keyboard, reaches the expand buttons with Tab, and returns focus on Escape", async () => {
		const user = userEvent.setup()
		render(<ContextUsageIndicator usage={usage} />)

		getTrigger().focus()
		await user.keyboard("{Enter}")
		expect(getTrigger().getAttribute("aria-expanded")).toBe("true")
		expect(getCard().contains(document.activeElement)).toBe(true)

		const rules = screen.getByRole("button", { name: /Rules/ })
		for (let i = 0; i < 4 && document.activeElement !== rules; i++) {
			await user.tab()
		}
		expect(document.activeElement).toBe(rules)
		expect(screen.queryByText(".clinerules/style.md")).toBeNull()
		await user.keyboard("{Enter}")
		expect(screen.getByText(".clinerules/style.md")).toBeTruthy()

		await user.keyboard("{Escape}")
		expect(screen.queryByTestId("context-usage-card")).toBeNull()
		expect(getTrigger().getAttribute("aria-expanded")).toBe("false")
		expect(document.activeElement).toBe(getTrigger())
	})

	it("opens with Space", async () => {
		const user = userEvent.setup()
		render(<ContextUsageIndicator usage={usage} />)

		getTrigger().focus()
		await user.keyboard(" ")
		expect(getCard()).toBeTruthy()
		expect(getCard().contains(document.activeElement)).toBe(true)
	})

	it("expands rules into files and tools into MCP servers", async () => {
		const user = userEvent.setup()
		render(<ContextUsageIndicator usage={usage} />)

		await user.click(getTrigger())
		expect(screen.queryByText(".clinerules/style.md")).toBeNull()
		await user.click(screen.getByRole("button", { name: /Rules/ }))
		expect(screen.getByText(".clinerules/style.md")).toBeTruthy()
		await user.click(screen.getByRole("button", { name: /Tools/ }))
		expect(screen.getByText("MCP: github")).toBeTruthy()
	})

	it("opens on hover after a delay and closes when the pointer leaves", () => {
		vi.useFakeTimers()
		render(<ContextUsageIndicator usage={usage} />)

		fireEvent.pointerEnter(getTrigger())
		expect(screen.queryByTestId("context-usage-card")).toBeNull()
		act(() => {
			vi.advanceTimersByTime(300)
		})
		expect(getCard()).toBeTruthy()
		expect(document.activeElement).not.toBe(getCard())

		fireEvent.pointerLeave(getTrigger())
		act(() => {
			vi.advanceTimersByTime(150)
		})
		expect(screen.queryByTestId("context-usage-card")).toBeNull()
	})

	it("stays open while the pointer moves from the trigger into the card", () => {
		vi.useFakeTimers()
		render(<ContextUsageIndicator usage={usage} />)

		fireEvent.pointerEnter(getTrigger())
		act(() => {
			vi.advanceTimersByTime(300)
		})
		fireEvent.pointerLeave(getTrigger())
		fireEvent.pointerEnter(getCard())
		act(() => {
			vi.advanceTimersByTime(500)
		})
		expect(getCard()).toBeTruthy()
	})

	it("does not open or close on the pointer events a tap fires", () => {
		vi.useFakeTimers()
		render(<ContextUsageIndicator usage={usage} />)

		touch("pointerEnter", getTrigger())
		act(() => {
			vi.advanceTimersByTime(300)
		})
		expect(screen.queryByTestId("context-usage-card")).toBeNull()

		fireEvent.click(getTrigger())
		touch("pointerLeave", getTrigger())
		act(() => {
			vi.advanceTimersByTime(500)
		})
		expect(getCard()).toBeTruthy()
	})

	it("closes on a click outside", async () => {
		const user = userEvent.setup()
		render(
			<div>
				<ContextUsageIndicator usage={usage} />
				<p>elsewhere</p>
			</div>,
		)

		await user.click(getTrigger())
		expect(getCard()).toBeTruthy()
		await user.click(screen.getByText("elsewhere"))
		expect(screen.queryByTestId("context-usage-card")).toBeNull()
	})

	it("keeps clicks and keys away from the header row that collapses the task", async () => {
		const user = userEvent.setup()
		const onHeaderClick = vi.fn()
		const onHeaderKeyDown = vi.fn()
		render(
			// biome-ignore lint/a11y/noStaticElementInteractions: stands in for the task header row
			<div onClick={onHeaderClick} onKeyDown={onHeaderKeyDown}>
				<ContextUsageIndicator usage={usage} />
			</div>,
		)

		getTrigger().focus()
		await user.keyboard("{Enter}")
		await user.click(screen.getByRole("button", { name: /Rules/ }))
		await user.keyboard("{Tab}{Enter}")
		await user.click(screen.getByText("Free space"))

		expect(onHeaderClick).not.toHaveBeenCalled()
		expect(onHeaderKeyDown).not.toHaveBeenCalled()
	})

	it("labels a breakdown from before a compaction and follows the compacted total", async () => {
		const user = userEvent.setup()
		render(<ContextUsageIndicator usage={{ ...usage, usedTokens: 15_000, compactedAfter: true }} />)

		await user.click(getTrigger("15%"))
		expect(getCard().textContent).toContain("15.0k / 100.0k (15%)")
		expect(getCard().textContent).toContain("compacted after the last request")
	})

	it("falls back to the single number when the task has no breakdown", async () => {
		const user = userEvent.setup()
		render(<ContextUsageIndicator contextWindow={200_000} lastApiReqTotalTokens={50_000} />)

		await user.click(getTrigger("25%"))
		expect(getCard().textContent).toContain("50.0k / 200.0k (25%)")
		expect(getCard().textContent).not.toContain("System prompt")
	})

	it("renders nothing before the first request", () => {
		const { container } = render(<ContextUsageIndicator contextWindow={200_000} />)
		expect(container.innerHTML).toBe("")
	})
})
