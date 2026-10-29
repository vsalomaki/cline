import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { describe, expect, it, vi } from "vitest"
import type { Controller } from ".."
import { updateSettings } from "./updateSettings"

vi.mock("@/shared/services/Logger", () => ({
	Logger: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}))

function makeController() {
	const state: Record<string, boolean | undefined> = {}
	const controller = {
		postStateToWebview: vi.fn(async () => undefined),
		handleDiagnosticsLogSettingChanged: vi.fn(),
		stateManager: {
			getGlobalSettingsKey: vi.fn((key: string) => state[key]),
			setGlobalState: vi.fn((key: string, value: boolean | undefined) => {
				state[key] = value
			}),
		},
	}
	return { controller: controller as unknown as Controller, mocks: controller, state }
}

describe("updateSettings — diagnostics log", () => {
	it.each([true, false])("stores diagnosticsLogEnabled=%s and applies it at once", async (enabled) => {
		const { controller, mocks, state } = makeController()

		await updateSettings(controller, UpdateSettingsRequest.create({ diagnosticsLogEnabled: enabled }))

		expect(state.diagnosticsLogEnabled).toBe(enabled)
		expect(mocks.handleDiagnosticsLogSettingChanged).toHaveBeenCalledWith(enabled)
	})

	it("leaves the diagnostics log alone when the request does not mention it", async () => {
		const { controller, mocks } = makeController()

		await updateSettings(controller, UpdateSettingsRequest.create({ hooksEnabled: undefined }))

		expect(mocks.handleDiagnosticsLogSettingChanged).not.toHaveBeenCalled()
	})
})
