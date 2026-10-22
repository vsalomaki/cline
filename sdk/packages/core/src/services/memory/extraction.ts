import { createHandlerAsync } from "@cline/llms";
import {
	type BasicLogger,
	formatDisplayUserInput,
	type MessageWithMetadata,
} from "@cline/shared";
import {
	truncateText,
	typedUserMessageText,
} from "../../extensions/context/compaction-shared";
import type { ProviderConfig } from "../../types/provider-settings";
import { capMemoryIndex, MEMORY_SAVE_BAR } from "./recall";
import {
	MEMORY_SCOPES,
	type MemoryEntry,
	type MemoryScope,
	type MemoryStore,
	memorySlug,
} from "./store";

export const MAX_MEMORY_CANDIDATES = 2;
export const MEMORY_CANDIDATES_HEADING = "## Memory candidates";
export const MEMORY_IDLE_DELAY_MS = 30_000;
const EXTRACTION_BLOCK_CHARS = 2_000;
const EXTRACTION_TRANSCRIPT_CHARS = 24_000;

/** Memory the lead's compaction extracts into, and who hears about saves. */
export interface CompactionMemory {
	store: MemoryStore;
	onSaved?: (entries: MemoryEntry[]) => void;
}

export interface MemoryCandidate {
	scope: MemoryScope;
	name: string;
	description: string;
	content: string;
}

const CANDIDATE_RULES = `${MEMORY_SAVE_BAR} User scope is only for the user's preferences and working style that are not tied to one project or technology. At most ${MAX_MEMORY_CANDIDATES} candidates, or [] when nothing qualifies. Never repeat what an existing memory already says: to change one, reuse its exact name.`;

const CANDIDATE_FORMAT =
	'a fenced ```json block holding an array of {"scope": "project" | "user", "name": "...", "description": "one line", "content": "..."} objects, or []';

function formatExistingMemories(store: MemoryStore): string {
	return MEMORY_SCOPES.map(
		(scope) =>
			`${scope}:\n${capMemoryIndex(store.readIndex(scope)) || "(none)"}`,
	).join("\n");
}

/** The section the compaction summary template gains while memory is on. */
export function buildMemoryCandidatesSection(store: MemoryStore): string {
	return `${MEMORY_CANDIDATES_HEADING}
Findings from this conversation worth keeping across sessions, as ${CANDIDATE_FORMAT}. ${CANDIDATE_RULES}
Existing memories:
${formatExistingMemories(store)}`;
}

function toCandidate(value: unknown): MemoryCandidate | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const scope = record.scope;
	const text = (key: string) =>
		typeof record[key] === "string" ? (record[key] as string).trim() : "";
	if (scope !== "project" && scope !== "user") return undefined;
	const candidate = {
		scope,
		name: text("name"),
		description: text("description"),
		content: text("content"),
	} satisfies MemoryCandidate;
	return candidate.name && candidate.description && candidate.content
		? candidate
		: undefined;
}

/** Reads the first JSON array in the text, fenced or bare. */
export function parseMemoryCandidates(text: string): MemoryCandidate[] {
	const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i)?.[1];
	const source = fenced ?? text;
	const start = source.indexOf("[");
	const end = source.lastIndexOf("]");
	if (start < 0 || end < start) return [];
	try {
		const parsed = JSON.parse(source.slice(start, end + 1));
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map(toCandidate)
			.filter((candidate) => candidate !== undefined);
	} catch {
		return [];
	}
}

