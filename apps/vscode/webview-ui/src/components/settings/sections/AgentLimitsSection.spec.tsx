import type { AgentLimitsState } from "@shared/AgentLimits"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ChangeEventHandler, FocusEventHandler, KeyboardEventHandler, MouseEventHandler, ReactNode } from "react"
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
	VSCodeCheckbox: ({
		checked,
		children,
		onChange,
	}: {
		checked?: boolean
		children?: ReactNode
		onChange?: ChangeEventHandler<HTMLInputElement>
	}) => (
		<label>
			<input checked={checked} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
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

	it("resets every changed limit at once", () => {
		setLimits({ values: { "tool.readLines": 500, "timeout.hook": 60_000 } })
		renderSection()

		fireEvent.click(screen.getByText("Reset all to defaults"))

		expect(mockUpdateSetting).toHaveBeenCalledWith("agentLimitUpdates", { "tool.readLines": -1, "timeout.hook": -1 })
	})
})
