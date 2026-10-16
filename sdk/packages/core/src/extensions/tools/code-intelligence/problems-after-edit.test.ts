import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplyPatchExecutor } from "../executors/apply-patch";
import { createEditorExecutor } from "../executors/editor";
import { createFileReadExecutor } from "../executors/file-read";
import { createFakeCodeIntelligence } from "./fake-provider.fixtures";
import {
	createCodeIntelligenceMetadata,
	diffNewProblems,
	filterBySeverity,
	formatNewProblems,
} from "./problems-after-edit";
import type { CodeDiagnostic, CodeIntelligenceProvider } from "./types";

function diagnostic(
	message: string,
	line = 1,
	severity: CodeDiagnostic["severity"] = "error",
): CodeDiagnostic {
	return { severity, message, line, column: 1, source: "ts" };
}

describe("diffNewProblems", () => {
	it("ignores positions, so problems the edit only moved are not new", () => {
		expect(diffNewProblems([diagnostic("A", 3)], [diagnostic("A", 9)])).toEqual(
			[],
		);
	});

	it("counts duplicate messages as a multiset", () => {
		const before = [diagnostic("Unused", 1)];
		const after = [diagnostic("Unused", 1), diagnostic("Unused", 5)];
		expect(diffNewProblems(before, after)).toEqual([diagnostic("Unused", 5)]);
	});

	it("treats a different severity, source or code as a different problem", () => {
		const before = [diagnostic("A")];
		expect(
			diffNewProblems(before, [
				diagnostic("A", 1, "warning"),
				{ ...diagnostic("A"), source: "eslint" },
				{ ...diagnostic("A"), code: "1" },
			]),
		).toHaveLength(3);
	});
});

describe("filterBySeverity", () => {
	const all = [
		diagnostic("e", 1, "error"),
		diagnostic("w", 1, "warning"),
		diagnostic("i", 1, "information"),
		diagnostic("h", 1, "hint"),
	];

	it("keeps errors, or errors and warnings", () => {
		expect(filterBySeverity(all, "errors").map((d) => d.message)).toEqual([
			"e",
		]);
		expect(filterBySeverity(all, "warnings").map((d) => d.message)).toEqual([
			"e",
			"w",
		]);
	});
});

describe("formatNewProblems", () => {
	it("groups problems by file, relative to cwd, and caps each file at 20", () => {
		const many = Array.from({ length: 22 }, (_, i) =>
			diagnostic(`P${i}`, i + 1),
		);
		const text = formatNewProblems(
			new Map([
				[
					"/w/src/foo.ts",
					[
						{
							...diagnostic("Cannot find name 'bar'.", 12),
							column: 5,
							code: "2304",
						},
					],
				],
				["/w/empty.ts", []],
				["/w/many.ts", many],
			]),
			"/w",
		);
		const lines = text.split("\n");
		expect(lines.slice(0, 4)).toEqual([
			"New problems after this edit:",
			"src/foo.ts",
			"  12:5 error: Cannot find name 'bar'. [ts 2304]",
			"many.ts",
		]);
		expect(lines).toHaveLength(4 + 20 + 1);
		expect(lines.at(-1)).toBe("  … 2 more not shown");
		expect(formatNewProblems(new Map([["/w/a.ts", []]]), "/w")).toBe("");
	});
});

/** Reports a problem for every line containing ERROR: or WARN:, read from disk. */
function markerDiagnostics(text: string): CodeDiagnostic[] {
	return text.split("\n").flatMap((line, index) => {
		const match = line.match(/(ERROR|WARN): (.*)/);
		if (!match) return [];
		return [
			diagnostic(
				match[2] ?? "",
				index + 1,
				match[1] === "ERROR" ? "error" : "warning",
			),
		];
	});
}

async function diagnosticsFromDisk(
	paths: string[],
): Promise<Map<string, CodeDiagnostic[]>> {
	const result = new Map<string, CodeDiagnostic[]>();
	for (const filePath of paths) {
		const text = await fs.readFile(filePath, "utf8").catch(() => "");
		result.set(filePath, markerDiagnostics(text));
	}
	return result;
}

