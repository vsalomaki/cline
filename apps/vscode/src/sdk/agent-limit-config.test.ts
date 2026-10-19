import type * as CoreContextLimits from "@cline/core"
import path from "path"
import { describe, expect, it } from "vitest"
import { AGENT_LIMIT_DEFINITIONS, type AgentLimitDefinition } from "@/shared/AgentLimits"
import {
	buildAgentLimitSessionConfig,
	getAgentLimitsState,
	readAgentLimitValues,
	toContextLimitOverrides,
} from "./agent-limit-config"

describe("AGENT_LIMIT_DEFINITIONS", () => {
	it("matches the SDK's context limit defaults and env var names", async () => {
		// @cline/core is stubbed in unit tests, so load the real module by path.
		// A static import would pull SDK source into the tsc program.
		const realModulePath = path.resolve(import.meta.dirname, "../../../../sdk/packages/core/src/settings/context-limits.ts")
		const { DEFAULT_CONTEXT_LIMITS, MESSAGE_LIMIT_ENV, TOOL_LIMIT_ENV } = (await import(
			/* @vite-ignore */ realModulePath
		)) as Pick<typeof CoreContextLimits, "DEFAULT_CONTEXT_LIMITS" | "MESSAGE_LIMIT_ENV" | "TOOL_LIMIT_ENV">
		for (const definition of AGENT_LIMIT_DEFINITIONS as readonly AgentLimitDefinition[]) {
			const [scope, key] = definition.id.split(".")
			if (scope === "tool") {
				const toolKey = key as keyof typeof TOOL_LIMIT_ENV
				expect(definition.default).toBe(DEFAULT_CONTEXT_LIMITS.tool[toolKey])
				expect(definition.envVar).toBe(TOOL_LIMIT_ENV[toolKey])
			} else if (scope === "message") {
				const messageKey = key as keyof typeof MESSAGE_LIMIT_ENV
				expect(definition.default).toBe(DEFAULT_CONTEXT_LIMITS.message[messageKey])
				expect(definition.envVar).toBe(MESSAGE_LIMIT_ENV[messageKey])
			}
		}
		const contextIds = AGENT_LIMIT_DEFINITIONS.filter((d) => d.id.startsWith("tool.") || d.id.startsWith("message."))
		expect(contextIds).toHaveLength(
			Object.keys(DEFAULT_CONTEXT_LIMITS.tool).length + Object.keys(DEFAULT_CONTEXT_LIMITS.message).length,
		)
	})

	it("matches the SDK's tool-call defaults and env var names", async () => {
		const realModulePath = path.resolve(import.meta.dirname, "../../../../sdk/packages/core/src/settings/tool-calls.ts")
		const { DEFAULT_MAX_PARALLEL_TOOL_CALLS, TOOL_CALL_ENV } = (await import(/* @vite-ignore */ realModulePath)) as Pick<
			typeof CoreContextLimits,
			"DEFAULT_MAX_PARALLEL_TOOL_CALLS" | "TOOL_CALL_ENV"
		>
		const byId = new Map<string, AgentLimitDefinition>(AGENT_LIMIT_DEFINITIONS.map((d) => [d.id, d]))
		expect(byId.get("session.maxParallelToolCalls")).toMatchObject({
			default: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
			envVar: TOOL_CALL_ENV.maxParallelToolCalls,
		})
		expect(byId.get("api.parallelToolCalls")).toMatchObject({ default: 1, envVar: TOOL_CALL_ENV.parallelToolCalls })
		expect(byId.get("session.readBeforeWrite")).toMatchObject({ default: 1, envVar: TOOL_CALL_ENV.readBeforeWrite })
		expect(byId.get("session.reviewBeforeFinish")).toMatchObject({ default: 1, envVar: TOOL_CALL_ENV.reviewBeforeFinish })
		expect(byId.get("session.nestedSubagents")).toMatchObject({ default: 0, envVar: TOOL_CALL_ENV.nestedSubagents })
	})

	it("matches the SDK's code-intelligence defaults and env var names", async () => {
		const realModulePath = path.resolve(
			import.meta.dirname,
			"../../../../sdk/packages/core/src/settings/code-intelligence.ts",
		)
		const { CODE_INTELLIGENCE_ENV, DEFAULT_PROBLEMS_AFTER_EDIT, DEFAULT_PROBLEMS_TIMEOUT_MS } = (await import(
			/* @vite-ignore */ realModulePath
		)) as Pick<
			typeof CoreContextLimits,
			"CODE_INTELLIGENCE_ENV" | "DEFAULT_PROBLEMS_AFTER_EDIT" | "DEFAULT_PROBLEMS_TIMEOUT_MS"
		>
		const byId = new Map<string, AgentLimitDefinition>(AGENT_LIMIT_DEFINITIONS.map((d) => [d.id, d]))
		expect(byId.get("session.codeIntelligenceTool")).toMatchObject({
			default: 1,
			envVar: CODE_INTELLIGENCE_ENV.codeIntelligenceTool,
		})
		const choice = byId.get("session.problemsAfterEdit")
		expect(choice?.envVar).toBe(CODE_INTELLIGENCE_ENV.problemsAfterEdit)
		expect(buildAgentLimitSessionConfig({ "session.problemsAfterEdit": choice?.default }).problemsAfterEdit).toBe(
			DEFAULT_PROBLEMS_AFTER_EDIT,
		)
		expect(byId.get("session.problemsTimeout")).toMatchObject({
			default: DEFAULT_PROBLEMS_TIMEOUT_MS,
			envVar: CODE_INTELLIGENCE_ENV.problemsTimeoutMs,
		})
	})
})

