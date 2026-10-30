import { AGENT_LIMIT_DEFINITIONS, AGENT_LIMIT_GROUPS, type AgentLimitsState, type AgentLimitTab } from "@shared/AgentLimits"
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
import { AgentLimitsPanel } from "./AgentLimitsSection"

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

const TABS: AgentLimitTab[] = ["api-config", "agent-behavior", "agent-limits"]

const renderTab = (tab: AgentLimitTab) => render(<AgentLimitsPanel tab={tab} />)
const field = (id: string) => document.getElementById(`agent-limit-${id.replace(".", "-")}`) as HTMLInputElement

describe("AgentLimitsSection", () => {
	beforeEach(() => {
		mockUpdateSetting.mockClear()
		setLimits({})
	})

	it("renders every group in exactly one tab", () => {
		const tabsByGroup = new Map<string, AgentLimitTab[]>()
		const tabsByLimit = new Map<string, AgentLimitTab[]>()
		for (const tab of TABS) {
			const { unmount } = renderTab(tab)
			for (const group of AGENT_LIMIT_GROUPS) {
				if (document.getElementById(`agent-limits-${group.id}`)) {
					tabsByGroup.set(group.id, [...(tabsByGroup.get(group.id) ?? []), tab])
				}
			}
			for (const definition of AGENT_LIMIT_DEFINITIONS) {
				if (field(definition.id)) {
					tabsByLimit.set(definition.id, [...(tabsByLimit.get(definition.id) ?? []), tab])
				}
			}
			unmount()
		}

		for (const group of AGENT_LIMIT_GROUPS) {
			expect(tabsByGroup.get(group.id), group.id).toEqual([group.tab])
		}
		for (const definition of AGENT_LIMIT_DEFINITIONS) {
			expect(tabsByLimit.get(definition.id), definition.id).toHaveLength(1)
		}
	})

	it("keeps switches on Agent Behavior and caps on Context & Limits", () => {
		renderTab("agent-limits")
		for (const title of ["Tool input", "Tool output", "Provider request", "Compaction", "Tool timeouts"]) {
			expect(screen.getByText(title)).toBeTruthy()
		}
		expect(field("session.readBeforeWrite")).toBeNull()
		expect(field("api.maxRetries")).toBeNull()
	})

	it("shows the model request settings on the API tab", () => {
		renderTab("api-config")

		expect(screen.getByText("Model requests")).toBeTruthy()
		expect(field("api.maxRetries")).toBeTruthy()
		expect(field("api.requestTimeout")).toBeTruthy()
		expect(screen.getByText(/Changes apply to the current task once it is idle/)).toBeTruthy()
	})

	it("saves a toggle as its number and resets it at the default", () => {
		renderTab("agent-behavior")
		const toggle = document.getElementById("agent-limit-session-loopDetection") as HTMLElement

		expect(toggle.getAttribute("aria-checked")).toBe("true")
		fireEvent.click(toggle)
		expect(mockUpdateSetting).toHaveBeenCalledWith("agentLimitUpdates", { "session.loopDetection": 0 })
	})

	it("resets a toggle that returns to its default", () => {
		setLimits({ values: { "session.loopDetection": 0 } })
		renderTab("agent-behavior")
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
		renderTab("agent-behavior")
		const toggle = document.getElementById("agent-limit-session-readBeforeWrite") as HTMLButtonElement

		expect(toggle.disabled).toBe(true)
		expect(toggle.getAttribute("aria-checked")).toBe("false")
		expect(screen.getByText("CLINE_READ_BEFORE_WRITE")).toBeTruthy()
	})

	it("saves timeouts entered in seconds as milliseconds", () => {
		renderTab("agent-limits")

		fireEvent.change(field("timeout.ripgrep"), { target: { value: "20" } })
		fireEvent.blur(field("timeout.ripgrep"))

		expect(mockUpdateSetting).toHaveBeenCalledWith("agentLimitUpdates", { "timeout.ripgrep": 20_000 })
	})

	it("resets a limit when its field is cleared", () => {
		setLimits({ values: { "tool.readLines": 500 } })
		renderTab("agent-limits")

		expect(field("tool.readLines").value).toBe("500")
		fireEvent.change(field("tool.readLines"), { target: { value: "" } })
		fireEvent.blur(field("tool.readLines"))

		expect(mockUpdateSetting).toHaveBeenCalledWith("agentLimitUpdates", { "tool.readLines": -1 })
	})

	it("rejects out-of-range input without saving", () => {
		renderTab("agent-limits")

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
		renderTab("agent-limits")

		expect(field("tool.readLines").disabled).toBe(true)
		expect(screen.getByText("CLINE_TOOL_MAX_READ_LINES")).toBeTruthy()
	})

	it("shows the effective value when coupling adjusts it", () => {
		setLimits({ values: { "message.toolResultChars": 10_000 }, effective: { "tool.commandOutputChars": 8_000 } })
		renderTab("agent-limits")

		expect(screen.getByText(/In effect: 8,000/)).toBeTruthy()
	})

	it("disables the thresholds when loop detection is off", () => {
		setLimits({ values: { "session.loopDetection": 0 } })
		renderTab("agent-behavior")

		expect(field("session.loopSoftThreshold").disabled).toBe(true)
		expect(field("session.loopHardThreshold").disabled).toBe(true)
		expect(field("session.maxConsecutiveMistakes").disabled).toBe(false)
	})

	it("saves a choice as its number and resets it at the default", () => {
		renderTab("agent-behavior")
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
		renderTab("agent-behavior")
		const select = field("session.problemsAfterEdit") as unknown as HTMLSelectElement

		expect(select.disabled).toBe(true)
		expect(select.value).toBe("0")
		expect(screen.getByText("CLINE_PROBLEMS_AFTER_EDIT")).toBeTruthy()
	})

	it("resets only the changed limits on its own tab", () => {
		setLimits({ values: { "tool.readLines": 500, "message.toolResultChars": 20_000, "session.loopDetection": 0 } })
		renderTab("agent-limits")

		fireEvent.click(screen.getByText("Reset these to defaults"))

		expect(mockUpdateSetting).toHaveBeenCalledWith("agentLimitUpdates", {
			"tool.readLines": -1,
			"message.toolResultChars": -1,
		})
	})

	it("disables the reset while its tab has no changes", () => {
		setLimits({ values: { "session.loopDetection": 0 } })
		renderTab("agent-limits")

		expect((screen.getByText("Reset these to defaults") as HTMLButtonElement).disabled).toBe(true)
	})
})
