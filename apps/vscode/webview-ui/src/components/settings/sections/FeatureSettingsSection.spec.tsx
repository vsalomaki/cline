import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import FeatureSettingsSection from "./FeatureSettingsSection"

const mockUpdateSetting = vi.fn()
const mockExtensionState = vi.hoisted(() => ({
	value: {
		enableCheckpointsSetting: true,
		hooksEnabled: false,
		showFeatureTips: false,
		mcpDisplayMode: "rich",
		useAutoCondense: false,
		compactionStrategy: "basic",
		subagentsEnabled: false,
		worktreesEnabled: { user: true, featureFlag: true },
		remoteConfigSettings: {},
		backgroundEditEnabled: false,
	},
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(() => mockExtensionState.value),
}))

vi.mock("./MemoryManager", () => ({ default: () => null }))

vi.mock("@/components/settings/utils/settingsHandlers", () => ({
	updateSetting: (...args: unknown[]) => mockUpdateSetting(...args),
	updateSettings: vi.fn(),
}))

describe("FeatureSettingsSection", () => {
	beforeEach(() => {
		mockUpdateSetting.mockClear()
		mockExtensionState.value = {
			...mockExtensionState.value,
			useAutoCondense: false,
			compactionStrategy: "basic",
			memoryEnabled: false,
			memoryExtractAfterRun: true,
		}
	})

	it("turns memory on and disables the automatic saves while it is off", () => {
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByRole("switch", { name: "Save memories automatically" })).toBeDisabled()
		fireEvent.click(screen.getByRole("switch", { name: "Memory" }))

		expect(mockUpdateSetting).toHaveBeenCalledWith("memoryEnabled", true)
	})

	it("switches automatic memory saves off once memory is on", () => {
		mockExtensionState.value = { ...mockExtensionState.value, memoryEnabled: true }
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(screen.getByRole("switch", { name: "Save memories automatically" }))

		expect(mockUpdateSetting).toHaveBeenCalledWith("memoryExtractAfterRun", false)
	})

	it("renders Hooks feature toggle", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByText("Hooks")).toBeTruthy()

		const advancedSection = container.querySelector("#advanced-features")
		const agentSection = container.querySelector("#agent-features")

		expect(advancedSection?.querySelector("#hooks-setting-control")).toBeTruthy()
		expect(agentSection?.querySelector("#hooks-setting-control")).toBeNull()
	})

	it("leaves personal preferences to the General tab", () => {
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		for (const label of ["Feature Tips", "Background Edit", "MCP Display Mode"]) {
			expect(screen.queryByText(label)).toBeNull()
		}
		expect(screen.getByRole("switch", { name: "Checkpoints" })).toBeTruthy()
	})

	it("renders the Auto Compact Strategy setting in the Agent section", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByText("Auto Compact Strategy")).toBeTruthy()

		const agentSection = container.querySelector("#agent-features")
		expect(agentSection?.textContent).toContain("Basic")
	})

	it("disables Auto Compact Strategy when Auto Compact is off", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		// The first select in the Agent section is Delegation.
		const strategySelect = container.querySelectorAll("#agent-features button[role='combobox']")[1]
		expect(strategySelect).toHaveAttribute("disabled")
	})

	it("calls updateSetting with hooksEnabled when toggled", () => {
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(screen.getByRole("switch", { name: "Hooks" }))

		expect(mockUpdateSetting).toHaveBeenCalledWith("hooksEnabled", true)
	})

	it("shows the delegation mode from the subagents and agent teams settings", () => {
		mockExtensionState.value = { ...mockExtensionState.value, subagentsEnabled: true, agentTeamsEnabled: true }
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByText("Agent teams")).toBeTruthy()
		expect(screen.getByText(/start teammates that work in the background/)).toBeTruthy()
	})

	it("hides the Cloud toggle unless the rollout flag makes it available", () => {
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.queryByRole("switch", { name: "Cloud" })).toBeNull()
	})

	it("calls updateSetting with cloudSessionsEnabled when the available Cloud toggle is switched", () => {
		mockExtensionState.value = { ...mockExtensionState.value, cloudSessionsAvailable: true, cloudSessionsEnabled: false }
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(screen.getByRole("switch", { name: "Cloud" }))

		expect(mockUpdateSetting).toHaveBeenCalledWith("cloudSessionsEnabled", true)
	})
})
