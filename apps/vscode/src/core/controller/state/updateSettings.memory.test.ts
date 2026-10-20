import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { describe, expect, it, vi } from "vitest"
import type { Controller } from ".."
import { updateSettings } from "./updateSettings"

vi.mock("@/shared/services/Logger", () => ({
	Logger: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}))

function makeController(initial: Record<string, boolean | undefined> = {}) {
	const state: Record<string, boolean | undefined> = { ...initial }
	const controller = {
		postStateToWebview: vi.fn(async () => undefined),
		handleMemorySettingChanged: vi.fn(),
		stateManager: {
			getGlobalSettingsKey: vi.fn((key: string) => state[key]),
			setGlobalState: vi.fn((key: string, value: boolean | undefined) => {
				state[key] = value
			}),
		},
	}
	return { controller: controller as unknown as Controller, mocks: controller, state }
}

describe("updateSettings — memory", () => {
	it("stores memoryEnabled and reports the change from the defaults", async () => {
		const { controller, mocks, state } = makeController()

		await updateSettings(controller, UpdateSettingsRequest.create({ memoryEnabled: true }))

		expect(state.memoryEnabled).toBe(true)
		expect(mocks.handleMemorySettingChanged).toHaveBeenCalledWith(
			{ enabled: false, extractAfterRun: true },
			{ enabled: true, extractAfterRun: true },
		)
	})

	it("stores memoryExtractAfterRun on its own", async () => {
		const { controller, mocks, state } = makeController({ memoryEnabled: true })

		await updateSettings(controller, UpdateSettingsRequest.create({ memoryExtractAfterRun: false }))

		expect(state.memoryExtractAfterRun).toBe(false)
		expect(state.memoryEnabled).toBe(true)
		expect(mocks.handleMemorySettingChanged).toHaveBeenCalledWith(
			{ enabled: true, extractAfterRun: true },
			{ enabled: true, extractAfterRun: false },
		)
	})

	it("leaves memory alone when the request does not mention it", async () => {
		const { controller, mocks } = makeController()

		await updateSettings(controller, UpdateSettingsRequest.create({ hooksEnabled: undefined }))

		expect(mocks.handleMemorySettingChanged).not.toHaveBeenCalled()
	})
})
