import type { LastContextUsage } from "./getApiMetrics"

export type ContextUsageCategoryId = "system" | "rules" | "memory" | "tools" | "messages" | "files"

export interface ContextUsageItem {
	id: string
	label: string
	tokens: number
}

export interface ContextUsageCategory extends ContextUsageItem {
	id: ContextUsageCategoryId
	/** Shown when the row is expanded. */
	items: ContextUsageItem[]
}

export interface ContextUsageView {
	/** The request's provider input tokens, rescaled by compactions completed since. */
	usedTokens: number
	windowTokens: number
	freeTokens: number
	compactAtTokens?: number
	/** Categories with tokens, in display order; their tokens add up to the request's input give or take rounding. */
	categories: ContextUsageCategory[]
	compactedAfter: boolean
}

/** The breakdown in provider tokens: each category scaled by the request's input tokens over the estimate. */
export function buildContextUsageView({ snapshot, inputTokens, usedTokens, compactedAfter }: LastContextUsage): ContextUsageView {
	const ratio = snapshot.estimatedTotal > 0 ? inputTokens / snapshot.estimatedTotal : 0
	const scale = (tokens: number) => Math.round(tokens * ratio)
	const item = (id: string, label: string, tokens: number): ContextUsageItem => ({ id, label, tokens: scale(tokens) })
	const { rules, tools, messages } = snapshot.categories

	const ruleItems = rules.flatMap((rule) =>
		rule.files?.length
			? rule.files.map((file) => item(`rule:${rule.id}:${file.name}`, file.name, file.tokens))
			: [item(`rule:${rule.id}`, rule.id, rule.tokens)],
	)
	const toolItems = [
		item("tools:builtin", "Built-in", tools.builtin),
		item("tools:extension", "Extensions", tools.extension),
		...tools.mcp.map((entry) => item(`tools:mcp:${entry.server}`, `MCP: ${entry.server}`, entry.tokens)),
	]
	const messageItems = [
		item("messages:conversation", "Conversation", messages.conversation),
		item("messages:tool-calls", "Tool calls", messages.toolCalls),
		item("messages:tool-results", "Tool results", messages.toolResults),
		item("messages:summary", "Compaction summary", messages.summary),
	]
	const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
	const category = (
		id: ContextUsageCategoryId,
		label: string,
		tokens: number,
		items: ContextUsageItem[] = [],
	): ContextUsageCategory => ({ id, label, tokens, items: items.filter((entry) => entry.tokens > 0) })
	const scaledRules = rules.map((rule) => scale(rule.tokens))

	// Scale the parts and add them up, so a category matches its rows and the CLI's /context.
	const categories = [
		category("system", "System prompt", scale(snapshot.categories.systemPrompt)),
		category("rules", "Rules", sum(scaledRules), ruleItems),
		category("memory", "Memory", scale(snapshot.categories.memory)),
		category("tools", "Tools", sum(toolItems.map((entry) => entry.tokens)), toolItems),
		category("messages", "Messages", sum(messageItems.map((entry) => entry.tokens)), messageItems),
		category("files", "Files and images", scale(messages.filesAndImages)),
	].filter((entry) => entry.tokens > 0)

	return {
		usedTokens,
		windowTokens: snapshot.windowTokens,
		freeTokens: Math.max(0, snapshot.windowTokens - inputTokens),
		...(snapshot.compactAtTokens === undefined ? {} : { compactAtTokens: snapshot.compactAtTokens }),
		categories,
		compactedAfter,
	}
}

/** Share of the window, e.g. "4.2%" below ten percent and "42%" above. */
export function formatWindowShare(tokens: number, windowTokens: number): string {
	const share = windowTokens > 0 ? (tokens / windowTokens) * 100 : 0
	return `${share < 10 ? share.toFixed(1) : Math.round(share)}%`
}
