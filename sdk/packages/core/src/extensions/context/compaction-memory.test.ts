import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as LlmsProviders from "@cline/llms";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../services/memory/store";
import { createContextCompactionPrepareTurn } from "./compaction";
import { buildSummaryRequest } from "./compaction-shared";

const createHandlerMock = vi.fn();

vi.mock("@cline/llms", () => ({
	createHandlerAsync: (config: unknown) => createHandlerMock(config),
}));

async function* streamChunks(chunks: Record<string, unknown>[]) {
	for (const chunk of chunks) yield chunk;
}

const messages: LlmsProviders.Message[] = [
	{ role: "user", content: "Old turn to compact" },
	{ role: "assistant", content: "Old answer" },
	{ role: "user", content: "Recent turn" },
	{ role: "assistant", content: "Recent assistant state" },
];

const context = {
	agentId: "agent-1",
	conversationId: "conv-1",
	parentAgentId: null,
	iteration: 1,
	abortSignal: new AbortController().signal,
	systemPrompt: "You are helpful.",
	tools: [],
	messages,
	apiMessages: messages,
	model: {
		id: "mock-model",
		provider: "anthropic",
		info: { id: "mock-model", maxInputTokens: 10 },
	},
};

const config = {
	providerId: "anthropic",
	modelId: "mock-model",
	providerConfig: {
		providerId: "anthropic",
		modelId: "mock-model",
	} as LlmsProviders.ProviderConfig,
	compaction: {
		enabled: true,
		strategy: "agentic" as const,
		preserveRecentTokens: 1,
	},
	logger: undefined,
};

const SUMMARY = `## Goal
Ship it

## Memory candidates
\`\`\`json
[{"scope":"project","name":"Hub port","description":"Tests need CLINE_HUB_PORT unset","content":"A set port makes the e2e reuse a stale hub."}]
\`\`\``;

let root: string;
let store: MemoryStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cline-compaction-memory-"));
	store = new MemoryStore({
		userDir: join(root, "memory"),
		projectDir: join(root, "projects", "k", "memory"),
		projectKey: "/repo/.git",
	});
	createHandlerMock.mockReset();
	createHandlerMock.mockReturnValue({
		createMessage: vi.fn(() =>
			streamChunks([
				{ type: "text", id: "s", text: SUMMARY },
				{ type: "done", id: "s", success: true },
			]),
		),
	});
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function summaryRequest(): string {
	const handler = createHandlerMock.mock.results[0]?.value;
	return handler.createMessage.mock.calls[0][1][0].content;
}

function summaryText(
	result: { messages: LlmsProviders.Message[] } | undefined,
) {
	const first = result?.messages[0]?.content;
	return Array.isArray(first) && first[0]?.type === "text" ? first[0].text : "";
}

describe("memory candidates at compaction", () => {
	it("leaves the summary template unchanged while memory is off", async () => {
		const options = {
			conversationText: "x",
			fileOps: { readFiles: [], modifiedFiles: [] },
		};
		expect(buildSummaryRequest(options)).toBe(
			buildSummaryRequest({ ...options, memoryCandidatesSection: undefined }),
		);

		const result = await createContextCompactionPrepareTurn(config)?.(context);
		expect(summaryRequest()).not.toContain("Memory candidates");
		expect(summaryText(result)).toContain("## Memory candidates");
		expect(store.list("project")).toEqual([]);
	});

	it("asks for candidates, saves them and strips them from the summary", async () => {
		const onSaved = vi.fn();
		const result = await createContextCompactionPrepareTurn(config, {
			memory: { store, onSaved },
		})?.(context);

		expect(summaryRequest()).toContain("## Memory candidates\nFindings");
		const text = summaryText(result);
		expect(text).toContain("## Goal\nShip it");
		expect(text).not.toContain("Memory candidates");
		expect(text).not.toContain("Hub port");
		expect(store.get("project", "hub port")).toMatchObject({
			description: "Tests need CLINE_HUB_PORT unset",
		});
		expect(onSaved).toHaveBeenCalledWith([
			expect.objectContaining({ scope: "project", slug: "hub-port" }),
		]);
	});
});
