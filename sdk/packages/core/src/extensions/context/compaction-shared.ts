import type { ModelInfo, ToolResultContent } from "@cline/llms";
import {
	CHARS_PER_TOKEN,
	createImageAwareReplacer,
	ESTIMATED_TOKENS_PER_IMAGE,
	estimateTokens,
	type MessageWithMetadata,
} from "@cline/shared";

export { CHARS_PER_TOKEN, estimateTokens };

import { getUserRunSpan } from "../../session/user-run-messages";
import type { CoreCompactionSummarizerConfig } from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";

export const DEFAULT_MAX_INPUT_TOKENS = 128_000;
/** Estimate the usable input share when only a context window is reported. */
export const CONTEXT_WINDOW_INPUT_RATIO = 0.9;
/** Compact once the transcript consumes this share of the usable input budget. */
export const COMPACTION_TRIGGER_RATIO = 0.9;
/**
 * Upper bound on how far the provider's actual input count may scale the
 * compaction budget down relative to the character-based estimate. Dense
 * content realistically tokenizes ~2-3x denser than the 3-chars-per-token
 * assumption; the cap stops a pathologically small estimate from collapsing
 * the budget and compacting every turn.
 */
export const MAX_INPUT_UNDERESTIMATE_FACTOR = 4;
export const DEFAULT_TARGET_RATIO = 0.7;
export const DEFAULT_PRESERVE_RECENT_TOKENS = 60_000;
// Headroom for the summarizer's output. Raised from 4096: models that reason
// by default can spend part of a tight budget on thinking and return no
// summary text at all, which skips compaction entirely. 8192 leaves room for a
// real summary even when some reasoning slips through.
export const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 8_192;
/** Per-block character cap on tool results, file contents and thinking in the summarizer input. */
export const DEFAULT_SUMMARY_BLOCK_CHARS = 8_000;
export const MIN_TRUNCATED_MESSAGE_TOKENS = 8;
/** Characters kept of each typed user message carried verbatim past agentic compaction. */
export const EARLIER_USER_MESSAGE_CHARS = 2_000;
/** Share of the message target the verbatim earlier user messages may use. */
export const EARLIER_USER_MESSAGES_TARGET_SHARE = 0.25;

