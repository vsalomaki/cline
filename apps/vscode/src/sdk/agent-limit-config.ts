import {
	type ContextLimitOverrides,
	type CoreSessionConfig,
	type CoreToolTimeouts,
	getContextLimitEnvSources,
	type MessageContextLimits,
	resolveContextLimits,
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

export type AgentLimitSessionConfig = Pick<CoreSessionConfig, "contextLimits" | "toolTimeouts" | "execution"> & {
	compaction?: Pick<NonNullable<CoreSessionConfig["compaction"]>, "triggerRatio" | "preserveRecentTokens">
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
