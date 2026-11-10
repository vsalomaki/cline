import { describe, expect, it } from "vitest";
import { MemoryToolOutputStore } from "../../../services/tool-output/store";
import {
	applyCommandOutputView,
	type CommandOutputViewOptions,
	hasCommandOutputView,
} from "./command-output-view";

const SESSION = "session-1";

function lineTexts(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

function setup(overrides: Partial<CommandOutputViewOptions> = {}) {
	const store = new MemoryToolOutputStore();
	const options: CommandOutputViewOptions = {
		context: {
			sessionId: SESSION,
			agentId: "agent-1",
			toolCallId: "call-1",
			metadata: { toolOutputStore: store },
		},
		summary: "npm test",
		maxChars: 48_000,
		lineChars: 2_000,
		...overrides,
	};
	return { store, options };
}

describe("hasCommandOutputView", () => {
	it("is true for head_lines, tail_lines or grep and false otherwise", () => {
		expect(hasCommandOutputView({})).toBe(false);
		expect(hasCommandOutputView({ context_lines: 3 })).toBe(false);
		expect(hasCommandOutputView({ head_lines: 1 })).toBe(true);
		expect(hasCommandOutputView({ tail_lines: 1 })).toBe(true);
		expect(hasCommandOutputView({ grep: "x" })).toBe(true);
	});
});

describe("applyCommandOutputView", () => {
	it("returns the output unchanged without a view", () => {
		const { options } = setup();
		const output = lineTexts(100).join("\n");
		expect(applyCommandOutputView(output, {}, options)).toBe(output);
		expect(applyCommandOutputView(output, { context_lines: 5 }, options)).toBe(
			output,
		);
	});

	it("takes the real end from the result when the stored copy hit its cap", () => {
		const { store, options } = setup();
		const record = store.put({
			sessionId: SESSION,
			toolCallId: "call-1/command",
			toolName: "run_commands",
			summary: "npm test",
			text: `${lineTexts(50).join("\n")}\n[Output exceeded 10 MB; the rest was not stored]\n`,
		});
		const output = [
			"line 1",
			`[... output truncated: 99999999 chars total. The first 10 MB of output is stored as tool output ${record?.id}; search it or read line ranges with tool_output instead of re-running the command ...]`,
			"FAILED: the final error",
		].join("\n");

		const result = applyCommandOutputView(output, { tail_lines: 1 }, options);

		expect(result).toContain("FAILED: the final error");
		expect(result).toContain(
			`The start of the output is stored as tool output ${record?.id}`,
		);
		expect(result).not.toContain("The full output is stored");
	});

	it("returns empty output unchanged", () => {
		const { store, options } = setup();
		expect(applyCommandOutputView("", { tail_lines: 5 }, options)).toBe("");
		expect(store.list(SESSION, 10)).toEqual([]);
	});

	it("shows only the first lines", () => {
		const { options } = setup();
		const result = applyCommandOutputView(
			lineTexts(100).join("\n"),
			{ head_lines: 3 },
			options,
		);
		expect(result).toContain("[Showing the first 3 of 100 lines.");
		expect(result).toContain(
			"--- first 3 lines ---\n1| line 1\n2| line 2\n3| line 3",
		);
		expect(result).not.toContain("line 4");
		expect(result).not.toContain("--- last");
	});

	it("shows only the last lines, numbered from their position", () => {
		const { options } = setup();
		const result = applyCommandOutputView(
			lineTexts(100).join("\n"),
			{ tail_lines: 2 },
			options,
		);
		expect(result).toContain("[Showing the last 2 of 100 lines.");
		expect(result).toContain(
			"--- last 2 lines ---\n99| line 99\n100| line 100",
		);
		expect(result).not.toContain("line 98");
		expect(result).not.toContain("--- first");
	});

	it("ignores a trailing newline when counting lines", () => {
		const { options } = setup();
		const result = applyCommandOutputView(
			`${lineTexts(100).join("\n")}\n`,
			{ tail_lines: 1 },
			options,
		);
		expect(result).toContain("of 100 lines.");
		expect(result).toContain("--- last 1 lines ---\n100| line 100");
	});

	it("shows head and tail together", () => {
		const { options } = setup();
		const result = applyCommandOutputView(
			lineTexts(100).join("\n"),
			{ head_lines: 2, tail_lines: 2 },
			options,
		);
		expect(result).toContain("[Showing the first 2, the last 2 of 100 lines.");
		expect(result.indexOf("--- first 2 lines ---")).toBeLessThan(
			result.indexOf("--- last 2 lines ---"),
		);
		expect(result).toContain("1| line 1\n2| line 2");
		expect(result).toContain("99| line 99\n100| line 100");
		expect(result).not.toContain("line 50");
	});

	it("does not repeat lines when head and tail overlap", () => {
		const { options } = setup();
		const result = applyCommandOutputView(
			lineTexts(10).join("\n"),
			{ head_lines: 6, tail_lines: 6, grep: "line 1\\b", context_lines: 0 },
			options,
		);
		expect(result).toContain("--- first 6 lines ---");
		expect(result).toContain("--- last 4 lines ---");
		expect(result).toContain("7| line 7\n8| line 8\n9| line 9\n10| line 10");
		expect(result).not.toContain("6| line 6\n7|");
	});

	it("returns the output unchanged when head and tail cover it and there is no grep", () => {
		const { store, options } = setup();
		const output = lineTexts(10).join("\n");
		expect(
			applyCommandOutputView(output, { head_lines: 5, tail_lines: 5 }, options),
		).toBe(output);
		expect(applyCommandOutputView(output, { head_lines: 50 }, options)).toBe(
			output,
		);
		expect(store.list(SESSION, 10)).toEqual([]);
	});

	it("still applies a grep when head and tail cover the output", () => {
		const { options } = setup();
		const result = applyCommandOutputView(
			lineTexts(10).join("\n"),
			{ head_lines: 10, grep: "line 5" },
			options,
		);
		expect(result).toContain("--- 1 lines match /line 5/ ---");
	});

	it("greps with context and separates distant matches with --", () => {
		const { options } = setup();
		const output = lineTexts(100);
		output[9] = "FAIL first";
		output[49] = "FAIL second";
		const result = applyCommandOutputView(
			output.join("\n"),
			{ grep: "FAIL", context_lines: 1 },
			options,
		);
		expect(result).toContain(
			"[Showing the lines matching /FAIL/ of 100 lines.",
		);
		expect(result).toContain("--- 2 lines match /FAIL/ ---");
		expect(result).toContain(
			[
				"9- line 9",
				"10: FAIL first",
				"11- line 11",
				"--",
				"49- line 49",
				"50: FAIL second",
				"51- line 51",
			].join("\n"),
		);
	});

	it("uses two lines of context by default and none when asked", () => {
		const { options } = setup();
		const output = lineTexts(50);
		output[24] = "needle";
		const text = output.join("\n");

		const withDefault = applyCommandOutputView(
			text,
			{ grep: "needle" },
			options,
		);
		expect(withDefault).toContain(
			[
				"23- line 23",
				"24- line 24",
				"25: needle",
				"26- line 26",
				"27- line 27",
			].join("\n"),
		);
		expect(withDefault).not.toContain("line 22");

		const bare = applyCommandOutputView(
			text,
			{ grep: "needle", context_lines: 0 },
			options,
		);
		expect(bare).toContain("--- 1 lines match /needle/ ---\n25: needle");
		expect(bare).not.toContain("line 24");
		expect(bare).not.toContain("line 26");
	});

	it("reports when no line matches", () => {
		const { options } = setup();
		const result = applyCommandOutputView(
			lineTexts(50).join("\n"),
			{ grep: "absent" },
			options,
		);
		expect(result).toContain("--- no lines match /absent/ ---");
		expect(result).not.toContain("lines match /absent/ ---\n");
	});

	it("shows grep matches and the tail together", () => {
		const { options } = setup();
		const output = lineTexts(100);
		output[19] = "ERROR early";
		const result = applyCommandOutputView(
			output.join("\n"),
			{ grep: "ERROR", context_lines: 0, tail_lines: 2 },
			options,
		);
		expect(result).toContain(
			"[Showing the lines matching /ERROR/, the last 2 of 100 lines.",
		);
		expect(result.indexOf("--- 1 lines match /ERROR/ ---")).toBeLessThan(
			result.indexOf("--- last 2 lines ---"),
		);
		expect(result).toContain("20: ERROR early");
		expect(result).toContain("99| line 99\n100| line 100");
	});

	it("shows head, grep and tail in that order", () => {
		const { options } = setup();
		const output = lineTexts(100);
		output[49] = "WARN middle";
		const result = applyCommandOutputView(
			output.join("\n"),
			{ head_lines: 1, grep: "WARN", context_lines: 0, tail_lines: 1 },
			options,
		);
		const first = result.indexOf("--- first 1 lines ---");
		const grep = result.indexOf("--- 1 lines match /WARN/ ---");
		const last = result.indexOf("--- last 1 lines ---");
		expect(first).toBeGreaterThanOrEqual(0);
		expect(first).toBeLessThan(grep);
		expect(grep).toBeLessThan(last);
	});

	it("falls back to a literal search for an invalid regex", () => {
		const { options } = setup();
		const output = lineTexts(50);
		output[29] = "call foo( now";
		const result = applyCommandOutputView(
			output.join("\n"),
			{ grep: "foo(", context_lines: 0 },
			options,
		);
		expect(result).toContain("--- 1 lines match /foo\\(/ ---");
		expect(result).toContain("30: call foo( now");
		expect(result).toContain(
			"[The pattern is not a valid regex; searched for it literally.]",
		);
	});

	it("does not add the literal note for a valid regex", () => {
		const { options } = setup();
		const result = applyCommandOutputView(
			lineTexts(50).join("\n"),
			{ grep: "line 1\\d" },
			options,
		);
		expect(result).not.toContain("not a valid regex");
	});

	it("notes when matches were cut off by the budget", () => {
		const { options } = setup({ maxChars: 400 });
		const output = Array.from({ length: 500 }, (_, index) => `match ${index}`);
		const result = applyCommandOutputView(
			output.join("\n"),
			{ grep: "match", context_lines: 0 },
			options,
		);
		expect(result).toContain("--- 500 lines match /match/ ---");
		expect(result).toContain("[Not all matches are shown.");
	});

	describe("storing the output", () => {
		it("stores the full output under the call id with the summary", () => {
			const { store, options } = setup();
			const output = lineTexts(100).join("\n");
			const result = applyCommandOutputView(output, { tail_lines: 2 }, options);

			const record = store.findByToolCall(SESSION, "call-1/command");
			expect(record).toMatchObject({
				toolName: "run_commands",
				summary: "npm test",
				agentId: "agent-1",
				lines: 100,
			});
			expect(store.readText(SESSION, record?.id ?? "")).toBe(output);
			expect(result).toContain(
				`The full output is stored as tool output ${record?.id}; search or read it with tool_output.]`,
			);
		});

		it("keys the store by the agent id when there is no session id", () => {
			const { store, options } = setup();
			options.context = { ...options.context, sessionId: undefined };
			applyCommandOutputView(
				lineTexts(100).join("\n"),
				{ head_lines: 1 },
				options,
			);
			expect(store.findByToolCall("agent-1", "call-1/command")).toBeDefined();
		});

		it("says the rest was not kept when there is no store", () => {
			const { options } = setup();
			options.context = { ...options.context, metadata: {} };
			const result = applyCommandOutputView(
				lineTexts(100).join("\n"),
				{ tail_lines: 2 },
				options,
			);
			expect(result).toContain("The rest of the output was not kept.]");
			expect(result).not.toContain("tool_output");
			expect(result).toContain("--- last 2 lines ---");
		});

		it("greps the stored full text when the output carries a stored notice", () => {
			const { store, options } = setup();
			const full = lineTexts(1000);
			full[499] = "SECRET only in the middle";
			const stored = store.put({
				sessionId: SESSION,
				toolCallId: "call-1",
				toolName: "run_commands",
				summary: "npm test",
				text: full.join("\n"),
			});
			const truncated = [
				...full.slice(0, 5),
				`[... output truncated: stored as tool output ${stored?.id}; search it ...]`,
				...full.slice(-5),
			].join("\n");

			const result = applyCommandOutputView(
				truncated,
				{ grep: "SECRET", context_lines: 0 },
				options,
			);

			expect(result).toContain(
				"--- 1 lines match /SECRET/ ---\n500: SECRET only in the middle",
			);
			expect(result).toContain("of 1000 lines.");
			expect(result).toContain(`stored as tool output ${stored?.id};`);
			expect(store.list(SESSION, 10)).toHaveLength(1);
		});

		it("takes head and tail from the stored full text too", () => {
			const { store, options } = setup();
			const full = lineTexts(1000);
			const stored = store.put({
				sessionId: SESSION,
				toolCallId: "call-1",
				toolName: "run_commands",
				summary: "npm test",
				text: full.join("\n"),
			});
			const truncated = `${full.slice(0, 5).join("\n")}\n[... stored as tool output ${stored?.id} ...]\n${full.slice(-5).join("\n")}`;
			const result = applyCommandOutputView(
				truncated,
				{ tail_lines: 2 },
				options,
			);
			expect(result).toContain("999| line 999\n1000| line 1000");
		});

		it("uses the output itself when the stored id is unknown", () => {
			const { options } = setup();
			const output = `${lineTexts(100).join("\n")}\n[stored as tool output deadbeef]`;
			const result = applyCommandOutputView(
				output,
				{ grep: "line 7\\b", context_lines: 0 },
				options,
			);
			expect(result).toContain("--- 1 lines match /line 7\\b/ ---\n7: line 7");
		});
	});

	describe("limits", () => {
		it("clips long lines at lineChars", () => {
			const { options } = setup({ lineChars: 50 });
			const output = lineTexts(20);
			output[19] = "x".repeat(500);
			output[4] = `needle ${"y".repeat(500)}`;
			const result = applyCommandOutputView(
				output.join("\n"),
				{ tail_lines: 1, grep: "needle", context_lines: 0 },
				options,
			);
			expect(result).toContain(`20| ${"x".repeat(46)} [line truncated]`);
			expect(result).not.toContain("x".repeat(47));
			expect(result).toContain("5: needle ");
			expect(result).not.toContain("y".repeat(50));
			expect(result.match(/\[line truncated\]/g)).toHaveLength(2);
		});

		it("caps the whole result at maxChars", () => {
			const { options } = setup({ maxChars: 500 });
			const output = Array.from(
				{ length: 2000 },
				(_, index) => `row ${index} ${"z".repeat(40)}`,
			);
			const result = applyCommandOutputView(
				output.join("\n"),
				{ head_lines: 500, tail_lines: 500 },
				options,
			);
			expect(result).toContain("[... output truncated:");
			expect(result.length).toBeLessThan(700);
			expect(
				result.startsWith(
					"[Showing the first 500, the last 500 of 2000 lines.",
				),
			).toBe(true);
		});
	});
});
