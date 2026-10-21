import type { AgentEvent, LastContextUsage } from "@cline/core";

/** The lead's request breakdown, when the event carries one. */
export function contextUsageFromEvent(
	event: Extract<AgentEvent, { type: "usage" }>,
): LastContextUsage | undefined {
	return event.contextUsage && !event.parentAgentId
		? {
				snapshot: event.contextUsage,
				inputTokens: event.inputTokens,
				compactedAfter: false,
			}
		: undefined;
}

export function formatContextPercent(used: number, total: number): string {
	return `${Math.round((used / total) * 100)}%`;
}

/** "context 12,345 of 200,000 (6%)" */
export function formatContextUsageStat(usage: LastContextUsage): string {
	const window = usage.snapshot.windowTokens;
	return `context ${usage.inputTokens.toLocaleString()} of ${window.toLocaleString()} (${formatContextPercent(usage.inputTokens, window)})`;
}