export interface FileOperationSummary {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface CompactionSummaryMetadata {
	kind: "compaction_summary";
	displayRole: "system";
	userRunSpan: number;
	summary: string;
	details: FileOperationSummary;
	tokensBefore: number;
	generatedAt: number;
	/** Earlier user messages left out of the verbatim blocks for space, across compactions. */
	droppedUserMessages: number;
}

export type EstimateMessageTokens = (message: MessageWithMetadata) => number;

function isPositiveFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Resolve the model's usable prompt budget. A reported input limit is
 * authoritative but cannot exceed the context window. When the model only
 * reports a context window, retain a conservative margin for request overhead.
 */
export function resolveEffectiveMaxInputTokens(
	input: Pick<ModelInfo, "maxInputTokens" | "contextWindow">,
): number | undefined {
	const contextWindow = isPositiveFiniteNumber(input.contextWindow)
		? input.contextWindow
		: undefined;
	const maxInputTokens = isPositiveFiniteNumber(input.maxInputTokens)
		? input.maxInputTokens
		: undefined;

	if (maxInputTokens !== undefined) {
		return contextWindow === undefined
			? maxInputTokens
			: Math.min(maxInputTokens, contextWindow);
	}

	return contextWindow === undefined
		? undefined
		: contextWindow * CONTEXT_WINDOW_INPUT_RATIO;
}

/**
 * The window the auto-compaction trigger is a share of: the reported input
 * limit, else the whole context window, since the trigger ratio is the margin.
 */
export function resolveCompactionWindowTokens(
	input: Pick<ModelInfo, "maxInputTokens" | "contextWindow">,
): number | undefined {
	if (isPositiveFiniteNumber(input.maxInputTokens)) {
		return resolveEffectiveMaxInputTokens(input);
	}
	return isPositiveFiniteNumber(input.contextWindow)
		? input.contextWindow
		: undefined;
}

export function truncateText(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

export function flattenToolResultContent(
	content: ToolResultContent["content"],
	blockChars = DEFAULT_SUMMARY_BLOCK_CHARS,
): string {
	const truncated = truncateToolResultContentForCompaction(content, blockChars);
	if (typeof truncated === "string") {
		return truncated;
	}
	return truncated
		.map((block) => {
			switch (block.type) {
				case "text":
					return block.text;
				case "file":
					return `<file path="${block.path}">\n${block.content}\n</file>`;
				case "image":
					return `[image:${block.mediaType}]`;
				default:
					return "";
			}
		})
		.join("\n");
}

export function truncateToolResultContentForCompaction(
	content: ToolResultContent["content"],
	blockChars = DEFAULT_SUMMARY_BLOCK_CHARS,
): ToolResultContent["content"] {
	if (typeof content === "string") {
		return truncateText(content, blockChars);
	}
	return content.map((block) => {
		switch (block.type) {
			case "text":
				return {
					...block,
					text: truncateText(block.text, blockChars),
				};
			case "file":
				return {
					...block,
					content: truncateText(block.content, blockChars),
				};
			case "image":
				return block;
			default:
				return block;
		}
	});
}

export function formatToolInput(input: Record<string, unknown>): string {
	return Object.entries(input)
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join(", ");
}

export function serializeMessage(
	message: MessageWithMetadata,
	blockChars = DEFAULT_SUMMARY_BLOCK_CHARS,
): string {
	if (typeof message.content === "string") {
		return `[${message.role === "user" ? "User" : "Bot"}]: ${message.content}`;
	}
	const lines: string[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				lines.push(
					`[${message.role === "user" ? "User" : "Bot"}]: ${block.text}`,
				);
				break;
			case "thinking":
				lines.push(
					`[Bot thinking]: ${truncateText(block.thinking, blockChars)}`,
				);
				break;
			case "redacted_thinking":
				lines.push("[Bot thinking]: [redacted]");
				break;
			case "tool_use":
				lines.push(
					`[Bot tool calls]: ${block.name}(${formatToolInput(block.input)})`,
				);
				break;
			case "tool_result":
				lines.push(
					`[Tool result]: ${flattenToolResultContent(block.content, blockChars)}`,
				);
				break;
			case "file":
				lines.push(
					`[${message.role === "user" ? "User" : "Bot"} file ${block.path}]: ${truncateText(block.content, blockChars)}`,
				);
				break;
			case "image":
				lines.push(
					`[${message.role === "user" ? "User" : "Bot"} image]: ${block.mediaType}`,
				);
				break;
			case "media":
				lines.push(
					`[Bot generated ${block.media.modality}]: ${block.media.mediaType}`,
				);
				break;
		}
	}
	return lines.join("\n");
}

export function serializeConversation(
	messages: MessageWithMetadata[],
	blockChars = DEFAULT_SUMMARY_BLOCK_CHARS,
): string {
	return messages
		.map((message) => serializeMessage(message, blockChars))
		.join("\n\n")
		.trim();
}

export function createTokenEstimator(): EstimateMessageTokens {
	const cache = new WeakMap<object, number>();
	return (message) => {
		const ref = message as unknown as object;
		const cached = cache.get(ref);
		if (typeof cached === "number") {
			return cached;
		}
		const { replacer, imageCount } = createImageAwareReplacer();
		let serialized: string;
		// Only trust imageCount() when the replacer-driven pass actually
		// finished; see the matching comment in estimateRequestInputTokens.
		let images = 0;
		try {
			serialized = JSON.stringify(message, replacer);
			images = imageCount();
		} catch {
			serialized = serializeMessage(message);
		}
		const value =
			estimateTokens(serialized.length) + images * ESTIMATED_TOKENS_PER_IMAGE;
		cache.set(ref, value);
		return value;
	};
}

export function isCompactionSummaryMessage(
	message: MessageWithMetadata,
): boolean {
	return (
		(message.metadata as { kind?: string } | undefined)?.kind ===
		"compaction_summary"
	);
}

export function getCompactionSummaryMetadata(
	message: MessageWithMetadata,
): CompactionSummaryMetadata | undefined {
	if (!isCompactionSummaryMessage(message)) {
		return undefined;
	}
	const metadata = message.metadata as Record<string, unknown> | undefined;
	if (!metadata) {
		return undefined;
	}
	const details = metadata.details as Record<string, unknown> | undefined;
	return {
		kind: "compaction_summary",
		displayRole: "system",
		userRunSpan:
			typeof metadata.userRunSpan === "number" &&
			Number.isInteger(metadata.userRunSpan) &&
			metadata.userRunSpan >= 0
				? metadata.userRunSpan
				: 1,
		summary: String(metadata.summary ?? ""),
		details: {
			readFiles: Array.isArray(details?.readFiles)
				? details.readFiles
						.filter((value): value is string => typeof value === "string")
						.map((value) => value.trim())
						.filter((value) => value.length > 0)
				: [],
			modifiedFiles: Array.isArray(details?.modifiedFiles)
				? details.modifiedFiles
						.filter((value): value is string => typeof value === "string")
						.map((value) => value.trim())
						.filter((value) => value.length > 0)
				: [],
		},
		tokensBefore: Number(metadata.tokensBefore ?? 0),
		generatedAt: Number(metadata.generatedAt ?? 0),
		droppedUserMessages:
			typeof metadata.droppedUserMessages === "number" &&
			Number.isInteger(metadata.droppedUserMessages) &&
			metadata.droppedUserMessages > 0
				? metadata.droppedUserMessages
				: 0,
	};
}

/**
 * The text of a message the user typed: not a tool result, compaction
 * summary, hook context or runtime notice.
 */
export function typedUserMessageText(
	message: MessageWithMetadata,
): string | undefined {
	if (!isTurnStartMessage(message) || getUserRunSpan(message) === 0) {
		return undefined;
	}
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("\n");
	return text.trim() || undefined;
}

export function formatEarlierUserMessage(text: string): string {
	return `<user_message>\n${truncateText(text, EARLIER_USER_MESSAGE_CHARS)}\n</user_message>`;
}

/** The verbatim user message blocks a summary message carries after its summary text. */
export function earlierUserMessageBlocks(
	summaryMessage: MessageWithMetadata,
): string[] {
	if (typeof summaryMessage.content === "string") {
		return [];
	}
	return summaryMessage.content
		.slice(1)
		.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

/** Keeps the newest messages that fit the token budget, in their original order. */
export function selectEarlierUserMessages(
	messages: string[],
	budgetTokens: number,
): string[] {
	let start = messages.length;
	let usedTokens = 0;
	while (start > 0) {
		const cost = estimateTokens(messages[start - 1].length);
		if (usedTokens + cost > budgetTokens) {
			break;
		}
		usedTokens += cost;
		start -= 1;
	}
	return messages.slice(start);
}

export function isToolResultOnlyUserMessage(
	message: MessageWithMetadata,
): boolean {
	if (message.role !== "user" || !Array.isArray(message.content)) {
		return false;
	}
	return (
		message.content.length > 0 &&
		message.content.every((block) => block.type === "tool_result")
	);
}

export function isTurnStartMessage(message: MessageWithMetadata): boolean {
	return (
		message.role === "user" &&
		message.metadata?.userRunSpan !== 0 &&
		!isToolResultOnlyUserMessage(message) &&
		!isCompactionSummaryMessage(message)
	);
}

export function findFirstUserMessageIndex(
	messages: MessageWithMetadata[],
): number {
	for (let index = 0; index < messages.length; index += 1) {
		if (isTurnStartMessage(messages[index])) {
			return index;
		}
	}
	return -1;
}

export function findLastTurnStartIndex(
	messages: MessageWithMetadata[],
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (isTurnStartMessage(messages[index])) {
			return index;
		}
	}
	return 0;
}

export function findLastAssistantIndex(
	messages: MessageWithMetadata[],
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "assistant") {
			return index;
		}
	}
	return -1;
}

