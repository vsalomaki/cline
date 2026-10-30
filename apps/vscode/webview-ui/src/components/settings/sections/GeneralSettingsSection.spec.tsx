import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { featureSettingElementId, resolveSettingsTarget } from "../settingsTargets"
import GeneralSettingsSection from "./GeneralSettingsSection"

const mockUpdateSetting = vi.fn()
const mockExtensionState = vi.hoisted(() => ({
	value: {
		showFeatureTips: false,
		backgroundEditEnabled: false,
		mcpDisplayMode: "rich",
		diagnosticsLogEnabled: false,
		remoteConfigSettings: {},
	},
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(() => mockExtensionState.value),
}))

vi.mock("../PreferredLanguageSetting", () => ({ default: () => null }))

vi.mock("../utils/settingsHandlers", () => ({
	updateSetting: (...args: unknown[]) => mockUpdateSetting(...args),
}))

describe("GeneralSettingsSection", () => {
	beforeEach(() => {
		mockUpdateSetting.mockClear()
	})

	it("toggles Feature Tips and Background Edit", () => {
		render(<GeneralSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(screen.getByRole("switch", { name: "Feature Tips" }))
		fireEvent.click(screen.getByRole("switch", { name: "Background Edit" }))

		expect(mockUpdateSetting).toHaveBeenCalledWith("showFeatureTips", true)
		expect(mockUpdateSetting).toHaveBeenCalledWith("backgroundEditEnabled", true)
	})

	it("holds the MCP Display Mode that the MCP settings links open", () => {
		render(<GeneralSettingsSection renderSectionHeader={() => null} />)
		const target = resolveSettingsTarget("mcp-display-mode")

		expect(target).toMatchObject({ tabId: "general", elementId: featureSettingElementId("mcp-display-mode") })
		expect(document.getElementById(target?.elementId ?? "")?.textContent).toContain("MCP Display Mode")
		expect(document.getElementById(target?.focusElementId ?? "")).toBeTruthy()
	})
})
