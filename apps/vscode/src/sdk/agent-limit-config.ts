import {
	type ContextLimitOverrides,
	type CoreSessionConfig,
	type CoreToolTimeouts,
	getContextLimitEnvSources,
	getToolCallEnvSources,
	type MessageContextLimits,
	resolveContextLimits,
	resolveToolCallSettings,
	type ToolContextLimits,
} from "@cline/core"
import {
	AGENT_LIMIT_DEFINITIONS,
	type AgentLimitId,
	type AgentLimitsState,
	type AgentLimitValues,
	getAgentLimitValue,
} from "@/shared/AgentLimits"

const TIMEOUT_FIELDS = {
	"timeout.fileRead": "fileReadTimeoutMs",
	"timeout.search": "searchTimeoutMs",
	"timeout.ripgrep": "ripgrepTimeoutMs",
	"timeout.webFetch": "webFetchTimeoutMs",
	"timeout.editor": "editorTimeoutMs",
	"timeout.applyPatch": "applyPatchTimeoutMs",
} as const satisfies Partial<Record<AgentLimitId, keyof CoreToolTimeouts>>

export type AgentLimitSessionConfig = Pick<
	CoreSessionConfig,
	"contextLimits" | "toolTimeouts" | "execution" | "maxParallelToolCalls" | "parallelToolCalls" | "readBeforeWrite"
> & {
	compaction?: Pick<NonNullable<CoreSessionConfig["compaction"]>, "triggerRatio" | "preserveRecentTokens">
	providerConfig?: { timeoutMs?: number; maxRetries?: number }
}

/** Joins the two places agent limits are stored into one set of values. */
export function readAgentLimitValues(
	agentLimitSettings: AgentLimitValues | undefined,
	requestTimeoutMs: number | undefined,
): AgentLimitValues {
	return {
		...agentLimitSettings,
		...(typeof requestTimeoutMs === "number" && requestTimeoutMs > 0 ? { "api.requestTimeout": requestTimeoutMs } : {}),
	}
}

export function toContextLimitOverrides(values: AgentLimitValues | undefined): ContextLimitOverrides {
	const tool: Partial<ToolContextLimits> = {}
	const message: Partial<MessageContextLimits> = {}
	for (const [id, value] of Object.entries(values ?? {})) {
		if (value === undefined) {
			continue
		}
		if (id.startsWith("tool.")) {
			tool[id.slice("tool.".length) as keyof ToolContextLimits] = value
		} else if (id.startsWith("message.")) {
			message[id.slice("message.".length) as keyof MessageContextLimits] = value
		}
	}
	return {
		...(Object.keys(tool).length > 0 ? { tool } : {}),
		...(Object.keys(message).length > 0 ? { message } : {}),
	}
}

/** Maps the stored settings onto session config, leaving unset limits to the SDK defaults. */
export function buildAgentLimitSessionConfig(values: AgentLimitValues | undefined): AgentLimitSessionConfig {
	const config: AgentLimitSessionConfig = {}

	const contextLimits = toContextLimitOverrides(values)
	if (contextLimits.tool || contextLimits.message) {
		config.contextLimits = contextLimits
	}

	const toolTimeouts: CoreToolTimeouts = {}
	for (const [id, field] of Object.entries(TIMEOUT_FIELDS) as Array<[AgentLimitId, keyof CoreToolTimeouts]>) {
		const value = values?.[id]
		if (value !== undefined) {
			toolTimeouts[field] = value
		}
	}
	if (Object.keys(toolTimeouts).length > 0) {
		config.toolTimeouts = toolTimeouts
	}

	if (values?.["session.maxParallelToolCalls"] !== undefined) {
		config.maxParallelToolCalls = values["session.maxParallelToolCalls"]
	}
	if (values?.["api.parallelToolCalls"] !== undefined) {
		config.parallelToolCalls = values["api.parallelToolCalls"] !== 0
	}
	if (values?.["session.readBeforeWrite"] !== undefined) {
		config.readBeforeWrite = values["session.readBeforeWrite"] !== 0
	}

	const execution: NonNullable<CoreSessionConfig["execution"]> = {}
	if (values?.["session.maxConsecutiveMistakes"] !== undefined) {
		execution.maxConsecutiveMistakes = values["session.maxConsecutiveMistakes"]
	}
	if (values?.["session.loopDetection"] === 0) {
		execution.loopDetection = false
	} else if (values?.["session.loopSoftThreshold"] !== undefined || values?.["session.loopHardThreshold"] !== undefined) {
		const softThreshold = getAgentLimitValue(values, "session.loopSoftThreshold")
		const hardThreshold = Math.max(getAgentLimitValue(values, "session.loopHardThreshold"), softThreshold + 1)
		execution.loopDetection = { softThreshold, hardThreshold }
	}
	if (Object.keys(execution).length > 0) {
		config.execution = execution
	}

	const compaction: NonNullable<AgentLimitSessionConfig["compaction"]> = {}
	if (values?.["compaction.triggerPercent"] !== undefined) {
		compaction.triggerRatio = values["compaction.triggerPercent"] / 100
	}
	if (values?.["compaction.preserveRecentTokens"] !== undefined) {
		compaction.preserveRecentTokens = values["compaction.preserveRecentTokens"]
	}
	if (Object.keys(compaction).length > 0) {
		config.compaction = compaction
	}

	const providerConfig: NonNullable<AgentLimitSessionConfig["providerConfig"]> = {}
	if (values?.["api.requestTimeout"] !== undefined) {
		providerConfig.timeoutMs = values["api.requestTimeout"]
	}
	if (values?.["api.maxRetries"] !== undefined) {
		providerConfig.maxRetries = values["api.maxRetries"]
	}
	if (Object.keys(providerConfig).length > 0) {
		config.providerConfig = providerConfig
	}

	return config
}

