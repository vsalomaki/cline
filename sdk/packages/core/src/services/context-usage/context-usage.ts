import {
	type AgentMessage,
	type AgentToolDefinition,
	type ContextUsageMcpServer,
	type ContextUsageRule,
	type ContextUsageSnapshot,
	ESTIMATED_TOKENS_PER_IMAGE,
	estimateTokens,
} from "@cline/shared";

export interface ComposedPromptRule {
	id: string;
	source?: string;
	chars: number;
	files?: ReadonlyArray<{ name: string; chars: number }>;
}

/** A system prompt and the rules that were appended to build it. */
export interface ComposedSystemPrompt {
	text: string;
	rules: ComposedPromptRule[];
}

export type ContextUsageToolOrigin = "builtin" | "extension" | { mcp: string };

export interface ContextUsageRequest {
	systemPrompt: string | undefined;
	composedPrompt: ComposedSystemPrompt;
	messages: readonly AgentMessage[];
	tools: readonly AgentToolDefinition[];
	toolOrigins: ReadonlyMap<string, ContextUsageToolOrigin>;
	windowTokens: number;
	/** Absent when auto-compaction is off. */
	compactionTriggerRatio?: number;
}

const MEMORY_RULE_SOURCE = "memory";
const COMPACTION_SUMMARY_PREFIX = "Context summary:";

interface Size {
	chars: number;
	images: number;
}

function tokensFor(size: Size): number {
	return (
		(size.chars > 0 ? estimateTokens(size.chars) : 0) +
		size.images * ESTIMATED_TOKENS_PER_IMAGE
	);
}

function charTokens(chars: number): number {
	return tokensFor({ chars, images: 0 });
}

/**
 * Splits model requests into context usage categories. Sizes of object
 * payloads (tool inputs, schemas, structured results) are cached by
 * reference, since those objects outlive the per-request message copies.
 */
export function createContextUsageMeter(): (
	request: ContextUsageRequest,
) => ContextUsageSnapshot {
	const jsonChars = new WeakMap<object, number>();
	const measureJson = (value: unknown): number => {
		if (value === null || typeof value !== "object") {
			return JSON.stringify(value)?.length ?? 0;
		}
		const cached = jsonChars.get(value);
		if (cached !== undefined) return cached;
		const chars = JSON.stringify(value)?.length ?? 0;
		jsonChars.set(value, chars);
		return chars;
	};

	const measureToolOutput = (value: unknown): Size => {
		if (typeof value === "string") return { chars: value.length, images: 0 };
		if (Array.isArray(value)) {
			const total = { chars: 0, images: 0 };
			for (const item of value) {
				const size = measureToolOutput(item);
				total.chars += size.chars;
				total.images += size.images;
			}
			return total;
		}
		const block = value as { type?: unknown; text?: unknown } | null;
		if (block?.type === "image") return { chars: 0, images: 1 };
		if (block?.type === "text" && typeof block.text === "string") {
			return { chars: block.text.length, images: 0 };
		}
		return { chars: measureJson(value), images: 0 };
	};

	const measureMessages = (messages: readonly AgentMessage[]) => {
		const conversation = { chars: 0, images: 0 };
		const toolCalls = { chars: 0, images: 0 };
		const toolResults = { chars: 0, images: 0 };
		const filesAndImages = { chars: 0, images: 0 };
		const summary = { chars: 0, images: 0 };
		for (const message of messages) {
			const first = message.content[0];
			const isSummary =
				first?.type === "text" &&
				first.text.startsWith(COMPACTION_SUMMARY_PREFIX);
			for (const part of message.content) {
				switch (part.type) {
					case "text":
					case "reasoning":
						(isSummary ? summary : conversation).chars += part.text.length;
						break;
					case "tool-call":
						toolCalls.chars += part.toolName.length + measureJson(part.input);
						break;
					case "tool-result": {
						const size = measureToolOutput(part.output);
						toolResults.chars += size.chars;
						filesAndImages.images += size.images;
						break;
					}
					case "image":
					case "media":
						(isSummary ? summary : filesAndImages).images += 1;
						break;
					case "file":
						(isSummary ? summary : filesAndImages).chars +=
							part.path.length + part.content.length;
						break;
				}
			}
		}
		return {
			conversation: tokensFor(conversation),
			toolCalls: tokensFor(toolCalls),
			toolResults: tokensFor(toolResults),
			filesAndImages: tokensFor(filesAndImages),
			summary: tokensFor(summary),
		};
	};

	const measureTools = (
		tools: readonly AgentToolDefinition[],
		origins: ReadonlyMap<string, ContextUsageToolOrigin>,
	) => {
		let builtin = 0;
		let extension = 0;
		const mcp = new Map<string, number>();
		for (const tool of tools) {
			const chars =
				tool.name.length +
				tool.description.length +
				measureJson(tool.inputSchema);
			const origin = origins.get(tool.name) ?? "builtin";
			if (origin === "builtin") builtin += chars;
			else if (origin === "extension") extension += chars;
			else mcp.set(origin.mcp, (mcp.get(origin.mcp) ?? 0) + chars);
		}
		return {
			builtin: charTokens(builtin),
			extension: charTokens(extension),
			mcp: [...mcp].map(
				([server, chars]): ContextUsageMcpServer => ({
					server,
					tokens: charTokens(chars),
				}),
			),
		};
	};

	const measureSystemPrompt = (
		systemPrompt: string,
		composed: ComposedSystemPrompt,
	) => {
		// A prompt swapped in after composing (saved compaction state) has no
		// known rule boundaries.
		if (systemPrompt !== composed.text) {
			return {
				systemPrompt: charTokens(systemPrompt.length),
				rules: [],
				memory: 0,
			};
		}
		let ruleChars = 0;
		let memoryChars = 0;
		const rules: ContextUsageRule[] = [];
		for (const rule of composed.rules) {
			ruleChars += rule.chars;
			if (rule.source === MEMORY_RULE_SOURCE) {
				memoryChars += rule.chars;
				continue;
			}
			rules.push({
				id: rule.id,
				...(rule.source ? { source: rule.source } : {}),
				tokens: charTokens(rule.chars),
				...(rule.files
					? {
							files: rule.files.map((file) => ({
								name: file.name,
								tokens: charTokens(file.chars),
							})),
						}
					: {}),
			});
		}
		return {
			systemPrompt: charTokens(Math.max(0, systemPrompt.length - ruleChars)),
			rules,
			memory: charTokens(memoryChars),
		};
	};

	return (request) => {
		const prompt = measureSystemPrompt(
			request.systemPrompt ?? "",
			request.composedPrompt,
		);
		const tools = measureTools(request.tools, request.toolOrigins);
		const messages = measureMessages(request.messages);
		const estimatedTotal =
			prompt.systemPrompt +
			prompt.rules.reduce((sum, rule) => sum + rule.tokens, 0) +
			prompt.memory +
			tools.builtin +
			tools.extension +
			tools.mcp.reduce((sum, entry) => sum + entry.tokens, 0) +
			Object.values(messages).reduce((sum, tokens) => sum + tokens, 0);
		return {
			estimatedTotal,
			categories: {
				systemPrompt: prompt.systemPrompt,
				rules: prompt.rules,
				memory: prompt.memory,
				tools,
				messages,
			},
			windowTokens: request.windowTokens,
			...(request.compactionTriggerRatio !== undefined
				? {
						compactAtTokens: Math.round(
							request.windowTokens * request.compactionTriggerRatio,
						),
					}
				: {}),
		};
	};
}
