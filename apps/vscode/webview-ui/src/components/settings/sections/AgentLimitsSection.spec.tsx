import { AGENT_LIMIT_GROUPS, type AgentLimitsState } from "@shared/AgentLimits"
import { fireEvent, render, screen } from "@testing-library/react"
import {
	type ChangeEventHandler,
	Children,
	type FocusEventHandler,
	isValidElement,
	type KeyboardEventHandler,
	type MouseEventHandler,
	type ReactNode,
} from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import AgentLimitsSection from "./AgentLimitsSection"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: (props: {
		id?: string
		disabled?: boolean
		placeholder?: string
		value?: string
		onChange?: ChangeEventHandler<HTMLInputElement>
		onBlur?: FocusEventHandler<HTMLInputElement>
		onKeyDown?: KeyboardEventHandler<HTMLInputElement>
	}) => <input {...props} />,
	VSCodeButton: ({
		children,
		disabled,
		onClick,
	}: {
		children?: ReactNode
		disabled?: boolean
		onClick?: MouseEventHandler<HTMLButtonElement>
	}) => (
		<button disabled={disabled} onClick={onClick} type="button">
			{children}
		</button>
	),
}))

// Radix Select needs pointer APIs jsdom lacks; render a native select that takes its id from the trigger.
vi.mock("@/components/ui/select", () => ({
	Select: ({
		children,
		disabled,
		onValueChange,
		value,
	}: {
		children?: ReactNode
		disabled?: boolean
		onValueChange?: (value: string) => void
		value?: string
	}) => {
		const id = Children.toArray(children)
			.map((child) => (isValidElement<{ id?: string }>(child) ? child.props.id : undefined))
			.find(Boolean)
		return (
			<select disabled={disabled} id={id} onChange={(event) => onValueChange?.(event.target.value)} value={value}>
				{children}
			</select>
		)
	},
	SelectTrigger: () => null,
	SelectValue: () => null,
	SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
	SelectItem: ({ children, value }: { children?: ReactNode; value: string }) => <option value={value}>{children}</option>,
}))

const mockUpdateSetting = vi.fn()
const mockExtensionState = vi.hoisted(() => ({ value: {} as { agentLimits?: AgentLimitsState } }))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(() => mockExtensionState.value),
}))

vi.mock("../utils/settingsHandlers", () => ({
	updateSetting: (...args: unknown[]) => mockUpdateSetting(...args),
}))

function setLimits(limits: Partial<AgentLimitsState>) {
	mockExtensionState.value = {
		agentLimits: { values: {}, effective: {}, envOverrides: {}, ...limits },
	}
}

const renderSection = () => render(<AgentLimitsSection renderSectionHeader={() => null} />)
const field = (id: string) => document.getElementById(`agent-limit-${id.replace(".", "-")}`) as HTMLInputElement