export function findLatestSummaryIndex(
	messages: MessageWithMetadata[],
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (isCompactionSummaryMessage(messages[index])) {
			return index;
		}
	}
	return -1;
}

/**
 * A cut boundary is safe when starting the preserved tail there cannot
 * orphan half of a tool_use/tool_result pair. Typed user turns qualify,
 * and so do assistant messages: an assistant's tool_use keeps its results
 * in the user message that follows it, so both halves stay on the same
 * side of the cut. A tool_result-only user message is never safe — its
 * matching tool_use sits in the preceding assistant message and would be
 * folded into the summary, leaving an orphaned tool_result the provider
 * rejects.
 */
function isSafeCutBoundary(message: MessageWithMetadata): boolean {
	return message.role === "assistant" || isTurnStartMessage(message);
}

export function findCutIndex(
	messages: MessageWithMetadata[],
	preserveRecentTokens: number,
	estimateMessageTokens: EstimateMessageTokens,
): number {
	let total = 0;
	let candidate = messages.length;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		total += estimateMessageTokens(messages[index]);
		candidate = index;
		if (total >= preserveRecentTokens) {
			break;
		}
	}

	if (candidate <= 0) {
		return 0;
	}

	// Never summarize away the latest typed user prompt: when one exists
	// past index 0, the cut stays at or before it so that whole turn
	// survives verbatim. Transcripts without a later typed turn (a single
	// task followed by one long tool loop, or a projection that starts
	// with a compaction summary) still cut at the token-budget candidate.
	const lastTurnStartIndex = findLastTurnStartIndex(messages);
	let cut =
		lastTurnStartIndex > 0
			? Math.min(candidate, lastTurnStartIndex)
			: candidate;
	while (cut > 0 && !isSafeCutBoundary(messages[cut])) {
		cut -= 1;
	}
	return cut;
}

