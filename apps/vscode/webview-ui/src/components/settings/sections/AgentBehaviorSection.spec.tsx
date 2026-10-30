import type { AgentLimitsState } from "@shared/AgentLimits"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ChangeEventHandler, MouseEventHandler, ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import AgentBehaviorSection from "./AgentBehaviorSection"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: (props: { id?: string; disabled?: boolean; onChange?: ChangeEventHandler<HTMLInputElement> }) => (
		<input {...props} />
	),
	VSCodeButton: ({ children, onClick }: { children?: ReactNode; onClick?: MouseEventHandler<HTMLButtonElement> }) => (
		<button onClick={onClick} type="button">
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

describe("AgentBehaviorSection", () => {
	beforeEach(() => {
		mockUpdateSetting.mockClear()
		mockExtensionState.value = { agentLimits: { values: {}, effective: {}, envOverrides: {} } }
	})

	it("renders its header and the behavior groups", () => {
		const renderSectionHeader = vi.fn(() => null)
		render(<AgentBehaviorSection renderSectionHeader={renderSectionHeader} />)

		expect(renderSectionHeader).toHaveBeenCalledWith("agent-behavior")
		for (const title of ["Tool calls", "Edit safety", "Language servers", "Loops and mistakes", "Subagents", "Hooks"]) {
			expect(screen.getByText(title)).toBeTruthy()
		}
		expect(screen.queryByText("Tool output")).toBeNull()
		expect(screen.getByText(/Changes apply to the current task once it is idle/)).toBeTruthy()
	})

	it("saves a behavior switch", () => {
		render(<AgentBehaviorSection renderSectionHeader={() => null} />)

		fireEvent.click(screen.getByRole("switch", { name: "Review before finishing" }))

		expect(mockUpdateSetting).toHaveBeenCalledWith("agentLimitUpdates", { "session.reviewBeforeFinish": 0 })
	})
})
