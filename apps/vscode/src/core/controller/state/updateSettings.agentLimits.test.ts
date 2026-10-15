import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { describe, expect, it, vi } from "vitest"
import type { Controller } from ".."
import { updateSettings } from "./updateSettings"

vi.mock("@/shared/services/Logger", () => ({
	Logger: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}))

function makeController(initial: Record<string, unknown> = {}) {
	const state: Record<string, unknown> = { ...initial }
	const controller = {
		postStateToWebview: vi.fn(async () => undefined),
		handleAgentLimitsChanged: vi.fn(),
		stateManager: {
			getGlobalStateKey: vi.fn((key: string) => state[key]),
			getGlobalSettingsKey: vi.fn((key: string) => state[key]),
			setGlobalState: vi.fn((key: string, value: unknown) => {
				state[key] = value
			}),
		},
	}
	return { controller: controller as unknown as Controller, mocks: controller, state }
}

describe("updateSettings — agent limits", () => {
	it("merges updates and rebuilds the session once", async () => {
		const { controller, mocks, state } = makeController({ agentLimitSettings: { "tool.readLines": 500 } })

		await updateSettings(
			controller,
			UpdateSettingsRequest.create({ agentLimitUpdates: { "timeout.hook": 60_000, "tool.lineChars": 4_000 } }),
		)

		expect(state.agentLimitSettings).toEqual({ "tool.readLines": 500, "timeout.hook": 60_000, "tool.lineChars": 4_000 })
		expect(mocks.handleAgentLimitsChanged).toHaveBeenCalledOnce()
	})

	it("clears the key when the last value is reset", async () => {
		const { controller, state } = makeController({ agentLimitSettings: { "tool.readLines": 500 } })

		await updateSettings(controller, UpdateSettingsRequest.create({ agentLimitUpdates: { "tool.readLines": -1 } }))

		expect(state.agentLimitSettings).toBeUndefined()
	})

	it("does not rebuild when nothing changes", async () => {
		const { controller, mocks } = makeController({ agentLimitSettings: { "tool.readLines": 500 } })

		await updateSettings(controller, UpdateSettingsRequest.create({ agentLimitUpdates: { "tool.readLines": 500 } }))

		expect(mocks.handleAgentLimitsChanged).not.toHaveBeenCalled()
	})

	it("stores the response timeout in the requestTimeoutMs setting", async () => {
		const { controller, mocks, state } = makeController({ agentLimitSettings: { "tool.readLines": 500 } })

		await updateSettings(
			controller,
			UpdateSettingsRequest.create({ agentLimitUpdates: { "api.requestTimeout": 120_000, "api.maxRetries": 4 } }),
		)

		expect(state.requestTimeoutMs).toBe(120_000)
		expect(state.agentLimitSettings).toEqual({ "tool.readLines": 500, "api.maxRetries": 4 })
		expect(mocks.handleAgentLimitsChanged).toHaveBeenCalledOnce()
	})

	it("clears requestTimeoutMs when the response timeout is reset", async () => {
		const { controller, state } = makeController({ requestTimeoutMs: 120_000 })

		await updateSettings(controller, UpdateSettingsRequest.create({ agentLimitUpdates: { "api.requestTimeout": -1 } }))

		expect(state.requestTimeoutMs).toBeUndefined()
	})
})