export function collectPaths(value: unknown): string[] {
	if (typeof value === "string" && value.trim().length > 0) {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap((item) => collectPaths(item));
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const paths: string[] = [];
		for (const key of [
			"path",
			"file_path",
			"target_file",
			"new_file_path",
			"old_file_path",
		]) {
			paths.push(...collectPaths(record[key]));
		}
		if (Array.isArray(record.files)) {
			for (const item of record.files) {
				if (item && typeof item === "object") {
					paths.push(...collectPaths((item as Record<string, unknown>).path));
				}
			}
		}
		if (Array.isArray(record.file_paths)) {
			paths.push(...collectPaths(record.file_paths));
		}
		return paths;
	}
	return [];
}

export function mergeUnique(base: string[], next: Iterable<string>): string[] {
	const seen = new Set(base);
	for (const value of next) {
		const trimmed = value.trim();
		if (!trimmed) {
			continue;
		}
		seen.add(trimmed);
	}
	return [...seen].sort((a, b) => a.localeCompare(b));
}

export function extractFileOps(
	messages: MessageWithMetadata[],
): FileOperationSummary {
	let readFiles: string[] = [];
	let modifiedFiles: string[] = [];
	for (const message of messages) {
		const summaryMetadata = getCompactionSummaryMetadata(message);
		if (summaryMetadata) {
			readFiles = mergeUnique(readFiles, summaryMetadata.details.readFiles);
			modifiedFiles = mergeUnique(
				modifiedFiles,
				summaryMetadata.details.modifiedFiles,
			);
			continue;
		}
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "file") {
				readFiles = mergeUnique(readFiles, [block.path]);
				continue;
			}
			if (block.type !== "tool_use") {
				continue;
			}
			const paths = collectPaths(block.input);
			if (block.name === "read_files") {
				readFiles = mergeUnique(readFiles, paths);
				continue;
			}
			if (block.name === "editor" || block.name === "apply_patch") {
				modifiedFiles = mergeUnique(modifiedFiles, paths);
			}
		}
	}
	return { readFiles, modifiedFiles };
}

