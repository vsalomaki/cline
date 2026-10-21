import type { LastContextUsage } from "@cline/core";
import { scaleContextUsage } from "@cline/shared";
import { formatContextPercent } from "../../../utils/context-usage";
import { createContextBar, resolveCompactionMarker } from "../status-bar";

const BAR_WIDTH = 40;

export interface ContextUsageRow {
	id: string;
	label: string;
	tokens: number;
	/** Share of the window, e.g. "4.2%". */
	share: string;
	sub?: boolean;
}

export interface ContextUsageView {
	summary: string;
	/** Set while the breakdown describes the request before a compaction. */
	note?: string;
	bar: { filled: string; empty: string; markerOffset?: number };
	rows: ContextUsageRow[];
	compaction: string;
}

function formatShare(tokens: number, window: number): string {
	const share = window > 0 ? (tokens / window) * 100 : 0;
	return `${share < 10 ? share.toFixed(1) : Math.round(share)}%`;
}

/** What /context shows, in provider tokens. */
export function buildContextUsageView(
	usage: LastContextUsage,
): ContextUsageView {
	const window = usage.snapshot.windowTokens;
	const used = usage.inputTokens;
	const { categories } = scaleContextUsage(usage.snapshot, used);
	const rows: ContextUsageRow[] = [];
	const add = (id: string, label: string, tokens: number, sub = false) => {
		if (sub && tokens <= 0) return;
		rows.push({ id, label, tokens, share: formatShare(tokens, window), sub });
	};

	add("system", "System prompt", categories.systemPrompt);
	add(
		"rules",
		"Rules",
		categories.rules.reduce((sum, rule) => sum + rule.tokens, 0),
	);
	for (const rule of categories.rules) {
		if (rule.files?.length) {
			for (const file of rule.files) {
				add(`rule:${rule.id}:${file.name}`, file.name, file.tokens, true);
			}
		} else {
			add(`rule:${rule.id}`, rule.id, rule.tokens, true);
		}
	}
	add("memory", "Memory", categories.memory);
	const { tools, messages } = categories;
	add(
		"tools",
		"Tools",
		tools.builtin +
			tools.extension +
			tools.mcp.reduce((sum, entry) => sum + entry.tokens, 0),
	);
	add("tools:builtin", "Built-in", tools.builtin, true);
	add("tools:extension", "Extensions", tools.extension, true);
	for (const entry of tools.mcp) {
		add(
			`tools:mcp:${entry.server}`,
			`MCP: ${entry.server}`,
			entry.tokens,
			true,
		);
	}
	add(
		"messages",
		"Messages",
		messages.conversation +
			messages.toolCalls +
			messages.toolResults +
			messages.filesAndImages +
			messages.summary,
	);
	add("messages:conversation", "Conversation", messages.conversation, true);
	add("messages:tool-calls", "Tool calls", messages.toolCalls, true);
	add("messages:tool-results", "Tool results", messages.toolResults, true);
	add("messages:files", "Files and images", messages.filesAndImages, true);
	add("messages:summary", "Compaction summary", messages.summary, true);
	add("free", "Free space", Math.max(0, window - used));

	const bar = createContextBar(used, window, BAR_WIDTH);
	const marker = resolveCompactionMarker(
		bar.filled.length,
		window,
		usage.snapshot.compactAtTokens,
		BAR_WIDTH,
	);
	const compactAt = usage.snapshot.compactAtTokens;
	return {
		summary: `${used.toLocaleString()} of ${window.toLocaleString()} tokens (${formatContextPercent(used, window)})`,
		...(usage.compactedAfter
			? {
					note: "Last request before the context was compacted; the next request updates it.",
				}
			: {}),
		bar: {
			...bar,
			...(marker === undefined
				? {}
				: { markerOffset: marker - bar.filled.length }),
		},
		rows,
		compaction:
			compactAt === undefined
				? "Auto-compaction is off"
				: `Compacts at ${compactAt.toLocaleString()} tokens (${formatContextPercent(compactAt, window)})`,
	};
}
