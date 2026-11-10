import type { Message, ToolResultContent } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	MessageBuilder,
	type MessageBuilderOptions,
	type StoredToolOutputInfo,
} from "./message-builder";

const TOOL_OUTPUT_STUB =
	"[Earlier tool_output result shortened to save context; run the query again if you need it.]";

function bigText(label: string, rows = 60): string {
	return Array.from(
		{ length: rows },
		(_, index) => `${label} row ${index} ${"d".repeat(40)}`,
	).join("\n");
}

type Content = ToolResultContent["content"];

function turn(
	id: string,
	name: string,
	content: Content,
	isError?: boolean,
): Message[] {
	return [
		{
			role: "assistant",
			content: [{ type: "tool_use", id, name, input: {} }],
		},
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: id,
					name,
					content,
					...(isError ? { is_error: true } : {}),
				},
			],
		},
	];
}

function conversation(
	turns: Message[][],
	options: { endWithAssistant?: boolean } = {},
): Message[] {
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "start" }] },
		...turns.flat(),
	];
	if (options.endWithAssistant ?? true) {
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
		});
	}
	return messages;
}

function resultOf(messages: Message[], id: string): ToolResultContent {
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "tool_result" && block.tool_use_id === id) {
				return block;
			}
		}
	}
	throw new Error(`Missing tool result ${id}`);
}

function stubText(messages: Message[], id: string): string | undefined {
	const { content } = resultOf(messages, id);
	if (
		Array.isArray(content) &&
		content.length === 1 &&
		content[0].type === "text" &&
		content[0].text.startsWith("[Earlier ")
	) {
		return content[0].text;
	}
	return undefined;
}

function storedRecord(id: string): StoredToolOutputInfo {
	return { id, summary: `summary of ${id}`, lines: 60, chars: 2_800 };
}

function createBuilder(
	options: Partial<MessageBuilderOptions> = {},
): MessageBuilder {
	return new MessageBuilder({
		keepRecentToolResults: 0,
		minOutdatedRewriteBytes: 0,
		getStoredToolOutput: (toolUseId) => storedRecord(`s-${toolUseId}`),
		...options,
	});
}