/** Commands longer than this are truncated in dropped-work summaries. */
export const COMMAND_SUMMARY_CHAR_LIMIT = 100;

/**
 * Compact record of the tool work performed inside a span of dropped
 * messages: which files were read and edited (with line ranges when
 * known) and which commands ran.
 */
export interface ToolActivitySummary {
	readFiles: string[];
	editedFiles: string[];
	commands: string[];
}

export function hasToolActivity(summary: ToolActivitySummary): boolean {
	return (
		summary.readFiles.length > 0 ||
		summary.editedFiles.length > 0 ||
		summary.commands.length > 0
	);
}

function pushUniqueEntry(list: string[], value: string): void {
	const trimmed = value.trim();
	if (trimmed && !list.includes(trimmed)) {
		list.push(trimmed);
	}
}

function truncateCommandForSummary(command: string): string {
	if (command.length <= COMMAND_SUMMARY_CHAR_LIMIT) {
		return command;
	}
	return `${command.slice(0, COMMAND_SUMMARY_CHAR_LIMIT)}...`;
}

function formatReadFileEntry(
	record: Record<string, unknown>,
): string | undefined {
	const path = typeof record.path === "string" ? record.path.trim() : "";
	if (!path) {
		return undefined;
	}
	const start = record.start_line;
	const end = record.end_line;
	if (typeof start === "number" && typeof end === "number") {
		return `${path}:${start}-${end}`;
	}
	return path;
}

/**
 * Pull the edited line range out of an editor tool result. Editor results
 * embed a numbered diff (`-467: ...` / `+467: ...`), usually inside a
 * JSON-encoded payload's `result` field; the range is the min/max line
 * number seen. Returns undefined when no diff line numbers are found.
 */
function extractDiffLineRange(
	content: ToolResultContent["content"],
): { start: number; end: number } | undefined {
	let text =
		typeof content === "string"
			? content
			: content
					.map((block) =>
						block.type === "text"
							? block.text
							: block.type === "file"
								? block.content
								: "",
					)
					.join("\n");
	try {
		const parsed = JSON.parse(text) as { result?: unknown };
		if (parsed && typeof parsed.result === "string") {
			text = parsed.result;
		}
	} catch {
		// Not JSON-encoded; scan the raw text.
	}
	let start = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	for (const match of text.matchAll(/(?:^|\n|\\n)[-+](\d+): /g)) {
		const line = Number(match[1]);
		if (!Number.isFinite(line)) {
			continue;
		}
		start = Math.min(start, line);
		end = Math.max(end, line);
	}
	return start <= end ? { start, end } : undefined;
}

/**
 * Summarize the tool work inside a span of messages that compaction is
 * dropping. Read ranges come from read_files inputs; edited ranges come
 * from the numbered diff in the matching editor result when present.
 */
export function summarizeToolActivity(
	messages: MessageWithMetadata[],
): ToolActivitySummary {
	const readFiles: string[] = [];
	const editedFiles: string[] = [];
	const commands: string[] = [];
	const editorPathsByToolUseId = new Map<string, string>();
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "tool_use") {
				const input = (block.input ?? {}) as Record<string, unknown>;
				if (block.name === "read_files") {
					if (Array.isArray(input.files)) {
						for (const file of input.files) {
							if (file && typeof file === "object") {
								const entry = formatReadFileEntry(
									file as Record<string, unknown>,
								);
								if (entry) {
									pushUniqueEntry(readFiles, entry);
								}
							}
						}
					} else {
						for (const path of collectPaths(input)) {
							pushUniqueEntry(readFiles, path);
						}
					}
					continue;
				}
				if (block.name === "editor" || block.name === "apply_patch") {
					const path = collectPaths(input)[0];
					if (path) {
						editorPathsByToolUseId.set(block.id, path);
					}
					continue;
				}
				if (block.name === "run_commands") {
					const commandList = Array.isArray(input.commands)
						? input.commands
						: [];
					for (const command of commandList) {
						if (typeof command === "string" && command.trim()) {
							pushUniqueEntry(
								commands,
								truncateCommandForSummary(command.trim()),
							);
						}
					}
				}
				continue;
			}
			if (block.type === "tool_result") {
				const path = editorPathsByToolUseId.get(block.tool_use_id);
				if (!path) {
					continue;
				}
				const range = extractDiffLineRange(block.content);
				pushUniqueEntry(
					editedFiles,
					range ? `${path}:${range.start}-${range.end}` : path,
				);
				editorPathsByToolUseId.delete(block.tool_use_id);
			}
		}
	}
	// Editor calls whose results fell outside the span still count as edits.
	for (const path of editorPathsByToolUseId.values()) {
		pushUniqueEntry(editedFiles, path);
	}
	return { readFiles, editedFiles, commands };
}