/** Removes the candidates section from a summary, parsed or not. */
export function splitMemoryCandidates(summary: string): {
	summary: string;
	candidates: MemoryCandidate[];
} {
	const lines = summary.split("\n");
	const start = lines.findIndex(
		(line) =>
			line.trim().toLowerCase() === MEMORY_CANDIDATES_HEADING.toLowerCase(),
	);
	if (start < 0) return { summary, candidates: [] };
	let end = start + 1;
	let inFence = false;
	for (; end < lines.length; end += 1) {
		const line = lines[end];
		if (line.trim().startsWith("```")) inFence = !inFence;
		if (!inFence && /^##\s/.test(line)) break;
	}
	return {
		summary: [...lines.slice(0, start), ...lines.slice(end)]
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
		candidates: parseMemoryCandidates(lines.slice(start + 1, end).join("\n")),
	};
}

function normalizeDescription(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Applies at most two candidates: a known name updates that memory, a
 * description an existing memory already has is skipped, the rest are saved.
 */
export function applyMemoryCandidates(
	store: MemoryStore,
	candidates: readonly MemoryCandidate[],
	logger?: BasicLogger,
): MemoryEntry[] {
	const applied: MemoryEntry[] = [];
	for (const candidate of candidates.slice(0, MAX_MEMORY_CANDIDATES)) {
		const slug = memorySlug(candidate.name);
		if (!slug) continue;
		const existing = store.list(candidate.scope);
		const sameName = existing.some((entry) => entry.slug === slug);
		const description = normalizeDescription(candidate.description);
		if (
			!sameName &&
			existing.some(
				(entry) => normalizeDescription(entry.description) === description,
			)
		) {
			logger?.debug("Skipped duplicate memory candidate", { name: slug });
			continue;
		}
		const result = store.write(
			candidate.scope,
			candidate,
			sameName ? "update" : "save",
		);
		if (result.ok) {
			applied.push(result.entry);
		} else {
			logger?.debug("Skipped memory candidate", {
				name: slug,
				reason: result.error,
			});
		}
	}
	return applied;
}

/** What the user typed, without the host's input envelope. */
function userText(message: MessageWithMetadata): string | undefined {
	const typed = typedUserMessageText(message);
	return typed === undefined ? undefined : formatDisplayUserInput(typed);
}

function textBlocks(message: MessageWithMetadata): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("\n");
}

function hasToolUse(message: MessageWithMetadata): boolean {
	return (
		Array.isArray(message.content) &&
		message.content.some((block) => block.type === "tool_use")
	);
}

const EVIDENCE_CHARS = 800;
const MAX_EVIDENCE = 3;
const PRIMARY_INPUT_KEYS = [
	"path",
	"file_path",
	"file_paths",
	"paths",
	"command",
	"commands",
	"query",
	"queries",
	"url",
	"urls",
	"pattern",
];

function resultText(
	content: string | Array<{ type: string; text?: string }>,
): string {
	return typeof content === "string"
		? content
		: content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function isFailedResult(text: string, isError: boolean | undefined): boolean {
	return isError === true || /"success"\s*:\s*false/.test(text);
}

/** The tool and the input field naming what it acted on. */
function toolTarget(name: string, input: Record<string, unknown>): string {
	const key = PRIMARY_INPUT_KEYS.find((candidate) => candidate in input);
	return `${name}:${JSON.stringify(key ? input[key] : input)}`;
}

/**
 * Tool calls from `start` on that failed and later succeeded with the same
 * tool on the same target, as evidence for the extraction request.
 */
export function findFailedThenSucceededCalls(
	messages: readonly MessageWithMetadata[],
	start = 0,
): string[] {
	const calls = new Map<
		string,
		{ name: string; input: Record<string, unknown> }
	>();
	const failures = new Map<string, string>();
	const failedCalls: string[] = [];
	messages.forEach((message, index) => {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type !== "tool_use") continue;
				calls.set(block.id, { name: block.name, input: block.input });
			}
			return;
		}
		if (!Array.isArray(message.content)) return;
		for (const block of message.content) {
			if (block.type !== "tool_result") continue;
			const call = calls.get(block.tool_use_id);
			if (!call) continue;
			const target = toolTarget(call.name, call.input);
			const text = resultText(block.content);
			if (isFailedResult(text, block.is_error)) {
				if (index >= start && !failures.has(target)) {
					failures.set(
						target,
						`<failed_call tool="${call.name}">\ninput: ${truncateText(JSON.stringify(call.input), EVIDENCE_CHARS)}\nresult: ${truncateText(text, EVIDENCE_CHARS)}\n</failed_call>`,
					);
				}
			} else {
				const failure = failures.get(target);
				if (failure && failedCalls.length < MAX_EVIDENCE) {
					failedCalls.push(failure);
				}
				failures.delete(target);
			}
		}
	});
	return failedCalls;
}

function keepNewest(blocks: string[], budget: number): string[] {
	const kept: string[] = [];
	let size = 0;
	for (let index = blocks.length - 1; index >= 0; index -= 1) {
		const block = blocks[index];
		if (size + block.length > budget) break;
		kept.unshift(block);
		size += block.length + 1;
	}
	return kept;
}

export function buildIdleExtractionRequest(
	store: MemoryStore,
	messages: readonly MessageWithMetadata[],
	failedCalls: readonly string[] = [],
): string {
	const blocks = messages.flatMap((message) => {
		const typed = userText(message);
		if (typed !== undefined) {
			return [
				`<user>\n${truncateText(typed, EXTRACTION_BLOCK_CHARS)}\n</user>`,
			];
		}
		if (message.role === "assistant" && !hasToolUse(message)) {
			const text = textBlocks(message).trim();
			return text
				? [
						`<assistant>\n${truncateText(text, EXTRACTION_BLOCK_CHARS)}\n</assistant>`,
					]
				: [];
		}
		return [];
	});
	const evidence = failedCalls.join("\n");
	const transcript = keepNewest(
		blocks,
		EXTRACTION_TRANSCRIPT_CHARS - evidence.length,
	).join("\n");
	const evidenceSection = evidence
		? `\n\nTool calls that failed before a later call on the same target succeeded:\n${evidence}`
		: "";
	return `Decide whether this coding session produced anything worth keeping in memory for later sessions. Corrections the user made and anything the user asked to remember are the most valuable. ${CANDIDATE_RULES}

Existing memories:
${formatExistingMemories(store)}

The user's messages and the agent's answers:
${transcript || "(empty)"}${evidenceSection}

Answer with only ${CANDIDATE_FORMAT}.`;
}