describe("AgentLimitsSection", () => {
	beforeEach(() => {
		mockUpdateSetting.mockClear()
		setLimits({})
	})

	it("renders every group", () => {
		renderSection()

		for (const title of [
			"Language servers",
			"Tool output",
			"Tool input",
			"Provider request",
			"Tool timeouts",
			"Loops and mistakes",
			"Compaction",
		]) {
			expect(screen.getByText(title)).toBeTruthy()
		}
	})

	it("puts the groups under category cards", () => {
		renderSection()
		const inCategory = (category: string, group: string) =>
			document
				.getElementById(`agent-limits-category-${category}`)
				?.contains(document.getElementById(`agent-limits-${group}`))

		for (const title of ["Model", "Tools", "Agent"]) {
			expect(screen.getByText(title)).toBeTruthy()
		}
		expect(inCategory("model", "compaction")).toBe(true)
		expect(inCategory("tools", "timeouts")).toBe(true)
		expect(inCategory("agent", "loop")).toBe(true)
		expect(document.getElementById("agent-limits-category-other")).toBeNull()
	})

	it("renders a group missing from the category map under Other", () => {
		const groups = AGENT_LIMIT_GROUPS as unknown as Array<{ id: string; title: string; description: string }>
		groups.push({ id: "futureGroup", title: "Future group", description: "Added later." })
		try {
			renderSection()

			expect(
				document
					.getElementById("agent-limits-category-other")
					?.contains(document.getElementById("agent-limits-futureGroup")),
			).toBe(true)
			expect(screen.getByText("Other")).toBeTruthy()
		} finally {
			groups.pop()
		}
	})

	it("saves a toggle as its number and resets it at the default", () => {
		renderSection()
		const toggle = document.getElementById("agent-limit-session-loopDetection") as HTMLElement

		expect(toggle.getAttribute("aria-checked")).toBe("true")
		fireEvent.click(toggle)
		expect(mockUpdateSetting).toHaveBeenCalledWith("agentLimitUpdates", { "session.loopDetection": 0 })
	})

	it("resets a toggle that returns to its default", () => {
		setLimits({ values: { "session.loopDetection": 0 } })
		renderSection()
		const toggle = document.getElementById("agent-limit-session-loopDetection") as HTMLElement

		expect(toggle.getAttribute("aria-checked")).toBe("false")
		fireEvent.click(toggle)
		expect(mockUpdateSetting).toHaveBeenCalledWith("agentLimitUpdates", { "session.loopDetection": -1 })
	})

	it("locks a toggle an env var overrides and shows its value", () => {
		setLimits({
			effective: { "session.readBeforeWrite": 0 },
			envOverrides: { "session.readBeforeWrite": "CLINE_READ_BEFORE_WRITE" },
		})
		renderSection()
		const toggle = document.getElementById("agent-limit-session-readBeforeWrite") as HTMLButtonElement

		expect(toggle.disabled).toBe(true)
		expect(toggle.getAttribute("aria-checked")).toBe("false")
		expect(screen.getByText("CLINE_READ_BEFORE_WRITE")).toBeTruthy()
	})

	it("saves timeouts entered in seconds as milliseconds", () => {
		renderSection()

		fireEvent.change(field("timeout.ripgrep"), { target: { value: "20" } })
		fireEvent.blur(field("timeout.ripgrep"))

		expect(mockUpdateSetting).toHaveBeenCalledWith("agentLimitUpdates", { "timeout.ripgrep": 20_000 })
	})

	it("resets a limit when its field is cleared", () => {
		setLimits({ values: { "tool.readLines": 500 } })
		renderSection()

		expect(field("tool.readLines").value).toBe("500")
		fireEvent.change(field("tool.readLines"), { target: { value: "" } })
		fireEvent.blur(field("tool.readLines"))

		expect(mockUpdateSetting).toHaveBeenCalledWith("agentLimitUpdates", { "tool.readLines": -1 })
	})

	it("rejects out-of-range input without saving", () => {
		renderSection()

		fireEvent.change(field("tool.commandOutputChars"), { target: { value: "5" } })
		expect(screen.getByText(/Enter 1,000–10,000,000/)).toBeTruthy()
		fireEvent.blur(field("tool.commandOutputChars"))

		expect(mockUpdateSetting).not.toHaveBeenCalled()
		expect(field("tool.commandOutputChars").value).toBe("")
	})

	it("locks a field an env var overrides", () => {
		setLimits({
			effective: { "tool.readLines": 900 },
			envOverrides: { "tool.readLines": "CLINE_TOOL_MAX_READ_LINES" },
		})
		renderSection()

		expect(field("tool.readLines").disabled).toBe(true)
		expect(screen.getByText("CLINE_TOOL_MAX_READ_LINES")).toBeTruthy()
	})

	it("shows the effective value when coupling adjusts it", () => {
		setLimits({ values: { "message.toolResultChars": 10_000 }, effective: { "tool.commandOutputChars": 8_000 } })
		renderSection()

		expect(screen.getByText(/In effect: 8,000/)).toBeTruthy()
	})

	it("disables the thresholds when loop detection is off", () => {
		setLimits({ values: { "session.loopDetection": 0 } })
		renderSection()

		expect(field("session.loopSoftThreshold").disabled).toBe(true)
		expect(field("session.loopHardThreshold").disabled).toBe(true)
		expect(field("session.maxConsecutiveMistakes").disabled).toBe(false)
	})

	it("saves a choice as its number and resets it at the default", () => {
		renderSection()
		const select = field("session.problemsAfterEdit") as unknown as HTMLSelectElement

		expect(select.value).toBe("1")
		fireEvent.change(select, { target: { value: "2" } })
		expect(mockUpdateSetting).toHaveBeenCalledWith("agentLimitUpdates", { "session.problemsAfterEdit": 2 })
		fireEvent.change(select, { target: { value: "1" } })
		expect(mockUpdateSetting).toHaveBeenLastCalledWith("agentLimitUpdates", { "session.problemsAfterEdit": -1 })
	})

	it("locks a choice an env var overrides and shows its value", () => {
		setLimits({
			effective: { "session.problemsAfterEdit": 0 },
			envOverrides: { "session.problemsAfterEdit": "CLINE_PROBLEMS_AFTER_EDIT" },
		})
		renderSection()
		const select = field("session.problemsAfterEdit") as unknown as HTMLSelectElement

		expect(select.disabled).toBe(true)
		expect(select.value).toBe("0")
		expect(screen.getByText("CLINE_PROBLEMS_AFTER_EDIT")).toBeTruthy()
	})

	it("resets every changed limit at once", () => {
		setLimits({ values: { "tool.readLines": 500, "timeout.hook": 60_000 } })
		renderSection()

		fireEvent.click(screen.getByText("Reset all to defaults"))

		expect(mockUpdateSetting).toHaveBeenCalledWith("agentLimitUpdates", { "tool.readLines": -1, "timeout.hook": -1 })
	})
})
