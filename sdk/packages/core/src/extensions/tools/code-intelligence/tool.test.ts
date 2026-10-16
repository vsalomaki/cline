import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinTools } from "../index";
import { createFakeCodeIntelligence } from "./fake-provider.fixtures";
import {
	formatDiagnostics,
	formatHover,
	formatLocations,
	formatSymbols,
	MAX_HOVER_CHARS,
	MAX_RESULTS,
} from "./format";
import {
	createCodeIntelligenceTool,
	findSymbolColumn,
	resolveSymbolPosition,
} from "./tool";
import type {
	CodeIntelligenceProvider,
	CodeLocation,
	CodePosition,
} from "./types";

const context: AgentToolContext = { agentId: "agent-1", iteration: 1 };

describe("findSymbolColumn", () => {
	it("matches whole words only and returns a 1-based column", () => {
		expect(findSymbolColumn("const fooBar = foo(1);", "foo")).toBe(16);
		expect(findSymbolColumn("foo", "foo")).toBe(1);
		expect(findSymbolColumn("const fooBar = 1;", "foo")).toBeUndefined();
		expect(findSymbolColumn("let $el = $el2;", "$el")).toBe(5);
	});

	it("falls back to a substring match for a symbol that is not a word", () => {
		expect(findSymbolColumn("a += b;", "+=")).toBe(3);
		expect(findSymbolColumn("this.value.x", "value.x")).toBe(6);
		expect(findSymbolColumn("a - b", "+")).toBeUndefined();
	});
});

describe("resolveSymbolPosition", () => {
	const text = [
		"import { foo } from './foo';", // 1
		"", // 2
		"function bar() {", // 3
		"  return foo();", // 4
		"}", // 5
		"foo();", // 6
		"const x = 1;", // 7
	].join("\n");

	it("returns the first occurrence on the line", () => {
		expect(resolveSymbolPosition(text, "/w/a.ts", 4, "foo")).toEqual({
			path: "/w/a.ts",
			line: 4,
			column: 10,
		});
	});

	it("quotes the line and lists nearby lines that contain the symbol", () => {
		expect(() =>
			resolveSymbolPosition(text, "/w/a.ts", 5, "foo", "a.ts"),
		).toThrowErrorMatchingInlineSnapshot(`
				[Error: "foo" is not on line 5 of a.ts: "}"
				Nearby lines that contain it:
				  4: return foo();
				  6: foo();]
			`);
	});

	it("says when no nearby line contains the symbol", () => {
		expect(() => resolveSymbolPosition(text, "/w/a.ts", 3, "zap")).toThrow(
			/"zap" is not on line 3 of \/w\/a.ts: "function bar\(\) \{"\nNo line within 2 lines/,
		);
	});

	it("rejects a line past the end of the file", () => {
		expect(() => resolveSymbolPosition(text, "/w/a.ts", 99, "foo")).toThrow(
			"Line 99 is past the end of /w/a.ts, which has 7 lines.",
		);
	});
});

describe("formatting", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-format-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("prints locations relative to cwd with their trimmed source line", async () => {
		const file = path.join(dir, "src", "a.ts");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, "line one\n    const foo = 1;\n");
		const outside = path.join(os.tmpdir(), "elsewhere-not-a-file.ts");
		expect(
			await formatLocations(
				[
					{ path: file, line: 2, column: 11 },
					{ path: outside, line: 1, column: 1 },
				],
				dir,
			),
		).toBe(`src/a.ts:2:11  const foo = 1;\n${outside}:1:1`);
		expect(await formatLocations([], dir)).toBe("No results.");
	});

	it("caps locations at the result limit", async () => {
		const locations: CodeLocation[] = Array.from({ length: 53 }, (_, i) => ({
			path: path.join(dir, "missing.ts"),
			line: i + 1,
			column: 1,
		}));
		const lines = (await formatLocations(locations, dir)).split("\n");
		expect(lines).toHaveLength(MAX_RESULTS + 1);
		expect(lines.at(-1)).toBe("… 3 more not shown");
	});

	it("prints symbols as an indented outline", () => {
		expect(
			formatSymbols(
				[
					{
						name: "Widget",
						kind: "class",
						path: path.join(dir, "a.ts"),
						line: 1,
						column: 1,
						children: [
							{
								name: "render",
								kind: "method",
								path: path.join(dir, "a.ts"),
								line: 3,
								column: 3,
							},
						],
					},
				],
				dir,
				{ withPath: false },
			),
		).toBe("class Widget — line 1\n  method render — line 3");
		expect(
			formatSymbols(
				[
					{
						name: "render",
						kind: "method",
						path: path.join(dir, "a.ts"),
						line: 3,
						column: 3,
						containerName: "Widget",
					},
				],
				dir,
				{ withPath: true },
			),
		).toBe("method render (in Widget) — a.ts:3");
	});

	it("truncates hover text", () => {
		expect(formatHover("  (x: number) => void  ")).toBe("(x: number) => void");
		expect(formatHover(undefined)).toBe("No hover information.");
		const long = formatHover("x".repeat(MAX_HOVER_CHARS + 10));
		expect(long).toBe(`${"x".repeat(MAX_HOVER_CHARS)}… (truncated)`);
	});

	it("prints diagnostics with source and code", () => {
		expect(
			formatDiagnostics([
				{
					severity: "error",
					message: "Cannot find name 'bar'.",
					line: 12,
					column: 5,
					source: "ts",
					code: "2304",
				},
				{ severity: "warning", message: "Unused.", line: 1, column: 1 },
			]),
		).toBe(
			"12:5 error: Cannot find name 'bar'. [ts 2304]\n1:1 warning: Unused.",
		);
		expect(formatDiagnostics([])).toBe("No problems.");
	});
});

