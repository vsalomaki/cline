import type {
	AgentExtension,
	BasicLogger,
	MessageWithMetadata,
} from "@cline/shared";
import { resolveSummarizerConfig } from "../../extensions/context/compaction-shared";
import {
	type MemorySettings,
	resolveMemorySettings,
} from "../../settings/memory";
import type { CoreSessionConfig } from "../../types/config";
import { resolveConnectionProviderConfig } from "../llms/handler-factory";
import { MemoryIdleExtractor } from "./extraction";
import { type MemoryEntry, MemoryStore, resolveMemoryLocation } from "./store";
import { createMemoryExtension } from "./tool";

export * from "./extraction";
export * from "./recall";
export * from "./store";
export * from "./tool";

export interface SessionMemory {
	store: MemoryStore;
	settings: MemorySettings;
	/** Tool and recalled index; add it to the lead agent only. */
	extension: AgentExtension;
}

export async function createSessionMemory(input: {
	memory?: Partial<MemorySettings>;
	workspaceRoot: string;
}): Promise<SessionMemory | undefined> {
	const settings = resolveMemorySettings(input.memory);
	if (!settings.enabled) return undefined;
	const store = new MemoryStore(
		await resolveMemoryLocation(input.workspaceRoot),
	);
	return { store, settings, extension: createMemoryExtension(store) };
}

/** The idle extractor for a lead session, on the summarizer model when one is set. */
export function createSessionMemoryExtractor(input: {
	memory: SessionMemory | undefined;
	getConfig: () => CoreSessionConfig;
	logger?: BasicLogger;
	initialMessages?: readonly MessageWithMetadata[];
	onSaved: (entries: MemoryEntry[]) => void;
}): MemoryIdleExtractor | undefined {
	const { memory } = input;
	if (!memory?.settings.extractAfterRun) return undefined;
	return new MemoryIdleExtractor({
		store: memory.store,
		getProviderConfig: () => {
			const config = input.getConfig();
			return resolveSummarizerConfig({
				activeProviderConfig: resolveConnectionProviderConfig(config),
				summarizer: config.compaction?.summarizer,
			});
		},
		onSaved: input.onSaved,
		logger: input.logger,
		initialMessages: input.initialMessages,
	});
}

export function formatMemorySavedNotice(entries: MemoryEntry[]): string {
	return `Memory saved: ${entries
		.map((entry) => `${entry.name} (${entry.scope}): ${entry.description}`)
		.join("; ")}`;
}

/** What `/memory` shows: both folders and their indexes. */
export async function describeMemory(workspaceRoot: string): Promise<{
	projectKey: string;
	projectDir: string;
	userDir: string;
	projectIndex: string;
	userIndex: string;
}> {
	const store = new MemoryStore(await resolveMemoryLocation(workspaceRoot));
	return {
		...store.location,
		projectIndex: store.readIndex("project"),
		userIndex: store.readIndex("user"),
	};
}
