import { describe, expect, it, vi } from "vitest"
import { SdkSessionConfigBuilder } from "./sdk-session-config-builder"

const mocks = vi.hoisted(() => ({
	buildSessionConfig: vi.fn(),
	buildAgentHooks: vi.fn(() => ({})),
}))

vi.mock("./cline-session-factory", () => ({
	buildSessionConfig: mocks.buildSessionConfig,
}))

vi.mock("./hooks-adapter", () => ({
	buildAgentHooks: mocks.buildAgentHooks,
}))

/** `hookEngine` is the stored "session.hookEngine" choice: 0 SDK, 1 legacy. */
function stateManagerWith(hookEngine?: number) {
	return {
		getGlobalSettingsKey: vi.fn(() => undefined),
		getGlobalStateKey: vi.fn((key: string) =>
			key === "agentLimitSettings" && hookEngine !== undefined ? { "session.hookEngine": hookEngine } : undefined,
		),
	}
}

describe("SdkSessionConfigBuilder", () => {
	it("never exposes a switch_to_act_mode tool, even in plan mode", async () => {
		// Matches the legacy extension: the model cannot switch plan -> act
		// itself; the user must flip the Plan/Act toggle.
		const builder = new SdkSessionConfigBuilder({
			stateManager: stateManagerWith() as never,
			emitHookMessage: vi.fn(),
		})

		mocks.buildSessionConfig.mockResolvedValueOnce({
			extraTools: [],
			hooks: {},
		})
		const planConfig = await builder.build({ cwd: "/workspace", mode: "plan" })
		expect(planConfig.extraTools?.some((tool) => tool.name === "switch_to_act_mode")).toBe(false)

		mocks.buildSessionConfig.mockResolvedValueOnce({
			extraTools: [],
			hooks: {},
		})
		const actConfig = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(actConfig.extraTools?.some((tool) => tool.name === "switch_to_act_mode")).toBe(false)
	})

	it("wires the legacy agent hooks into the SDK config with the legacy hook engine", async () => {
		const hooks = { beforeModel: vi.fn() }
		mocks.buildAgentHooks.mockReturnValueOnce(hooks)
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })

		const builder = new SdkSessionConfigBuilder({
			stateManager: stateManagerWith(1) as never,
			emitHookMessage: vi.fn(),
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(config.hooks).toBe(hooks)
		expect(config.onHookRun).toBeUndefined()
	})

	it("reports SDK hook runs as chips with the SDK hook engine", async () => {
		mocks.buildAgentHooks.mockClear()
		mocks.buildSessionConfig.mockResolvedValueOnce({})
		const emitHookMessage = vi.fn()
		const builder = new SdkSessionConfigBuilder({
			stateManager: stateManagerWith(0) as never,
			emitHookMessage,
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(mocks.buildAgentHooks).not.toHaveBeenCalled()
		const event = { executionId: "e1", hookName: "PreToolUse", source: "/h", toolName: "read_files" }
		config.onHookRun?.({ ...event, status: "running" })
		config.onHookRun?.({ ...event, status: "completed", durationMs: 3 })
		const [[running], [completed]] = emitHookMessage.mock.calls
		expect(completed.ts).toBe(running.ts)
		expect(JSON.parse(completed.text)).toEqual({ hookName: "PreToolUse", toolName: "read_files", status: "completed" })
	})

	it("passes the mistake-limit callback into the SDK config without overriding SDK execution defaults", async () => {
		const onConsecutiveMistakeLimitReached = vi.fn()
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, execution: { maxRetries: 1 } })

		const builder = new SdkSessionConfigBuilder({
			stateManager: stateManagerWith() as never,
			emitHookMessage: vi.fn(),
			onConsecutiveMistakeLimitReached,
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })

		expect(config.execution).toEqual({ maxRetries: 1 })
		expect(config.onConsecutiveMistakeLimitReached).toBe(onConsecutiveMistakeLimitReached)
	})
})
