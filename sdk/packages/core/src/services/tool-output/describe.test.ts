import { describe, expect, it } from "vitest";
import { describeToolCall } from "./describe";

describe("describeToolCall", () => {
	it("uses a run_commands string as is", () => {
		expect(describeToolCall("npm test -- --run")).toBe("npm test -- --run");
	});

	it("joins a structured command with its args", () => {
		expect(
			describeToolCall({ command: "git", args: ["log", "--oneline", "-5"] }),
		).toBe("git log --oneline -5");
	});

	it("lists every command of a commands array", () => {
		expect(
			describeToolCall({
				commands: ["ls -la", { command: "git", args: ["status"] }],
			}),
		).toBe("ls -la, git status");
	});

	it("reads a command field", () => {
		expect(describeToolCall({ command: "make all" })).toBe("make all");
	});

	it("shows read_files paths with their line ranges", () => {
		expect(
			describeToolCall({
				files: [
					{ path: "src/a.ts", start_line: 10, end_line: 40 },
					{ path: "src/b.ts", start_line: 5 },
					"src/c.ts",
					{ path: "src/d.ts" },
				],
			}),
		).toBe("src/a.ts:10-40, src/b.ts:5-end, src/c.ts, src/d.ts");
	});

	it("shows a single path", () => {
		expect(describeToolCall({ path: "README.md" })).toBe("README.md");
		expect(describeToolCall({ file_path: "docs/x.md" })).toBe("docs/x.md");
	});

	it("shows search queries", () => {
		expect(describeToolCall({ queries: ["useState", "useEffect"] })).toBe(
			"useState, useEffect",
		);
		expect(describeToolCall({ query: "TODO" })).toBe("TODO");
		expect(describeToolCall({ pattern: "foo.*bar" })).toBe("foo.*bar");
	});

	it("shows fetch requests and urls", () => {
		expect(
			describeToolCall({
				requests: [
					{ url: "https://example.com/a", prompt: "summarize" },
					{ url: "https://example.com/b" },
				],
			}),
		).toBe("https://example.com/a, https://example.com/b");
		expect(describeToolCall({ urls: ["https://example.com"] })).toBe(
			"https://example.com",
		);
	});

	it("shows a skill name", () => {
		expect(describeToolCall({ skill: "review", args: "x" })).toBe("review");
	});

	it("collapses whitespace into one line", () => {
		expect(describeToolCall("echo a\n  echo   b\n")).toBe("echo a echo b");
	});

	it("falls back to JSON for an unknown input", () => {
		expect(describeToolCall({ foo: 1, bar: "x" })).toBe('{"foo":1,"bar":"x"}');
		expect(describeToolCall({})).toBe("{}");
	});

	it("handles inputs without a JSON form", () => {
		expect(describeToolCall(undefined)).toBe("");
		expect(describeToolCall(null)).toBe("null");
	});

	it("caps the summary at 200 characters", () => {
		const summary = describeToolCall("x".repeat(500));

		expect(summary).toHaveLength(200);
		expect(summary.endsWith("…")).toBe(true);
		expect(describeToolCall("y".repeat(200))).toBe("y".repeat(200));
	});

	it("stops collecting once the cap is reached", () => {
		const summary = describeToolCall({
			queries: Array.from({ length: 100 }, (_, n) => `query-number-${n}`),
		});

		expect(summary.length).toBeLessThanOrEqual(200);
		expect(summary).toContain("query-number-0");
		expect(summary).not.toContain("query-number-99");
	});

	it("caps a fallback JSON summary too", () => {
		const summary = describeToolCall({ unknown: "z".repeat(500) });

		expect(summary).toHaveLength(200);
	});
});
