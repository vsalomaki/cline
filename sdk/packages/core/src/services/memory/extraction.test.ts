import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageWithMetadata } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyMemoryCandidates,
	buildIdleExtractionRequest,
	buildMemoryCandidatesSection,
	findHardWonSignal,
	type MemoryCandidate,
	MemoryIdleExtractor,
	type MemoryIdleExtractorOptions,
	parseMemoryCandidates,
	splitMemoryCandidates,
} from "./extraction";
import { MemoryStore } from "./store";

let root: string;
let store: MemoryStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cline-memory-extract-"));
	store = new MemoryStore({
		userDir: join(root, "memory"),
		projectDir: join(root, "projects", "k", "memory"),
		projectKey: "/repo/.git",
	});
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});

const candidate = (
	name: string,
	description = `About ${name}`,
	scope: MemoryCandidate["scope"] = "project",
): MemoryCandidate => ({ scope, name, description, content: `Body ${name}` });

const user = (text: string): MessageWithMetadata => ({
	role: "user",
	content: [{ type: "text", text }],
});
const assistant = (text: string): MessageWithMetadata => ({
	role: "assistant",
	content: [{ type: "text", text }],
});
const toolUse = (
	id: string,
	name: string,
	input: Record<string, unknown>,
): MessageWithMetadata => ({
	role: "assistant",
	content: [{ type: "tool_use", id, name, input }],
});
const toolResult = (
	id: string,
	name: string,
	content: string,
	isError?: boolean,
): MessageWithMetadata => ({
	role: "user",
	content: [
		{ type: "tool_result", tool_use_id: id, name, content, is_error: isError },
	],
});
/** A tool call and its result. */
const call = (
	id: string,
	name: string,
	input: Record<string, unknown>,
	content: string,
	isError?: boolean,
) => [toolUse(id, name, input), toolResult(id, name, content, isError)];