describe("buildAgentLimitSessionConfig", () => {
	it("leaves everything to the SDK when nothing is set", () => {
		expect(buildAgentLimitSessionConfig(undefined)).toEqual({})
	})

	it("maps each group onto session config", () => {
		const config = buildAgentLimitSessionConfig({
			"tool.readLines": 500,
			"message.toolResultChars": 80_000,
			"timeout.ripgrep": 20_000,
			"timeout.editor": 60_000,
			"session.maxConsecutiveMistakes": 10,
			"session.loopSoftThreshold": 4,
			"compaction.triggerPercent": 75,
			"compaction.preserveRecentTokens": 40_000,
		})

		expect(config).toEqual({
			contextLimits: { tool: { readLines: 500 }, message: { toolResultChars: 80_000 } },
			toolTimeouts: { ripgrepTimeoutMs: 20_000, editorTimeoutMs: 60_000 },
			execution: { maxConsecutiveMistakes: 10, loopDetection: { softThreshold: 4, hardThreshold: 5 } },
			compaction: { triggerRatio: 0.75, preserveRecentTokens: 40_000 },
		})
	})

	it("keeps the stop threshold above the warning threshold", () => {
		const config = buildAgentLimitSessionConfig({ "session.loopSoftThreshold": 8, "session.loopHardThreshold": 5 })

		expect(config.execution?.loopDetection).toEqual({ softThreshold: 8, hardThreshold: 9 })
	})

	it("maps the Model API limits onto the provider config", () => {
		const config = buildAgentLimitSessionConfig({ "api.requestTimeout": 60_000, "api.maxRetries": 0 })

		expect(config).toEqual({ providerConfig: { timeoutMs: 60_000, maxRetries: 0 } })
	})

	it("maps the tool-call settings onto top-level session options", () => {
		expect(buildAgentLimitSessionConfig({ "session.maxParallelToolCalls": 1, "api.parallelToolCalls": 0 })).toEqual({
			maxParallelToolCalls: 1,
			parallelToolCalls: false,
		})
		expect(buildAgentLimitSessionConfig({ "api.parallelToolCalls": 1 })).toEqual({ parallelToolCalls: true })
		expect(buildAgentLimitSessionConfig({ "session.readBeforeWrite": 0 })).toEqual({ readBeforeWrite: false })
		expect(buildAgentLimitSessionConfig({ "session.reviewBeforeFinish": 0 })).toEqual({ reviewBeforeFinish: false })
		expect(buildAgentLimitSessionConfig({ "session.nestedSubagents": 1 })).toEqual({ nestedSubagents: true })
	})

	it("maps the code-intelligence tool switch", () => {
		expect(buildAgentLimitSessionConfig({ "session.codeIntelligenceTool": 0 })).toEqual({ codeIntelligenceTool: false })
		expect(buildAgentLimitSessionConfig({ "session.codeIntelligenceTool": 1 })).toEqual({ codeIntelligenceTool: true })
	})

	it("maps the problems-after-edit choice and wait", () => {
		expect(buildAgentLimitSessionConfig({ "session.problemsAfterEdit": 0 })).toEqual({ problemsAfterEdit: "off" })
		expect(buildAgentLimitSessionConfig({ "session.problemsAfterEdit": 1 })).toEqual({ problemsAfterEdit: "errors" })
		expect(buildAgentLimitSessionConfig({ "session.problemsAfterEdit": 2, "session.problemsTimeout": 0 })).toEqual({
			problemsAfterEdit: "warnings",
			problemsTimeoutMs: 0,
		})
		expect(buildAgentLimitSessionConfig({ "session.problemsAfterEdit": 7 })).toEqual({})
	})

	it("turns loop detection off", () => {
		const config = buildAgentLimitSessionConfig({ "session.loopDetection": 0, "session.loopSoftThreshold": 4 })

		expect(config.execution?.loopDetection).toBe(false)
	})
})

describe("readAgentLimitValues", () => {
	it("reads the response timeout from the requestTimeoutMs setting", () => {
		expect(readAgentLimitValues({ "tool.readLines": 500 }, 120_000)).toEqual({
			"tool.readLines": 500,
			"api.requestTimeout": 120_000,
		})
		expect(readAgentLimitValues(undefined, undefined)).toEqual({})
		expect(readAgentLimitValues(undefined, 0)).toEqual({})
	})
})

describe("toContextLimitOverrides", () => {
	it("ignores non-context ids", () => {
		expect(toContextLimitOverrides({ "timeout.hook": 5_000 })).toEqual({})
	})
})

describe("getAgentLimitsState", () => {
	it("reports set values with defaults filled in as effective values", () => {
		const state = getAgentLimitsState({ "tool.readLines": 500, "timeout.hook": 60_000 }, {})

		expect(state.values).toEqual({ "tool.readLines": 500, "timeout.hook": 60_000 })
		expect(state.effective["tool.readLines"]).toBe(500)
		expect(state.effective["timeout.hook"]).toBe(60_000)
		expect(state.effective["session.maxConsecutiveMistakes"]).toBe(6)
		expect(state.effective["session.codeIntelligenceTool"]).toBe(1)
		expect(state.effective["session.problemsAfterEdit"]).toBe(1)
		expect(state.effective["session.problemsTimeout"]).toBe(3_000)
		expect(state.envOverrides).toEqual({})
	})

	it("reports the problems-after-edit choice as its stored number", () => {
		const state = getAgentLimitsState({ "session.problemsAfterEdit": 2, "session.problemsTimeout": 5_000 }, {})

		expect(state.effective["session.problemsAfterEdit"]).toBe(2)
		expect(state.effective["session.problemsTimeout"]).toBe(5_000)
	})
})
