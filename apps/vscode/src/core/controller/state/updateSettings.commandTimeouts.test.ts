import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { describe, expect, it, vi } from "vitest"
import type { Controller } from ".."
import { updateSettings } from "./updateSettings"

vi.mock("@/shared/services/Logger", () => ({
	Logger: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}))

function makeController(initial: Record<string, number | undefined> = {}) {
	const state: Record<string, number | undefined> = { ...initial }
	const controller = {
		postStateToWebview: vi.fn(async () => undefined),
		handleCommandTimeoutsChanged: vi.fn(),
		stateManager: {
			getGlobalStateKey: vi.fn((key: string) => state[key]),
			setGlobalState: vi.fn((key: string, value: number | undefined) => {
				state[key] = value
			}),
		},
	}
	return { controller: controller as unknown as Controller, mocks: controller, state }
}

describe("updateSettings — command timeouts", () => {
	it("stores both timeouts and rebuilds the session tools once", async () => {
		const { controller, mocks, state } = makeController()

		await updateSettings(
			controller,
			UpdateSettingsRequest.create({ backgroundCommandTimeoutMs: 120_000, foregroundCommandAutoProceedMs: 600_000 }),
		)

		expect(state.backgroundCommandTimeoutMs).toBe(120_000)
		expect(state.foregroundCommandAutoProceedMs).toBe(600_000)
		expect(mocks.handleCommandTimeoutsChanged).toHaveBeenCalledOnce()
	})

	it("resets to the default when 0 is sent", async () => {
		const { controller, mocks, state } = makeController({ backgroundCommandTimeoutMs: 120_000 })

		await updateSettings(controller, UpdateSettingsRequest.create({ backgroundCommandTimeoutMs: 0 }))

		expect(state.backgroundCommandTimeoutMs).toBeUndefined()
		expect(mocks.handleCommandTimeoutsChanged).toHaveBeenCalledOnce()
	})

	it("does not rebuild when the stored value is unchanged", async () => {
		const { controller, mocks } = makeController({ foregroundCommandAutoProceedMs: 600_000 })

		await updateSettings(controller, UpdateSettingsRequest.create({ foregroundCommandAutoProceedMs: 600_000 }))

		expect(mocks.handleCommandTimeoutsChanged).not.toHaveBeenCalled()
	})
})