describe("memory candidates in compaction summaries", () => {
	it("parses, strips the section and leaves the rest of the summary", () => {
		const summary = `## Goal
Fix the build.

## Memory candidates
\`\`\`json
[{"scope":"project","name":"Bun pin","description":"The build needs bun 1.4.2","content":"Newer bun breaks the lockfile."},
 {"scope":"nowhere","name":"bad","description":"x","content":"y"}]
\`\`\`

## Files
Read: a.ts`;
		const split = splitMemoryCandidates(summary);
		expect(split.summary).toBe(
			"## Goal\nFix the build.\n\n## Files\nRead: a.ts",
		);
		expect(split.candidates).toEqual([
			{
				scope: "project",
				name: "Bun pin",
				description: "The build needs bun 1.4.2",
				content: "Newer bun breaks the lockfile.",
			},
		]);
	});

	it("strips a section it cannot parse", () => {
		const split = splitMemoryCandidates(
			"## Goal\nx\n\n## Memory candidates\nnot json",
		);
		expect(split).toEqual({ summary: "## Goal\nx", candidates: [] });
		expect(parseMemoryCandidates("[]")).toEqual([]);
	});

	it("lists existing memories in the template section", () => {
		store.write("user", candidate("Tone", "Short answers", "user"), "save");
		const section = buildMemoryCandidatesSection(store);
		expect(section).toMatch(/^## Memory candidates\n/);
		expect(section).toContain("- [Tone](tone.md) — Short answers");
		expect(section).toContain("[] is the expected answer");
	});
});

describe("applyMemoryCandidates", () => {
	it("applies at most two candidates", () => {
		const applied = applyMemoryCandidates(store, [
			candidate("a"),
			candidate("b"),
			candidate("c"),
		]);
		expect(applied.map((entry) => entry.slug)).toEqual(["a", "b"]);
		expect(store.list("project")).toHaveLength(2);
	});

	it("updates a known name and skips a repeated description", () => {
		store.write(
			"project",
			candidate("Bun pin", "Build needs bun 1.4.2"),
			"save",
		);
		const applied = applyMemoryCandidates(store, [
			{ ...candidate("bun pin", "Build needs bun 1.4.2"), content: "New body" },
			candidate("Other name", "build needs  BUN 1.4.2"),
		]);
		expect(applied).toHaveLength(1);
		expect(store.list("project")).toHaveLength(1);
		expect(store.get("project", "bun pin")?.content).toBe("New body");
	});
});

describe("findHardWonSignal", () => {
	const found = (messages: MessageWithMetadata[], start = 0) =>
		findHardWonSignal(messages, start).found;

	it("ignores corrections before the agent has used tools", () => {
		expect(found([user("use bun instead of npm"), assistant("ok")])).toBe(
			false,
		);
		expect(
			found([user("add a test"), assistant("done"), user("No, use bun")]),
		).toBe(false);
	});

	it("counts a correction after the agent used tools", () => {
		const run = [
			user("add a test"),
			...call("c1", "editor", { path: "a.test.ts" }, "ok"),
			assistant("done"),
		];
		expect(found([...run, user("thanks, now docs")])).toBe(false);
		expect(found([...run, user("No, use bun not npm")])).toBe(true);
		expect(
			found([
				...run,
				user('<user_input mode="act">No, use bun not npm</user_input>'),
			]),
		).toBe(true);
		expect(found([...run, user("No, use bun")], run.length + 1)).toBe(false);
	});

	it("needs a failure and a later success on the same target", () => {
		expect(
			found([
				user("read it"),
				...call("r1", "read_files", { file_paths: ["a.ts"] }, "missing", true),
				...call("r2", "read_files", { file_paths: ["b.ts"] }, "body"),
			]),
		).toBe(false);
		expect(
			found([
				user("build it"),
				...call(
					"b1",
					"run_commands",
					{ commands: ["bun test"] },
					'[{"success":false}]',
				),
				...call(
					"b2",
					"run_commands",
					{ commands: ["bun test"] },
					'[{"success":true}]',
				),
			]),
		).toBe(true);
	});

	it("returns the failed call as evidence", () => {
		const signal = findHardWonSignal([
			user("build it"),
			...call(
				"b1",
				"run_commands",
				{ commands: ["bun test"] },
				`boom ${"e".repeat(2_000)}`,
				true,
			),
			...call("b2", "run_commands", { commands: ["bun test"] }, "ok"),
		]);
		expect(signal.failedCalls).toHaveLength(1);
		expect(signal.failedCalls[0]).toContain(
			'<failed_call tool="run_commands">',
		);
		expect(signal.failedCalls[0]).toContain('input: {"commands":["bun test"]}');
		expect(signal.failedCalls[0]).toContain("result: boom");
		expect(signal.failedCalls[0].length).toBeLessThan(2_000);
		expect(
			buildIdleExtractionRequest(store, [user("build it")], signal.failedCalls),
		).toContain(
			"Tool calls that failed before a later call on the same target succeeded:\n<failed_call",
		);
	});
});

describe("buildIdleExtractionRequest", () => {
	it("holds the user's messages, final answers and the indexes", () => {
		store.write("project", candidate("Known"), "save");
		const request = buildIdleExtractionRequest(store, [
			user("fix it"),
			{
				role: "assistant",
				content: [
					{ type: "text", text: "looking" },
					{ type: "tool_use", id: "1", name: "read_files", input: {} },
				],
			},
			toolResult("1", "read_files", "file body"),
			assistant("Fixed by pinning bun."),
		]);
		expect(request).toContain("<user>\nfix it\n</user>");
		expect(request).toContain(
			"<assistant>\nFixed by pinning bun.\n</assistant>",
		);
		expect(request).not.toContain("looking");
		expect(request).not.toContain("file body");
		expect(request).toContain("- [Known](known.md)");
	});
});

describe("buildIdleExtractionRequest size", () => {
	it("cuts long blocks and keeps the newest when the transcript is long", () => {
		const long = "x".repeat(5_000);
		const messages = Array.from({ length: 40 }, (_, i) =>
			i % 2 === 0 ? user(`question ${i} ${long}`) : assistant(`answer ${i}`),
		);
		const request = buildIdleExtractionRequest(store, messages);
		expect(request).toContain("[truncated");
		expect(request).toContain("answer 39");
		expect(request).not.toContain("question 0 ");
		expect(request.length).toBeLessThan(30_000);
	});
});

describe("MemoryIdleExtractor", () => {
	const correctedRun = [
		user("add a test"),
		...call("c1", "editor", { path: "a.test.ts" }, "ok"),
		assistant("done"),
		user("that's wrong, tests go in src"),
		assistant("moved"),
	];

	function makeExtractor(
		request: MemoryIdleExtractorOptions["request"] = vi.fn(async () => [
			candidate("Test dir"),
		]),
	) {
		const onSaved = vi.fn();
		const extractor = new MemoryIdleExtractor({
			store,
			getProviderConfig: () => ({ providerId: "p", modelId: "m" }),
			onSaved,
			delayMs: 30_000,
			request,
		});
		return { extractor, onSaved, request };
	}

	it("extracts once after the delay and reports what it saved", async () => {
		vi.useFakeTimers();
		const { extractor, onSaved, request } = makeExtractor();
		extractor.schedule(correctedRun);
		await vi.advanceTimersByTimeAsync(29_000);
		expect(request).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(request).toHaveBeenCalledTimes(1);
		expect(onSaved).toHaveBeenCalledWith([
			expect.objectContaining({ slug: "test-dir" }),
		]);

		extractor.schedule(correctedRun);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("is cancelled by a new prompt, including a request in flight", async () => {
		vi.useFakeTimers();
		const { extractor, request } = makeExtractor();
		extractor.schedule(correctedRun);
		extractor.cancel();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(request).not.toHaveBeenCalled();

		let signal: AbortSignal | undefined;
		const slow = vi.fn(
			(options: { providerConfig: { abortSignal?: AbortSignal } }) =>
				new Promise<MemoryCandidate[]>((resolve) => {
					signal = options.providerConfig.abortSignal;
					signal?.addEventListener("abort", () => resolve([candidate("late")]));
				}),
		);
		const second = makeExtractor(slow);
		second.extractor.schedule(correctedRun);
		await vi.advanceTimersByTimeAsync(30_000);
		second.extractor.cancel();
		await vi.advanceTimersByTimeAsync(0);
		expect(signal?.aborted).toBe(true);
		expect(second.onSaved).not.toHaveBeenCalled();
		expect(store.list("project")).toHaveLength(0);
	});

	it("checks only messages after those a resumed session started with", async () => {
		vi.useFakeTimers();
		const request = vi.fn(async () => []);
		const extractor = new MemoryIdleExtractor({
			store,
			getProviderConfig: () => ({ providerId: "p", modelId: "m" }),
			onSaved: vi.fn(),
			initialMessages: correctedRun,
			request,
		});
		extractor.schedule([...correctedRun, user("thanks"), assistant("ok")]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(request).not.toHaveBeenCalled();
	});

	it("checks the whole transcript once compaction has replaced it", async () => {
		vi.useFakeTimers();
		const withId = (message: MessageWithMetadata, id: string) => ({
			...message,
			id,
		});
		const resumed = Array.from({ length: 6 }, (_, i) =>
			withId(i % 2 ? assistant(`a${i}`) : user(`q${i}`), `old-${i}`),
		);
		const request = vi.fn(
			async (_options: { request: string }): Promise<MemoryCandidate[]> => [],
		);
		const extractor = new MemoryIdleExtractor({
			store,
			getProviderConfig: () => ({ providerId: "p", modelId: "m" }),
			onSaved: vi.fn(),
			initialMessages: resumed,
			request,
		});
		const compacted = [
			withId(user("summary"), "summary"),
			withId(assistant("ok"), "s-ok"),
			withId(toolUse("t1", "editor", { path: "a" }), "t1"),
			withId(toolResult("t1", "editor", "ok"), "t1r"),
			withId(user("next"), "n1"),
			withId(user("that's wrong, use pnpm"), "n2"),
			...["n3", "n4", "n5", "n6"].map((id) => withId(assistant(id), id)),
		];
		extractor.schedule(compacted);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0]?.[0].request).toContain("use pnpm");

		extractor.schedule([...compacted, withId(user("thanks"), "n7")]);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("skips runs without a hard-won finding", async () => {
		vi.useFakeTimers();
		const { extractor, request } = makeExtractor();
		extractor.schedule([user("add a test"), assistant("done")]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(request).not.toHaveBeenCalled();
	});

	it("logs a failed request and does not retry the same messages", async () => {
		vi.useFakeTimers();
		const failing = vi.fn(async (): Promise<MemoryCandidate[]> => {
			throw new Error("provider down");
		});
		const { extractor, onSaved } = makeExtractor(failing);
		extractor.schedule(correctedRun);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(onSaved).not.toHaveBeenCalled();
		extractor.schedule([...correctedRun, user("thanks"), assistant("ok")]);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(failing).toHaveBeenCalledTimes(1);
	});
});