/** The tool caps a session built from these settings enforces. */
export function resolveAgentToolLimits(values: AgentLimitValues | undefined): ToolContextLimits {
	return resolveContextLimits(toContextLimitOverrides(values)).tool
}

export function getAgentLimitsState(
	values: AgentLimitValues | undefined,
	env: Record<string, string | undefined> = process.env,
): AgentLimitsState {
	const resolved = resolveContextLimits(toContextLimitOverrides(values), env)
	const envSources = getContextLimitEnvSources(env)
	const sessionConfig = buildAgentLimitSessionConfig(values)
	const toolCalls = resolveToolCallSettings(sessionConfig, env)
	const toolCallEnvSources = getToolCallEnvSources(env)
	const effective: AgentLimitsState["effective"] = {}
	const envOverrides: AgentLimitsState["envOverrides"] = {}

	for (const definition of AGENT_LIMIT_DEFINITIONS) {
		const [scope, key] = definition.id.split(".") as [string, string]
		if (scope === "tool") {
			effective[definition.id] = resolved.tool[key as keyof ToolContextLimits]
			const source = envSources.tool[key as keyof ToolContextLimits]
			if (source) {
				envOverrides[definition.id] = source
			}
		} else if (scope === "message") {
			effective[definition.id] = resolved.message[key as keyof MessageContextLimits]
			const source = envSources.message[key as keyof MessageContextLimits]
			if (source) {
				envOverrides[definition.id] = source
			}
		} else {
			effective[definition.id] = getAgentLimitValue(values, definition.id)
		}
	}
	effective["session.maxParallelToolCalls"] = toolCalls.maxParallelToolCalls
	effective["api.parallelToolCalls"] = toolCalls.parallelToolCalls ? 1 : 0
	effective["session.readBeforeWrite"] = toolCalls.readBeforeWrite ? 1 : 0
	if (toolCallEnvSources.maxParallelToolCalls) {
		envOverrides["session.maxParallelToolCalls"] = toolCallEnvSources.maxParallelToolCalls
	}
	if (toolCallEnvSources.parallelToolCalls) {
		envOverrides["api.parallelToolCalls"] = toolCallEnvSources.parallelToolCalls
	}
	if (toolCallEnvSources.readBeforeWrite) {
		envOverrides["session.readBeforeWrite"] = toolCallEnvSources.readBeforeWrite
	}
	const soft = getAgentLimitValue(values, "session.loopSoftThreshold")
	if (getAgentLimitValue(values, "session.loopHardThreshold") <= soft) {
		effective["session.loopHardThreshold"] = soft + 1
	}
	for (const [id, value] of Object.entries(effective)) {
		if (!Number.isFinite(value)) {
			delete effective[id as AgentLimitId]
		}
	}

	return { values: values ?? {}, effective, envOverrides }
}
