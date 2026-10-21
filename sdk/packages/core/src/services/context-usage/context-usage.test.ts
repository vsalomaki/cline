import {
	type AgentMessage,
	type AgentMessagePart,
	ESTIMATED_TOKENS_PER_IMAGE,
	estimateTokens,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	type ContextUsageRequest,
	type ContextUsageToolOrigin,
	createContextUsageMeter,
} from "./context-usage";

function message(
	role: AgentMessage["role"],
	content: AgentMessagePart[],
): AgentMessage {
	return { id: `${role}-${Math.random()}`, role, content, createdAt: 0 };
}

const base = "You are Cline.";
const rulesText = "# Rules\n## style\nUse tabs.\n\n## tests\nRun vitest.";
const memoryText = "# Memory\n- prefers bun";
const composedText = `${base}\n\n${rulesText}\n\n${memoryText}`;

function request(
	overrides: Partial<ContextUsageRequest> = {},
): ContextUsageRequest {
	return {
		systemPrompt: composedText,
		composedPrompt: {
			text: composedText,
			rules: [
				{
					id: "cline-combined-user-instructions:rules",
					source: "combined-user-instructions",
					chars: rulesText.length,
					files: [
						{ name: "style", chars: "## style\nUse tabs.".length },
						{ name: "tests", chars: "## tests\nRun vitest.".length },
					],
				},
				{
					id: "cline-memory:index",
					source: "memory",
					chars: memoryText.length,
				},
			],
		},
		messages: [
			message("user", [
				{ type: "text", text: "Context summary:\n\nEarlier we fixed a bug." },
			]),
			message("user", [
				{ type: "text", text: "Look at this" },
				{ type: "image", image: "aGVsbG8=", mediaType: "image/png" },
				{ type: "file", path: "notes.md", content: "some notes" },
			]),
			message("assistant", [
				{ type: "reasoning", text: "thinking" },
				{
					type: "tool-call",
					toolCallId: "call_1",
					toolName: "read_files",
					input: { files: [{ path: "a.ts" }] },
				},
			]),
			message("tool", [
				{
					type: "tool-result",
					toolCallId: "call_1",
					toolName: "read_files",
					output: [
						{ type: "text", text: "export const a = 1;" },
						{ type: "image", data: "aGVsbG8=", mediaType: "image/png" },
					],
				},
			]),
		],
		tools: [
			{
				name: "read_files",
				description: "Read files",
				inputSchema: { type: "object" },
			},
			{
				name: "memory",
				description: "Save a memory",
				inputSchema: { type: "object" },
			},
			{
				name: "docs__search",
				description: "Search docs",
				inputSchema: { type: "object" },
			},
			{
				name: "docs__fetch",
				description: "Fetch a doc",
				inputSchema: { type: "object" },
			},
			{
				name: "git__log",
				description: "Git log",
				inputSchema: { type: "object" },
			},
		],
		toolOrigins: new Map<string, ContextUsageToolOrigin>([
			["read_files", "builtin"],
			["memory", "extension"],
			["docs__search", { mcp: "docs" }],
			["docs__fetch", { mcp: "docs" }],
			["git__log", { mcp: "git" }],
		]),
		windowTokens: 200_000,
		compactionTriggerRatio: 0.9,
		...overrides,
	};
}

function categoryTotal(
	snapshot: ReturnType<ReturnType<typeof createContextUsageMeter>>,
) {
	const { categories } = snapshot;
	return (
		categories.systemPrompt +
		categories.rules.reduce((sum, rule) => sum + rule.tokens, 0) +
		categories.memory +
		categories.tools.builtin +
		categories.tools.extension +
		categories.tools.mcp.reduce((sum, entry) => sum + entry.tokens, 0) +
		Object.values(categories.messages).reduce((sum, value) => sum + value, 0)
	);
}

describe("createContextUsageMeter", () => {
	it("fills every category and sums them into the total", () => {
		const snapshot = createContextUsageMeter()(request());
		const { categories } = snapshot;

		expect(categories.systemPrompt).toBeGreaterThan(0);
		expect(categories.memory).toBe(estimateTokens(memoryText.length));
		expect(categories.tools.builtin).toBeGreaterThan(0);
		expect(categories.tools.extension).toBeGreaterThan(0);
		for (const value of Object.values(categories.messages)) {
			expect(value).toBeGreaterThan(0);
		}
		expect(snapshot.estimatedTotal).toBe(categoryTotal(snapshot));
	});

	it("splits rules into their files and MCP tools by server", () => {
		const { categories } = createContextUsageMeter()(request());

		expect(categories.rules).toEqual([
			{
				id: "cline-combined-user-instructions:rules",
				source: "combined-user-instructions",
				tokens: estimateTokens(rulesText.length),
				files: [
					{ name: "style", tokens: estimateTokens(18) },
					{ name: "tests", tokens: estimateTokens(20) },
				],
			},
		]);
		expect(categories.tools.mcp.map((entry) => entry.server)).toEqual([
			"docs",
			"git",
		]);
		expect(categories.tools.mcp[0]?.tokens).toBeGreaterThan(
			categories.tools.mcp[1]?.tokens ?? 0,
		);
	});

	it("counts the compaction summary and images apart from conversation", () => {
		const { categories } = createContextUsageMeter()(request());

		expect(categories.messages.summary).toBe(
			estimateTokens("Context summary:\n\nEarlier we fixed a bug.".length),
		);
		expect(categories.messages.filesAndImages).toBe(
			estimateTokens("notes.mdsome notes".length) +
				2 * ESTIMATED_TOKENS_PER_IMAGE,
		);
		expect(categories.messages.toolResults).toBe(
			estimateTokens("export const a = 1;".length),
		);
	});

	it("counts a swapped system prompt as system prompt only", () => {
		const swapped = "A saved prompt from an earlier compaction.";
		const { categories } = createContextUsageMeter()(
			request({ systemPrompt: swapped }),
		);

		expect(categories.systemPrompt).toBe(estimateTokens(swapped.length));
		expect(categories.rules).toEqual([]);
		expect(categories.memory).toBe(0);
	});

	it("marks the compaction point only when compaction is on", () => {
		const meter = createContextUsageMeter();

		expect(meter(request()).compactAtTokens).toBe(180_000);
		expect(
			meter(request({ compactionTriggerRatio: undefined })),
		).not.toHaveProperty("compactAtTokens");
	});

	it("counts tools it has no origin for as built in", () => {
		const meter = createContextUsageMeter();
		const before = meter(request()).categories.tools.builtin;
		const after = meter(
			request({
				tools: [
					...request().tools,
					{
						name: "hook_added",
						description: "Added by a hook",
						inputSchema: { type: "object" },
					},
				],
			}),
		).categories.tools.builtin;

		expect(after).toBeGreaterThan(before);
	});
});