export function formatToolActivitySummary(
	summary: ToolActivitySummary,
): string {
	return [
		`Files read:\n${summary.readFiles.join("\n")}`,
		`Files edited:\n${summary.editedFiles.join("\n")}`,
		`Commands ran:\n${summary.commands.join("\n")}`,
	].join("\n\n");
}

export function renderFilesSection(fileOps: FileOperationSummary): string {
	const readLines =
		fileOps.readFiles.length > 0
			? fileOps.readFiles.map((path) => `- ${path}`).join("\n")
			: "- none";
	const modifiedLines =
		fileOps.modifiedFiles.length > 0
			? fileOps.modifiedFiles.map((path) => `- ${path}`).join("\n")
			: "- none";
	return `## Files\nRead:\n${readLines}\nModified:\n${modifiedLines}`;
}

export function ensureFilesSection(
	summary: string,
	fileOps: FileOperationSummary,
): string {
	if (/^## Files$/im.test(summary)) {
		return summary.trim();
	}
	return `${summary.trim()}\n\n${renderFilesSection(fileOps)}`.trim();
}

export function buildSummaryRequest(options: {
	previousSummary?: string;
	/** Formatted `<user_message>` blocks, oldest first. */
	earlierUserMessages?: string[];
	conversationText: string;
	fileOps: FileOperationSummary;
	/** Asks for memory candidates too, while memory is on. */
	memoryCandidatesSection?: string;
}): string {
	const parts: string[] = [
		`Summarize this session for continuation. Be concise and factual.

## Goal
One sentence: what is being built or fixed.

## User instructions
Every instruction, preference, constraint and correction the user gave that still applies, quoted in the user's own words. Keep ALL CAPS emphasis as written. Carry these over from the previous summary unless the user withdrew them. Write "none" if there are none.

## Decisions and rejected approaches
- Decided: choices made and why
- Rejected: approaches tried and abandoned, each with the reason it failed, so they are not tried again
Carry these over from the previous summary. Write "none" if there are none.

## State
- Done: completed steps
- In Progress: current work
- Blocked: blockers or open questions

## Highlights
Key technical choices or notable findings (omit if none).

## Next
Immediate next steps.

## Files
Read: ${options.fileOps.readFiles.join(", ") || "none"}
Edited: ${options.fileOps.modifiedFiles.join(", ") || "none"}`,
	];
	if (options.memoryCandidatesSection) {
		parts.push(options.memoryCandidatesSection);
	}

	if (options.previousSummary?.trim()) {
		parts.push(`Previous summary:\n${options.previousSummary.trim()}`);
	}

	if (options.earlierUserMessages?.length) {
		parts.push(
			`Earlier user messages (verbatim, oldest first):\n${options.earlierUserMessages.join("\n")}`,
		);
	}

	parts.push(`Conversation:\n${options.conversationText || "(empty)"}`);

	return parts.join("\n\n");
}

/**
 * The summarizer output budget is a cap, not a target: reasoning models need
 * headroom beyond their thinking output or no summary text ever arrives and
 * compaction is skipped. An explicit configuration wins as-is; otherwise the
 * default applies, with model metadata (`maxTokens` is reported capability,
 * not a product default) only ever lowering it.
 */
