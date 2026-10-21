import type { ClineMessage } from "@shared/ExtensionMessage"
import { getContextUsedTokens, getLastContextUsage } from "@shared/getApiMetrics"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ButtonHTMLAttributes, PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ContextUsageIndicator } from "./ContextUsageIndicator"
import ContextWindow from "./ContextWindow"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) => (
		<button {...props}>{children}</button>
	),
}))

vi.mock("@/components/ui/hover-card", () => ({
	HoverCard: ({ children }: PropsWithChildren) => <div>{children}</div>,
	HoverCardContent: () => null,
	HoverCardTrigger: ({ children }: PropsWithChildren) => <div>{children}</div>,
}))

vi.mock("@/components/ui/progress", () => ({
	Progress: ({ value }: { value?: number }) => (
		<div aria-label="Context window usage progress" role="progressbar">
			{value}
		</div>
	),
}))

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
	TooltipContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
	TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
}))

const snapshot = {
	estimatedTotal: 1000,
	categories: {
		systemPrompt: 500,
		rules: [],
		memory: 0,
		tools: { builtin: 250, extension: 0, mcp: [] },
		messages: { conversation: 250, toolCalls: 0, toolResults: 0, filesAndImages: 0, summary: 0 },
	},
	windowTokens: 100_000,
}

const request: ClineMessage = {
	ts: 1,
	type: "say",
	say: "api_req_started",
	text: JSON.stringify({ tokensIn: 10_000, cacheReads: 30_000, tokensOut: 5_000, contextUsage: snapshot }),
}
const compaction = (info: object): ClineMessage => ({
	ts: 2,
	type: "say",
	say: "compaction",
	text: JSON.stringify({ status: "completed", mode: "auto", ...info }),
})

const renderBoth = async (messages: ClineMessage[]) => {
	const usage = getLastContextUsage(messages)
	const used = getContextUsedTokens(messages)
	render(
		<>
			<ContextUsageIndicator lastApiReqTotalTokens={used} usage={usage} />
			<ContextWindow
				compactDisabled={false}
				compactTask={vi.fn()}
				contextWindow={usage?.snapshot.windowTokens}
				lastApiReqTotalTokens={used}
				useAutoCondense={false}
			/>
		</>,
	)
	await userEvent.setup().click(screen.getByRole("button", { name: /Context usage/ }))
}

describe("context usage in the header", () => {
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

	it("shows one input-only number in the ring, the card and the bar", async () => {
		await renderBoth([request])

		expect(screen.getByRole("button", { name: "Context usage 40%" })).toBeTruthy()
		expect(screen.getByTestId("context-usage-card").textContent).toContain("40.0k / 100.0k (40%)")
		expect(screen.getByRole("progressbar").textContent).toBe("40")
		expect(screen.getByTitle("Current tokens used in this request").textContent).toBe("40.0k")
	})

	it("rescales the same number after a compaction", async () => {
		await renderBoth([request, compaction({ tokensBefore: 1000, tokensAfter: 500 })])

		expect(screen.getByRole("button", { name: "Context usage 20%" })).toBeTruthy()
		expect(screen.getByTestId("context-usage-card").textContent).toContain("20.0k / 100.0k (20%)")
		expect(screen.getByTestId("context-usage-card").textContent).toContain("compacted after the last request")
		expect(screen.getByRole("progressbar").textContent).toBe("20")
		expect(screen.getByTitle("Current tokens used in this request").textContent).toBe("20.0k")
	})

	it("keeps the number and still labels the breakdown when the compaction reports no sizes", async () => {
		await renderBoth([request, compaction({ messagesBefore: 10, messagesAfter: 3 })])

		expect(screen.getByRole("button", { name: "Context usage 40%" })).toBeTruthy()
		expect(screen.getByTestId("context-usage-card").textContent).toContain("40.0k / 100.0k (40%)")
		expect(screen.getByTestId("context-usage-card").textContent).toContain("compacted after the last request")
		expect(screen.getByRole("progressbar").textContent).toBe("40")
	})
})