export async function requestMemoryCandidates(options: {
	providerConfig: ProviderConfig;
	request: string;
}): Promise<MemoryCandidate[]> {
	const handler = await createHandlerAsync(options.providerConfig);
	let text = "";
	for await (const chunk of handler.createMessage(
		"You review a finished coding session for findings worth remembering in later sessions.",
		[{ role: "user", content: options.request }],
	)) {
		if (chunk.type === "text") {
			text += chunk.text;
		} else if (chunk.type === "done" && !chunk.success && chunk.error) {
			throw new Error(chunk.error);
		}
	}
	return parseMemoryCandidates(text);
}

export interface MemoryIdleExtractorOptions {
	store: MemoryStore;
	/** Resolved when the request is sent, so refreshed credentials apply. */
	getProviderConfig: () => ProviderConfig;
	onSaved: (entries: MemoryEntry[]) => void;
	logger?: BasicLogger;
	delayMs?: number;
	/** Messages a resumed session starts with; only later ones are checked. */
	initialMessages?: readonly MessageWithMetadata[];
	request?: typeof requestMemoryCandidates;
}

interface ExtractionCursor {
	count: number;
	lastId?: string;
}

function cursorAfter(
	messages: readonly MessageWithMetadata[],
): ExtractionCursor {
	return { count: messages.length, lastId: messages.at(-1)?.id };
}

/**
 * One extraction per idle period: armed when a run finishes, cancelled (with
 * any request in flight) by the next prompt or an abort, and run at once when
 * the session ends.
 */
export class MemoryIdleExtractor {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pending: { request: string; next: ExtractionCursor } | undefined;
	private inFlight: AbortController | undefined;
	private cursor: ExtractionCursor;

	constructor(private readonly options: MemoryIdleExtractorOptions) {
		this.cursor = cursorAfter(options.initialMessages ?? []);
	}

	/** Considers the messages after the last extraction, from the whole conversation. */
	schedule(messages: readonly MessageWithMetadata[]): void {
		this.cancel();
		const start = this.windowStart(messages);
		const window = messages.slice(start);
		if (!window.some((message) => userText(message) !== undefined)) return;
		const request = buildIdleExtractionRequest(
			this.options.store,
			window,
			findFailedThenSucceededCalls(messages, start),
		);
		this.pending = { request, next: cursorAfter(messages) };
		this.timer = setTimeout(
			() => this.runPending(),
			this.options.delayMs ?? MEMORY_IDLE_DELAY_MS,
		);
		this.timer.unref?.();
	}

	/** Runs a waiting extraction now, for a session that is ending or being rebuilt. */
	flush(): void {
		if (this.timer) this.runPending();
	}

	cancel(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.pending = undefined;
		this.inFlight?.abort();
		this.inFlight = undefined;
	}

	private runPending(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		const pending = this.pending;
		this.pending = undefined;
		if (pending) void this.run(pending.request, pending.next);
	}

	/** After the last checked message; from the start when compaction replaced it. */
	private windowStart(messages: readonly MessageWithMetadata[]): number {
		const { count, lastId } = this.cursor;
		if (lastId) {
			for (let index = messages.length - 1; index >= 0; index -= 1) {
				if (messages[index].id === lastId) return index + 1;
			}
			return 0;
		}
		return count <= messages.length ? count : 0;
	}

	private async run(request: string, next: ExtractionCursor): Promise<void> {
		const controller = new AbortController();
		this.inFlight = controller;
		try {
			const candidates = await (
				this.options.request ?? requestMemoryCandidates
			)({
				providerConfig: {
					...this.options.getProviderConfig(),
					abortSignal: controller.signal,
				},
				request,
			});
			if (controller.signal.aborted) return;
			const saved = applyMemoryCandidates(
				this.options.store,
				candidates,
				this.options.logger,
			);
			this.options.logger?.log(
				`Memory extraction: ${candidates.length} candidate(s), ${saved.length} saved`,
			);
			if (saved.length > 0) {
				this.options.onSaved(saved);
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				this.options.logger?.log("Memory extraction failed", {
					severity: "warn",
					error,
				});
			}
		} finally {
			// A failing summarizer must not retry the same messages after every turn.
			if (!controller.signal.aborted) this.cursor = next;
			if (this.inFlight === controller) {
				this.inFlight = undefined;
			}
		}
	}
}
