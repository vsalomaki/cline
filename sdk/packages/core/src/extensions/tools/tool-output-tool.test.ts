import type { AgentToolContext } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { MemoryToolOutputStore } from "../../services/tool-output/store";
import {
	createToolOutputTool,
	TOOL_OUTPUT_TOOL_NAME,
} from "./tool-output-tool";

const limits = {
	readLines: 2_000,
	lineChars: 200,
	readOutputChars: 48_000,
	searchOutputChars: 48_000,
};

function context(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
	return {
		agentId: "agent-1",
		conversationId: "conv-1",
		iteration: 1,
		sessionId: "s1",
		...overrides,
	};
}

function setup(overrides: Partial<typeof limits> = {}) {
	const store = new MemoryToolOutputStore();
	const tool = createToolOutputTool(store, { ...limits, ...overrides });
	const run = (input: unknown, ctx: AgentToolContext = context()) =>
		tool.execute(input as never, ctx) as Promise<string>;
	const put = (
		text: string,
		overrides: Partial<Parameters<MemoryToolOutputStore["put"]>[0]> = {},
	) =>
		store.put({
			sessionId: "s1",
			toolCallId: `call-${Math.random()}`,
			toolName: "run_commands",
			summary: "npm test",
			text,
			...overrides,
		})?.id as string;
	return { store, tool, run, put };
}

const numbered = (count: number, prefix = "row") =>
	Array.from({ length: count }, (_, n) => `${prefix} ${n + 1}`).join("\n");