function resolveSummaryMaxOutputTokens(config: ProviderConfig): number {
	if (isPositiveFiniteNumber(config.maxOutputTokens)) {
		return Math.floor(config.maxOutputTokens);
	}
	const modelMaxTokens =
		config.modelInfo?.maxTokens ??
		config.knownModels?.[config.modelId]?.maxTokens;
	if (isPositiveFiniteNumber(modelMaxTokens)) {
		return Math.min(
			DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
			Math.floor(modelMaxTokens),
		);
	}
	return DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS;
}

export function resolveSummarizerConfig(options: {
	activeProviderConfig: ProviderConfig;
	summarizer?: CoreCompactionSummarizerConfig;
	/**
	 * Summary output cap from the compaction config. A dedicated summarizer's
	 * own `maxOutputTokens` wins over it; it wins over the provider's.
	 */
	summaryMaxOutputTokens?: number;
}): ProviderConfig {
	const summarizer = options.summarizer;
	const summaryMaxOutputTokens = isPositiveFiniteNumber(
		options.summaryMaxOutputTokens,
	)
		? Math.floor(options.summaryMaxOutputTokens)
		: undefined;
	const withSummarizerDefaults = (config: ProviderConfig): ProviderConfig => {
		if (config.providerId === "openai-codex") {
			const { maxOutputTokens: _maxOutputTokens, ...rest } = config;
			return {
				...rest,
				thinking: false,
			};
		}
		return {
			...config,
			maxOutputTokens: resolveSummaryMaxOutputTokens(config),
			thinking: false,
		};
	};
	if (!summarizer) {
		return withSummarizerDefaults({
			...options.activeProviderConfig,
			maxOutputTokens:
				summaryMaxOutputTokens ?? options.activeProviderConfig.maxOutputTokens,
		});
	}
	const baseProviderConfig =
		summarizer.providerConfig?.providerId === summarizer.providerId
			? summarizer.providerConfig
			: undefined;
	return withSummarizerDefaults({
		...(baseProviderConfig ?? {}),
		providerId: summarizer.providerId,
		modelId: summarizer.modelId,
		apiKey: summarizer.apiKey ?? baseProviderConfig?.apiKey,
		baseUrl: summarizer.baseUrl ?? baseProviderConfig?.baseUrl,
		headers: summarizer.headers ?? baseProviderConfig?.headers,
		modelInfo: summarizer.modelInfo ?? baseProviderConfig?.modelInfo,
		knownModels: summarizer.knownModels ?? baseProviderConfig?.knownModels,
		maxOutputTokens:
			summarizer.maxOutputTokens ??
			summaryMaxOutputTokens ??
			baseProviderConfig?.maxOutputTokens,
	});
}

export function buildSummaryMessage(options: {
	summary: string;
	fileOps: FileOperationSummary;
	tokensBefore: number;
	userRunSpan: number;
	/** Formatted `<user_message>` blocks, oldest first. */
	earlierUserMessages: string[];
	droppedUserMessages: number;
}): MessageWithMetadata {
	const { earlierUserMessages, droppedUserMessages } = options;
	let earlierHeading = "";
	if (earlierUserMessages.length > 0 || droppedUserMessages > 0) {
		const dropped =
			droppedUserMessages > 0
				? ` ${droppedUserMessages} older message${droppedUserMessages === 1 ? " was" : "s were"} left out for space.`
				: "";
		earlierHeading = `\n\n## Earlier user messages\nWhat the user wrote before this summary, verbatim, oldest first.${dropped}`;
	}
	return {
		role: "user",
		// One block per message, so the next compaction can carry them forward
		// without parsing them back out of the summary text.
		content: [
			{
				type: "text",
				text: `Context summary:\n\n${options.summary}${earlierHeading}`,
			},
			...earlierUserMessages.map((text) => ({ type: "text" as const, text })),
		],
		metadata: {
			kind: "compaction_summary",
			displayRole: "system",
			userRunSpan: options.userRunSpan,
			summary: options.summary,
			details: options.fileOps,
			tokensBefore: options.tokensBefore,
			generatedAt: Date.now(),
			droppedUserMessages,
		} satisfies CompactionSummaryMetadata,
	};
}