describe("shortening old tool results", () => {
	it("keeps the results of the latest turn in full even when none are kept", () => {
		const contents = [bigText("one"), bigText("two"), bigText("three")];
		const messages = conversation(
			contents.map((content, index) =>
				turn(`c${index}`, "search_codebase", content),
			),
			{ endWithAssistant: false },
		);
		const prepared = createBuilder().buildForApi(messages);

		expect(stubText(prepared, "c0")).toBeDefined();
		expect(stubText(prepared, "c1")).toBeDefined();
		expect(resultOf(prepared, "c2").content).toBe(contents[2]);
	});

	it("shortens a result once an assistant message follows it", () => {
		const content = bigText("one");
		const builder = createBuilder();
		const pending = conversation([turn("c0", "search_codebase", content)], {
			endWithAssistant: false,
		});
		expect(resultOf(builder.buildForApi(pending), "c0").content).toBe(content);

		const acted = conversation([turn("c0", "search_codebase", content)]);
		expect(stubText(builder.buildForApi(acted), "c0")).toBeDefined();
	});

	it("keeps the newest N acted-on results in full", () => {
		const contents = Array.from({ length: 5 }, (_, index) =>
			bigText(`r${index}`),
		);
		const messages = conversation(
			contents.map((content, index) =>
				turn(`c${index}`, "search_codebase", content),
			),
		);
		const prepared = createBuilder({ keepRecentToolResults: 2 }).buildForApi(
			messages,
		);

		for (const id of ["c0", "c1", "c2"]) {
			expect(stubText(prepared, id)).toBeDefined();
		}
		expect(resultOf(prepared, "c3").content).toBe(contents[3]);
		expect(resultOf(prepared, "c4").content).toBe(contents[4]);
	});

	it("shortens nothing when fewer results than N are acted on", () => {
		const messages = conversation([
			turn("c0", "search_codebase", bigText("a")),
			turn("c1", "search_codebase", bigText("b")),
		]);
		const prepared = createBuilder({ keepRecentToolResults: 6 }).buildForApi(
			messages,
		);
		expect(stubText(prepared, "c0")).toBeUndefined();
		expect(stubText(prepared, "c1")).toBeUndefined();
	});

	it("uses the default of six when no keep count is given", () => {
		const messages = conversation(
			Array.from({ length: 8 }, (_, index) =>
				turn(`c${index}`, "search_codebase", bigText(`r${index}`)),
			),
		);
		const prepared = new MessageBuilder({
			minOutdatedRewriteBytes: 0,
			getStoredToolOutput: (toolUseId) => storedRecord(toolUseId),
		}).buildForApi(messages);

		expect(stubText(prepared, "c0")).toBeDefined();
		expect(stubText(prepared, "c1")).toBeDefined();
		expect(stubText(prepared, "c2")).toBeUndefined();
	});

	it("does nothing when the keep count is Infinity", () => {
		const messages = conversation(
			Array.from({ length: 5 }, (_, index) =>
				turn(`c${index}`, "search_codebase", bigText(`r${index}`)),
			),
		);
		const prepared = createBuilder({
			keepRecentToolResults: Number.POSITIVE_INFINITY,
		}).buildForApi(messages);
		for (let index = 0; index < 5; index++) {
			expect(stubText(prepared, `c${index}`)).toBeUndefined();
		}
	});

	it("leaves results under 2000 characters alone", () => {
		const small = "s".repeat(1_999);
		const messages = conversation([
			turn("c0", "search_codebase", small),
			turn("c1", "search_codebase", "t".repeat(2_000)),
			turn("c2", "search_codebase", bigText("last")),
		]);
		const prepared = createBuilder().buildForApi(messages);
		expect(resultOf(prepared, "c0").content).toBe(small);
		expect(stubText(prepared, "c1")).toBeDefined();
	});

	describe("batching", () => {
		function turns(count: number): Message[][] {
			return Array.from({ length: count }, (_, index) =>
				turn(`c${index}`, "search_codebase", bigText(`r${index}`)),
			);
		}

		it("commits nothing until the freed characters reach the minimum, then everything pending", () => {
			const builder = createBuilder({ minOutdatedRewriteBytes: 11_000 });

			const few = builder.buildForApi(conversation(turns(3)));
			for (const id of ["c0", "c1", "c2"]) {
				expect(stubText(few, id)).toBeUndefined();
			}

			const enough = builder.buildForApi(conversation(turns(4)));
			for (const id of ["c0", "c1", "c2", "c3"]) {
				expect(stubText(enough, id)).toBeDefined();
			}
		});

		it("counts a result over the request cap at the cap, not at its full size", () => {
			const builder = createBuilder({
				minOutdatedRewriteBytes: 65_536,
				maxToolResultChars: 50_000,
			});
			const huge = (id: string) =>
				turn(id, "mcp__server__dump", "x".repeat(100_000));

			const one = builder.buildForApi(conversation([huge("h0")]));
			expect(stubText(one, "h0")).toBeUndefined();

			const two = builder.buildForApi(conversation([huge("h0"), huge("h1")]));
			expect(stubText(two, "h0")).toBeDefined();
			expect(stubText(two, "h1")).toBeDefined();
		});

		it("keeps committed stubs when later results arrive but have not freed enough", () => {
			const builder = createBuilder({
				keepRecentToolResults: 1,
				minOutdatedRewriteBytes: 5_000,
			});
			const first = builder.buildForApi(conversation(turns(4)));
			for (const id of ["c0", "c1", "c2"]) {
				expect(stubText(first, id)).toBeDefined();
			}
			expect(stubText(first, "c3")).toBeUndefined();

			const second = builder.buildForApi(conversation(turns(5)));
			for (const id of ["c0", "c1", "c2"]) {
				expect(stubText(second, id)).toBe(stubText(first, id));
			}
			expect(stubText(second, "c3")).toBeUndefined();
			expect(stubText(second, "c4")).toBeUndefined();
		});

		it("keeps a committed stub when the store stops returning its record", () => {
			let available = true;
			const builder = createBuilder({
				getStoredToolOutput: (toolUseId) =>
					available ? storedRecord(toolUseId) : undefined,
			});
			const messages = conversation(turns(2));
			const first = builder.buildForApi(messages);
			const stub = stubText(first, "c0");
			expect(stub).toBeDefined();

			available = false;
			expect(stubText(builder.buildForApi(messages), "c0")).toBe(stub);
		});

		it("drops stubs for results that are no longer in the conversation", () => {
			let available = true;
			const builder = createBuilder({
				getStoredToolOutput: (toolUseId) =>
					available ? storedRecord(toolUseId) : undefined,
			});
			const full = conversation(turns(2));
			expect(stubText(builder.buildForApi(full), "c0")).toBeDefined();

			builder.buildForApi(
				conversation([turn("other", "search_codebase", "x")]),
			);
			available = false;
			expect(stubText(builder.buildForApi(full), "c0")).toBeUndefined();
		});

		it("forgets stubs on resetConversationState", () => {
			let available = true;
			const builder = createBuilder({
				getStoredToolOutput: (toolUseId) =>
					available ? storedRecord(toolUseId) : undefined,
			});
			const messages = conversation(turns(2));
			expect(stubText(builder.buildForApi(messages), "c0")).toBeDefined();

			builder.resetConversationState();
			available = false;
			expect(stubText(builder.buildForApi(messages), "c0")).toBeUndefined();
		});
	});

	describe("stub text", () => {
		it("points to the stored output for a tool with a record", () => {
			const requested: string[] = [];
			const builder = createBuilder({
				getStoredToolOutput: (toolUseId) => {
					requested.push(toolUseId);
					return {
						id: "ab12cd34",
						summary: "grep foo",
						lines: 60,
						chars: 2_900,
					};
				},
			});
			const prepared = builder.buildForApi(
				conversation([turn("c0", "search_codebase", bigText("x"))]),
			);
			expect(stubText(prepared, "c0")).toBe(
				"[Earlier search_codebase result shortened to save context: grep foo. 60 lines, 2900 chars, stored as tool output ab12cd34; search or read it with tool_output if you need it.]",
			);
			expect(requested).toContain("c0");
		});

		it("does not shorten a result without a stored record", () => {
			const builder = createBuilder({
				getStoredToolOutput: (toolUseId) =>
					toolUseId === "c0" ? undefined : storedRecord(toolUseId),
			});
			const content = bigText("x");
			const prepared = builder.buildForApi(
				conversation([
					turn("c0", "search_codebase", content),
					turn("c1", "search_codebase", bigText("y")),
				]),
			);
			expect(resultOf(prepared, "c0").content).toBe(content);
			expect(stubText(prepared, "c1")).toBeDefined();
		});

		it("does not shorten anything when there is no store lookup", () => {
			const messages = conversation([
				turn("c0", "search_codebase", bigText("x")),
			]);
			const prepared = new MessageBuilder({
				keepRecentToolResults: 0,
				minOutdatedRewriteBytes: 0,
			}).buildForApi(messages);
			expect(stubText(prepared, "c0")).toBeUndefined();
		});

		it("shortens tool_output results without a record", () => {
			const builder = createBuilder({ getStoredToolOutput: () => undefined });
			const prepared = builder.buildForApi(
				conversation([turn("c0", "tool_output", bigText("hits"))]),
			);
			expect(stubText(prepared, "c0")).toBe(TOOL_OUTPUT_STUB);
		});

		it("tells the model to read a file again after read tools", () => {
			const prepared = createBuilder().buildForApi(
				conversation([
					turn("c0", "read_files", bigText("file")),
					turn("c1", "search_codebase", bigText("hits")),
				]),
			);
			expect(stubText(prepared, "c0")).toMatch(
				/with tool_output if you need it\. Read the file again for its current content\.\]$/,
			);
			expect(stubText(prepared, "c1")).not.toContain("Read the file again");
		});

		it("summarizes the outcome of each run_commands entry", () => {
			const results = [
				{ query: "npm test", result: "x".repeat(3_000), success: true },
				{
					query: "npm run lint",
					result: "y",
					success: false,
					error: "Command exited with code 1",
				},
				{ query: "npm run build", result: "z", success: false },
			];
			const prepared = createBuilder().buildForApi(
				conversation([
					turn("c0", "run_commands", results as unknown as Content),
				]),
			);
			expect(stubText(prepared, "c0")).toContain(
				"(npm test: ok; npm run lint: Command exited with code 1; npm run build: failed)",
			);
		});

		it("reads the run_commands outcome from a JSON string result too", () => {
			const results = [
				{ query: "ls", result: "x".repeat(3_000), success: true },
			];
			const prepared = createBuilder().buildForApi(
				conversation([turn("c0", "run_commands", JSON.stringify(results))]),
			);
			expect(stubText(prepared, "c0")).toContain("(ls: ok)");
		});

		it("omits the outcome when the result is not a list of command results", () => {
			const prepared = createBuilder().buildForApi(
				conversation([
					turn("c0", "run_commands", bigText("plain")),
					turn(
						"c1",
						"run_commands",
						JSON.stringify([{ foo: "x".repeat(3_000) }]),
					),
				]),
			);
			expect(stubText(prepared, "c0")).toContain("summary of s-c0. 60 lines");
			expect(stubText(prepared, "c1")).toContain("summary of s-c1. 60 lines");
		});

		it("bounds the outcome line", () => {
			const results = Array.from({ length: 60 }, (_, index) => ({
				query: `command number ${index}`,
				result: "x".repeat(60),
				success: true,
			}));
			const prepared = createBuilder().buildForApi(
				conversation([
					turn("c0", "run_commands", results as unknown as Content),
				]),
			);
			const stub = stubText(prepared, "c0") ?? "";
			const status = /\((command number 0: ok.*…)\)\./.exec(stub)?.[1];
			expect(status).toBeDefined();
			expect(status?.length).toBeLessThanOrEqual(300);
		});
	});

	describe("the rewritten block", () => {
		it("keeps tool_use_id and is_error", () => {
			const prepared = createBuilder().buildForApi(
				conversation([turn("c0", "search_codebase", bigText("err"), true)]),
			);
			const block = resultOf(prepared, "c0");
			expect(stubText(prepared, "c0")).toBeDefined();
			expect(block.tool_use_id).toBe("c0");
			expect(block.is_error).toBe(true);
		});

		it("leaves is_error unset when the original had none", () => {
			const prepared = createBuilder().buildForApi(
				conversation([turn("c0", "search_codebase", bigText("ok"))]),
			);
			expect(resultOf(prepared, "c0").is_error).toBeUndefined();
		});

		it("adds no truncation recovery notice to a shortened block", () => {
			const prepared = createBuilder({
				maxToolResultChars: 500,
				getToolResultRecovery: () => ({ outputId: "ab12cd34" }),
			}).buildForApi(
				conversation([
					turn("c0", "search_codebase", bigText("old")),
					turn("c1", "search_codebase", bigText("new")),
				]),
			);
			const old = resultOf(prepared, "c0");
			expect(old.content).toHaveLength(1);
			expect(JSON.stringify(old)).not.toContain("The full result is stored");
		});

		it("does not mutate the original messages", () => {
			const messages = conversation([
				turn("c0", "search_codebase", bigText("a")),
				turn("c1", "search_codebase", bigText("b")),
			]);
			const snapshot = JSON.stringify(messages);
			const prepared = createBuilder().buildForApi(messages);

			expect(stubText(prepared, "c0")).toBeDefined();
			expect(JSON.stringify(messages)).toBe(snapshot);
			expect(typeof resultOf(messages, "c0").content).toBe("string");
		});
	});
});