describe("tool_output tool", () => {
	it("is parallel and keeps its own results out of the store", () => {
		const { tool } = setup();

		expect(tool.name).toBe(TOOL_OUTPUT_TOOL_NAME);
		expect(tool.name).toBe("tool_output");
		expect(tool.executionMode).toBe("parallel");
		expect(tool.resultPolicy).toBe("no-store");
	});

	describe("list", () => {
		it("says so when nothing is stored", async () => {
			const { run } = setup();

			expect(await run({ action: "list" })).toBe(
				"No stored tool output in this task.",
			);
		});

		it("lists stored outputs newest first with summary, size and age", async () => {
			const { run, put } = setup();
			const first = put("a\nb\nc", { summary: "first command" });
			const second = put("one line", {
				toolName: "read_files",
				summary: "src/a.ts",
			});

			const lines = (await run({ action: "list" })).split("\n");

			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe(
				`${second} read_files: src/a.ts (1 lines, 8 chars), just now`,
			);
			expect(lines[1]).toBe(
				`${first} run_commands: first command (3 lines, 5 chars), just now`,
			);
		});

		it("lists only the 50 newest", async () => {
			const { run, put } = setup();
			for (let n = 0; n < 55; n++) put(`text ${n}`, { summary: `cmd ${n}` });

			const lines = (await run({ action: "list" })).split("\n");

			expect(lines).toHaveLength(50);
			expect(lines[0]).toContain("cmd 54");
			expect(lines.at(-1)).toContain("cmd 5");
		});
	});

	describe("read", () => {
		it("returns a line range with line numbers under a header", async () => {
			const { run, put } = setup();
			const id = put(numbered(10));

			const output = await run({
				action: "read",
				id,
				start_line: 3,
				end_line: 5,
			});

			expect(output).toBe(
				`${id} run_commands: npm test (10 lines, ${numbered(10).length} chars)\n3 | row 3\n4 | row 4\n5 | row 5`,
			);
		});

		it("reads from the start without a range", async () => {
			const { run, put } = setup();
			const id = put("alpha\nbeta");

			const output = await run({ action: "read", id });

			expect(output).toContain("1 | alpha\n2 | beta");
		});

		it("windows long outputs to the read line cap", async () => {
			const { run, put } = setup({ readLines: 5 });
			const id = put(numbered(100));

			const output = await run({ action: "read", id });

			expect(output).toContain("5 | row 5");
			expect(output).not.toContain("6 | row 6");
		});

		it("truncates very long lines", async () => {
			const { run, put } = setup({ lineChars: 50 });
			const id = put(`${"x".repeat(500)}\nend`);

			const output = await run({ action: "read", id });

			expect(output).toContain("[line truncated]");
			expect(output).not.toContain("x".repeat(100));
		});

		it("fails with a hint for an unknown id", async () => {
			const { run } = setup();

			await expect(run({ action: "read", id: "deadbeef" })).rejects.toThrow(
				'No stored output "deadbeef" in this task. Call tool_output with action "list"',
			);
		});

		it("needs an id", async () => {
			const { run } = setup();

			await expect(run({ action: "read" })).rejects.toThrow(
				'action "read" needs an id.',
			);
		});
	});

	describe("search", () => {
		const log = [
			"setup done",
			"compiling a",
			"compiling b",
			"error: boom",
			"cleanup",
			"more cleanup",
			"even more",
			"still more",
			"ERROR: second",
			"tail",
		].join("\n");

		it("numbers matches with ':' and context with '-', two lines of context by default", async () => {
			const { run, put } = setup();
			const id = put(log);

			const output = await run({ action: "search", id, pattern: "boom" });

			expect(output).toBe(
				[
					`== ${id} run_commands: npm test (10 lines, ${log.length} chars)`,
					"2- compiling a",
					"3- compiling b",
					"4: error: boom",
					"5- cleanup",
					"6- more cleanup",
				].join("\n"),
			);
		});

		it("separates distant groups with '--' and merges adjacent ones", async () => {
			const { run, put } = setup();
			const id = put(log);

			const apart = await run({
				action: "search",
				id,
				pattern: "boom|second",
				context_lines: 1,
			});
			const merged = await run({
				action: "search",
				id,
				pattern: "boom|second",
				context_lines: 3,
			});

			expect(apart.split("\n").slice(1)).toEqual([
				"3- compiling b",
				"4: error: boom",
				"5- cleanup",
				"--",
				"8- still more",
				"9: ERROR: second",
				"10- tail",
			]);
			expect(merged).not.toContain("\n--\n");
		});

		it("shows only matching lines with context_lines 0", async () => {
			const { run, put } = setup();
			const id = put(log);

			const output = await run({
				action: "search",
				id,
				pattern: "compiling",
				context_lines: 0,
			});

			expect(output.split("\n").slice(1)).toEqual([
				"2: compiling a",
				"3: compiling b",
			]);
		});

		it("is case sensitive unless ignore_case is set", async () => {
			const { run, put } = setup();
			const id = put(log);

			const sensitive = await run({
				action: "search",
				id,
				pattern: "error",
				context_lines: 0,
			});
			const insensitive = await run({
				action: "search",
				id,
				pattern: "error",
				context_lines: 0,
				ignore_case: true,
			});

			expect(sensitive).toContain("4: error: boom");
			expect(sensitive).not.toContain("ERROR: second");
			expect(insensitive).toContain("4: error: boom");
			expect(insensitive).toContain("9: ERROR: second");
		});

		it("searches every stored output of the session when no id is given", async () => {
			const { run, put } = setup();
			const first = put("alpha\nneedle one\nomega", { summary: "first" });
			put("nothing here", { summary: "second" });
			const third = put("needle two", { summary: "third" });

			const output = await run({
				action: "search",
				pattern: "needle",
				context_lines: 0,
			});

			expect(output).toContain(`== ${first} run_commands: first`);
			expect(output).toContain(`== ${third} run_commands: third`);
			expect(output).not.toContain("second");
			expect(output.split("\n\n")).toHaveLength(2);
			expect(output.indexOf(third)).toBeLessThan(output.indexOf(first));
		});

		it("reports when nothing matches", async () => {
			const { run, put } = setup();
			const id = put(log);

			expect(await run({ action: "search", id, pattern: "zzz" })).toBe(
				`No lines match /zzz/ in output ${id}.`,
			);
			expect(await run({ action: "search", pattern: "zzz" })).toBe(
				"No lines match /zzz/ in the stored output of this task.",
			);
		});

		it("searches literally when the pattern is not a valid regex", async () => {
			const { run, put } = setup();
			const id = put("call foo(bar\nother");

			const output = await run({
				action: "search",
				id,
				pattern: "foo(bar",
				context_lines: 0,
			});

			expect(output).toContain("1: call foo(bar");
			expect(output).toContain(
				"[The pattern is not a valid regex; searched for it literally.]",
			);
		});

		it("keeps the literal note when nothing matches", async () => {
			const { run, put } = setup();
			const id = put("plain text");

			const output = await run({ action: "search", id, pattern: "x(" });

			expect(output).toContain("No lines match");
			expect(output).toContain("searched for it literally");
		});

		it("clips long lines", async () => {
			const { run, put } = setup({ lineChars: 40 });
			const id = put(`needle ${"x".repeat(500)}`);

			const output = await run({
				action: "search",
				id,
				pattern: "needle",
				context_lines: 0,
			});

			expect(output).toContain("[line truncated]");
			expect(output).not.toContain("x".repeat(100));
		});

		it("caps the output and says how many matches there were", async () => {
			const { run, put } = setup({ searchOutputChars: 300 });
			const id = put(numbered(200, "match"));

			const output = await run({
				action: "search",
				id,
				pattern: "match",
				context_lines: 0,
			});

			expect(output).toContain("1: match 1");
			expect(output).not.toContain("200: match 200");
			expect(output).toContain(
				"[200 matching lines in total; not all are shown.",
			);
			expect(output.length).toBeLessThan(600);
		});

		it("stops at the cap and says how many older outputs it did not search", async () => {
			const { run, put } = setup({ searchOutputChars: 200 });
			put(numbered(50, "match"));
			put(numbered(100, "match"));

			const output = await run({
				action: "search",
				pattern: "match",
				context_lines: 0,
			});

			expect(output).toContain(
				"[Output limit reached after 100 matching lines; 1 older stored outputs were not searched.",
			);
		});

		it("does not treat a trailing newline as another line", async () => {
			const { run, put } = setup();
			const id = put(`${"x".repeat(2_000)}\nhit\n`);

			const output = await run({ action: "search", id, pattern: "^$" });

			expect(output).toContain("No lines match");
		});

		it("never says nothing matches when matches did not fit", async () => {
			const { run, put } = setup({ searchOutputChars: 60 });
			const id = put("hit\n", { summary: "s".repeat(150) });

			const output = await run({ action: "search", id, pattern: "hit" });

			expect(output).not.toContain("No lines match");
			expect(output).toContain(
				"[1 matching lines in total; not all are shown.",
			);
		});

		it("counts section headers against the output cap", async () => {
			const { run, put } = setup({ searchOutputChars: 2_000 });
			for (let index = 0; index < 100; index++) {
				put("hit\n", { summary: "s".repeat(150) });
			}

			const output = await run({ action: "search", pattern: "hit" });

			expect(output.length).toBeLessThan(2_400);
			expect(output).toContain("older stored outputs were not searched");
		});

		it("searches every stored output, not only the newest 50", async () => {
			const { run, put } = setup();
			put("needle here\n".repeat(200));
			for (let index = 0; index < 60; index++) put("nothing\n".repeat(300));

			const output = await run({ action: "search", pattern: "needle" });

			expect(output).toContain("1: needle here");
		});

		it("fails for an unknown id and for a missing pattern", async () => {
			const { run } = setup();

			await expect(
				run({ action: "search", id: "deadbeef", pattern: "x" }),
			).rejects.toThrow('No stored output "deadbeef"');
			await expect(run({ action: "search" })).rejects.toThrow(
				'action "search" needs a pattern.',
			);
		});
	});

	describe("action inference", () => {
		it("searches when a pattern is given", async () => {
			const { run, put } = setup();
			const id = put("hello\nworld");

			expect(await run({ pattern: "world", context_lines: 0 })).toContain(
				"2: world",
			);
			expect(await run({ id, pattern: "hello", context_lines: 0 })).toContain(
				"1: hello",
			);
		});

		it("reads when only an id is given", async () => {
			const { run, put } = setup();
			const id = put("hello\nworld");

			expect(await run({ id })).toContain("1 | hello\n2 | world");
		});

		it("lists when nothing is given", async () => {
			const { run, put } = setup();
			const id = put("hello");

			expect(await run({})).toContain(id);
		});

		it("keeps an explicit action", async () => {
			const { run, put } = setup();
			const id = put("hello");

			expect(await run({ action: "list", id, pattern: "hello" })).toContain(
				"run_commands: npm test",
			);
		});
	});

	describe("input validation", () => {
		it("rejects an unknown action and out-of-range context", async () => {
			const { run } = setup();

			await expect(run({ action: "delete" })).rejects.toThrow();
			await expect(
				run({ action: "search", pattern: "x", context_lines: 21 }),
			).rejects.toThrow();
		});

		it("accepts numbers sent as strings", async () => {
			const { run, put } = setup();
			const id = put(numbered(10));

			const output = await run({
				action: "read",
				id,
				start_line: "2",
				end_line: "3",
			});

			expect(output).toContain("2 | row 2\n3 | row 3");
			expect(output).not.toContain("4 | row 4");
		});
	});

	describe("session scoping", () => {
		it("cannot see another session's output", async () => {
			const { run, put } = setup();
			const mine = put("needle mine");
			const theirs = put("needle theirs", { sessionId: "other" });

			expect(await run({ action: "list" })).toContain(mine);
			expect(await run({ action: "list" })).not.toContain(theirs);
			expect(await run({ pattern: "needle", context_lines: 0 })).not.toContain(
				"theirs",
			);
			await expect(run({ action: "read", id: theirs })).rejects.toThrow(
				"No stored output",
			);
			await expect(
				run({ action: "search", id: theirs, pattern: "needle" }),
			).rejects.toThrow("No stored output");
		});

		it("uses the agent id when the context has no session id", async () => {
			const { run, put } = setup();
			const id = put("hello", { sessionId: "agent-1" });

			const output = await run(
				{ action: "list" },
				context({ sessionId: undefined }),
			);

			expect(output).toContain(id);
			expect(await run({ action: "list" })).toBe(
				"No stored tool output in this task.",
			);
		});
	});
});
