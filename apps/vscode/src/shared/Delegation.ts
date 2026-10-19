/** How the agent hands work to other agents: not at all, to subagents it waits for, or to a team running in the background. */
export type DelegationMode = "off" | "subagents" | "teams"

/** Agent teams include subagents, so teams win when both are on. */
export function resolveDelegationMode(settings: { subagentsEnabled?: boolean; agentTeamsEnabled?: boolean }): DelegationMode {
	if (settings.agentTeamsEnabled) {
		return "teams"
	}
	return settings.subagentsEnabled ? "subagents" : "off"
}