describe("code_intelligence tool", () => {
	let dir: string;
	let file: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-tool-"));
		file = path.join(dir, "a.ts");
		await fs.writeFile(file, "export function foo() {}\nfoo();\n");
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	function run(provider: CodeIntelligenceProvider, input: unknown) {
		return createCodeIntelligenceTool(provider, { cwd: dir }).execute(
			input as never,
			context,
		);
	}

	it("resolves the symbol's column before asking the provider", async () => {
		const asked: CodePosition[] = [];
		const provider = createFakeCodeIntelligence({
			definition: async (position) => {
				asked.push(position);
				return [{ path: file, line: 1, column: 17 }];
			},
		});
		const result = await run(provider, {
			operation: "definition",
			path: "a.ts",
			line: 2,
			symbol: "foo",
		});
		expect(asked).toEqual([{ path: file, line: 2, column: 1 }]);
		expect(result).toBe("a.ts:1:17  export function foo() {}");
	});

	it("resolves the column from the provider's text when it differs from the disk", async () => {
		const asked: CodePosition[] = [];
		const provider = createFakeCodeIntelligence({
			readText: async () => "export function foo() {}\nconst y = foo();\n",
			hover: async (position) => {
				asked.push(position);
				return "foo";
			},
		});
		await run(provider, {
			operation: "hover",
			path: "a.ts",
			line: 2,
			symbol: "foo",
		});
		expect(asked).toEqual([{ path: file, line: 2, column: 11 }]);
		await expect(
			run(provider, {
				operation: "hover",
				path: "a.ts",
				line: 3,
				symbol: "foo",
			}),
		).rejects.toThrow("  2: const y = foo();");
	});

	it("names the missing fields", async () => {
		const provider = createFakeCodeIntelligence();
		await expect(
			run(provider, { operation: "references", path: "a.ts" }),
		).rejects.toThrow("references needs `line` and `symbol`.");
		await expect(run(provider, { operation: "hover" })).rejects.toThrow(
			"hover needs `path`.",
		);
		await expect(
			run(provider, { operation: "workspace_symbols", query: " " }),
		).rejects.toThrow("workspace_symbols needs `query`.");
	});

	it("surfaces a provider error message", async () => {
		const provider = createFakeCodeIntelligence({
			documentSymbols: async () => {
				throw new Error("No language server is configured for .ts files");
			},
		});
		await expect(
			run(provider, { operation: "document_symbols", path: file }),
		).rejects.toThrow("No language server is configured for .ts files");
	});

	it("waits for a file's diagnostics", async () => {
		const provider = createFakeCodeIntelligence({
			diagnosticsAfterChange: async (paths) =>
				new Map([
					[
						paths[0] ?? "",
						[{ severity: "error", message: "Bad.", line: 2, column: 1 }],
					],
				]),
		});
		expect(
			await run(provider, { operation: "diagnostics", path: "a.ts" }),
		).toBe("2:1 error: Bad.");
	});

	it("is registered only when the session has a provider", () => {
		const names = (codeIntelligence?: CodeIntelligenceProvider) =>
			createBuiltinTools({ cwd: dir, codeIntelligence }).map(
				(tool) => tool.name,
			);
		expect(names()).not.toContain("code_intelligence");
		expect(names(createFakeCodeIntelligence())).toContain("code_intelligence");
		expect(
			createBuiltinTools({
				cwd: dir,
				codeIntelligence: createFakeCodeIntelligence(),
				enableCodeIntelligence: false,
			}).map((tool) => tool.name),
		).not.toContain("code_intelligence");
	});
});
