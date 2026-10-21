/**
 * What one model request's input was made of, in estimate units. Hosts turn it
 * into provider tokens with {@link scaleContextUsage} and the same request's
 * `inputTokens`.
 */
export interface ContextUsageSnapshot {
	/** Sum of every category. */
	estimatedTotal: number;
	categories: ContextUsageCategories;
	/** Provider tokens the request may use. */
	windowTokens: number;
	/** Provider tokens at which auto-compaction starts; absent when it is off. */
	compactAtTokens?: number;
}

export interface ContextUsageCategories {
	systemPrompt: number;
	rules: ContextUsageRule[];
	memory: number;
	tools: {
		builtin: number;
		extension: number;
		mcp: ContextUsageMcpServer[];
	};
	messages: {
		conversation: number;
		toolCalls: number;
		toolResults: number;
		filesAndImages: number;
		summary: number;
	};
}

export interface ContextUsageRule {
	id: string;
	source?: string;
	tokens: number;
	/** The rule files it was built from; part of `tokens`, not added to it. */
	files?: { name: string; tokens: number }[];
}

export interface ContextUsageMcpServer {
	server: string;
	tokens: number;
}

/** The snapshot in provider tokens, given the request's provider input count. */
export function scaleContextUsage(
	snapshot: ContextUsageSnapshot,
	inputTokens: number,
): ContextUsageSnapshot {
	const ratio =
		snapshot.estimatedTotal > 0 ? inputTokens / snapshot.estimatedTotal : 0;
	const scale = (tokens: number) => Math.round(tokens * ratio);
	const { categories } = snapshot;
	return {
		...snapshot,
		estimatedTotal: inputTokens,
		categories: {
			systemPrompt: scale(categories.systemPrompt),
			rules: categories.rules.map((rule) => ({
				...rule,
				tokens: scale(rule.tokens),
				...(rule.files
					? {
							files: rule.files.map((file) => ({
								...file,
								tokens: scale(file.tokens),
							})),
						}
					: {}),
			})),
			memory: scale(categories.memory),
			tools: {
				builtin: scale(categories.tools.builtin),
				extension: scale(categories.tools.extension),
				mcp: categories.tools.mcp.map((entry) => ({
					...entry,
					tokens: scale(entry.tokens),
				})),
			},
			messages: {
				conversation: scale(categories.messages.conversation),
				toolCalls: scale(categories.messages.toolCalls),
				toolResults: scale(categories.messages.toolResults),
				filesAndImages: scale(categories.messages.filesAndImages),
				summary: scale(categories.messages.summary),
			},
		},
	};
}