function markerProvider(
	overrides: Partial<CodeIntelligenceProvider> = {},
): CodeIntelligenceProvider {
	return createFakeCodeIntelligence({
		diagnostics: diagnosticsFromDisk,
		diagnosticsAfterChange: diagnosticsFromDisk,
		...overrides,
	});
}

function contextWith(
	provider: CodeIntelligenceProvider,
	problemsAfterEdit: "off" | "errors" | "warnings" = "errors",
): AgentToolContext {
	return {
		agentId: "agent-1",
		iteration: 1,
		metadata: createCodeIntelligenceMetadata(provider, {
			problemsAfterEdit,
			problemsTimeoutMs: 100,
		}),
	};
}

describe("problems after an edit", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "problems-after-edit-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("appends only the problems the editor introduced", async () => {
		const file = path.join(dir, "a.ts");
		await fs.writeFile(file, "const x = 1;\nERROR: old one\n");
		const result = await createEditorExecutor()(
			{
				path: file,
				old_text: "const x = 1;",
				new_text: "// moved\nERROR: new one\nWARN: style",
			},
			dir,
			contextWith(markerProvider()),
		);
		expect(result).toMatch(
			/\n\nNew problems after this edit:\na\.ts\n {2}2:1 error: new one \[ts\]$/,
		);
	});

	it("includes warnings at the warnings level and nothing when off", async () => {
		const file = path.join(dir, "a.ts");
		await fs.writeFile(file, "x\n");
		const edit = (level: "off" | "warnings") =>
			createEditorExecutor()(
				{ path: file, insert_line: 1, new_text: `WARN: ${level}` },
				dir,
				contextWith(markerProvider(), level),
			);
		expect(await edit("warnings")).toContain("1:1 warning: warnings [ts]");
		expect(await edit("off")).not.toContain("New problems");
	});

	it("appends nothing when the edit adds no problems", async () => {
		const file = path.join(dir, "a.ts");
		const result = await createEditorExecutor()(
			{ path: file, new_text: "const ok = true;\n" },
			dir,
			contextWith(markerProvider()),
		);
		expect(result).not.toContain("New problems");
	});

	it("never fails the edit when the provider errors", async () => {
		const file = path.join(dir, "a.ts");
		await fs.writeFile(file, "a\n");
		const failing = markerProvider({
			diagnosticsAfterChange: async () => {
				throw new Error("server crashed");
			},
		});
		const result = await createEditorExecutor()(
			{ path: file, old_text: "a", new_text: "ERROR: b" },
			dir,
			contextWith(failing),
		);
		expect(result).not.toContain("New problems");
		expect(await fs.readFile(file, "utf8")).toBe("ERROR: b\n");

		const failingBefore = markerProvider({
			diagnostics: () => {
				throw new Error("not ready");
			},
		});
		await expect(
			createEditorExecutor()(
				{ path: file, old_text: "ERROR: b", new_text: "c" },
				dir,
				contextWith(failingBefore),
			),
		).resolves.not.toContain("New problems");
	});

	it("checks every added or updated file of a patch and skips deletions", async () => {
		await fs.writeFile(path.join(dir, "keep.ts"), "one\n");
		await fs.writeFile(path.join(dir, "gone.ts"), "ERROR: gone\n");
		const asked: string[][] = [];
		const provider = markerProvider({
			diagnosticsAfterChange: async (paths) => {
				asked.push(paths);
				return diagnosticsFromDisk(paths);
			},
		});
		const result = await createApplyPatchExecutor()(
			{
				input: [
					"*** Begin Patch",
					"*** Update File: keep.ts",
					"@@",
					"-one",
					"+ERROR: changed",
					"*** Add File: new.ts",
					"+ERROR: added",
					"*** Delete File: gone.ts",
					"*** End Patch",
				].join("\n"),
			},
			dir,
			contextWith(provider),
		);
		expect(asked).toEqual([
			[path.join(dir, "keep.ts"), path.join(dir, "new.ts")],
		]);
		expect(result).toContain(
			"New problems after this edit:\nkeep.ts\n  1:1 error: changed [ts]\nnew.ts\n  1:1 error: added [ts]",
		);
	});

	it("skips a file the patch moves", async () => {
		await fs.writeFile(path.join(dir, "old.ts"), "ERROR: existing\n");
		const asked: string[][] = [];
		const provider = markerProvider({
			diagnosticsAfterChange: async (paths) => {
				asked.push(paths);
				return diagnosticsFromDisk(paths);
			},
		});
		const result = await createApplyPatchExecutor()(
			{
				input: [
					"*** Begin Patch",
					"*** Update File: old.ts",
					"*** Move to: moved.ts",
					"@@",
					"-ERROR: existing",
					"+ERROR: existing",
					"*** End Patch",
				].join("\n"),
			},
			dir,
			contextWith(provider),
		);
		expect(asked).toEqual([]);
		expect(result).not.toContain("New problems");
	});

	it("checks a file the provider knows nothing about before writing it", async () => {
		const file = path.join(dir, "a.ts");
		await fs.writeFile(file, "x\nERROR: old one\n");
		const asked: string[][] = [];
		const provider = createFakeCodeIntelligence({
			diagnosticsAfterChange: async (paths) => {
				asked.push(paths);
				return diagnosticsFromDisk(paths);
			},
		});
		const result = await createEditorExecutor()(
			{ path: file, old_text: "x", new_text: "ERROR: new one" },
			dir,
			contextWith(provider),
		);
		expect(asked).toEqual([[file], [file]]);
		expect(result).toMatch(
			/\n\nNew problems after this edit:\na\.ts\n {2}1:1 error: new one \[ts\]$/,
		);
	});

	it("does not wait for a baseline of a file the edit creates", async () => {
		const file = path.join(dir, "new.ts");
		const asked: string[][] = [];
		const provider = createFakeCodeIntelligence({
			diagnosticsAfterChange: async (paths) => {
				asked.push(paths);
				return diagnosticsFromDisk(paths);
			},
		});
		const result = await createEditorExecutor()(
			{ path: file, new_text: "ERROR: added\n" },
			dir,
			contextWith(provider),
		);
		expect(asked).toEqual([[file]]);
		expect(result).toContain("new.ts\n  1:1 error: added [ts]");
	});

	it("leaves out a file whose baseline check fails", async () => {
		const known = path.join(dir, "known.ts");
		const unknown = path.join(dir, "unknown.ts");
		await fs.writeFile(known, "one\n");
		await fs.writeFile(unknown, "two\n");
		const asked: string[][] = [];
		const provider = createFakeCodeIntelligence({
			diagnostics: async (paths) =>
				diagnosticsFromDisk(paths.filter((filePath) => filePath === known)),
			diagnosticsAfterChange: async (paths) => {
				asked.push(paths);
				if (asked.length === 1) {
					throw new Error("server still starting");
				}
				return diagnosticsFromDisk(paths);
			},
		});
		const result = await createApplyPatchExecutor()(
			{
				input: [
					"*** Begin Patch",
					"*** Update File: known.ts",
					"@@",
					"-one",
					"+ERROR: in known",
					"*** Update File: unknown.ts",
					"@@",
					"-two",
					"+ERROR: in unknown",
					"*** End Patch",
				].join("\n"),
			},
			dir,
			contextWith(provider),
		);
		expect(asked).toEqual([[unknown], [known]]);
		expect(result).toContain(
			"New problems after this edit:\nknown.ts\n  1:1 error: in known [ts]",
		);
		expect(result).not.toContain("error: in unknown");
	});

	it("asks the provider to track each file read_files returns", async () => {
		const file = path.join(dir, "a.ts");
		await fs.writeFile(file, "x\n");
		const provider = createFakeCodeIntelligence();
		await createFileReadExecutor({ cwd: dir })(
			{ path: "a.ts" },
			contextWith(provider),
		);
		expect(provider.prepared).toEqual([file]);
	});
});
