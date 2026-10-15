import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createListFilesExecutor, listDirectoryTopLevel } from "./list-files";

const context = {} as AgentToolContext;

function write(root: string, relative: string, content = ""): void {
	const target = path.join(root, relative);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

describe("createListFilesExecutor", () => {
	let root: string;
	const list = createListFilesExecutor();

	beforeEach(() => {
		root = mkdtempSync(path.join(os.tmpdir(), "list-files-"));
		write(root, "README.md");
		write(root, "src/index.ts");
		write(root, "src/util/helpers.ts");
		write(root, "src/util/deep/leaf.ts");
		write(root, "node_modules/pkg/index.js");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("lists the top level by default, marking directories", async () => {
		const output = await list({ path: root }, "/", context);

		expect(output.split("\n")).toEqual([
			root,
			"node_modules/",
			"README.md",
			"src/",
		]);
	});

	it("resolves a relative path against cwd", async () => {
		const output = await list({ path: "src" }, root, context);

		expect(output.split("\n")[0]).toBe(path.join(root, "src"));
		expect(output).toContain("index.ts");
	});

	it("lists recursively as a tree, without expanding dependency directories", async () => {
		const output = await list({ path: root, recursive: true }, "/", context);
		const lines = output.split("\n");

		expect(lines.slice(1, 8)).toEqual([
			"node_modules/",
			"README.md",
			"src/",
			"src/index.ts",
			"src/util/",
			"src/util/deep/",
			"src/util/helpers.ts",
		]);
		expect(output).not.toContain("node_modules/pkg");
		// Depth 3 stops before src/util/deep/leaf.ts.
		expect(output).not.toContain("leaf.ts");
		expect(output).toContain("listed without their contents");
	});

	it("honors max_depth", async () => {
		const output = await list({ path: root, max_depth: 4 }, "/", context);

		expect(output).toContain("src/util/deep/leaf.ts");
	});

	it("truncates at the limit with a hint", async () => {
		const output = await list(
			{ path: root, recursive: true, limit: 2 },
			"/",
			context,
		);

		expect(output.split("\n").slice(1, 3)).toEqual([
			"node_modules/",
			"README.md",
		]);
		expect(output).toContain("(Truncated at 2 entries.");
	});

	it.runIf(hasGit())(
		"skips .gitignored entries in a git work tree",
		async () => {
			execFileSync("git", ["init", "-q"], { cwd: root });
			write(root, ".gitignore", "dist/\n*.log\n");
			write(root, "dist/bundle.js");
			write(root, "debug.log");

			const output = await list({ path: root, recursive: true }, "/", context);

			expect(output).not.toContain("dist/");
			expect(output).not.toContain("debug.log");
			expect(output).toContain(".gitignore");
			expect(output).toContain("src/index.ts");
		},
	);

	it("rejects a file path and points at read_files", async () => {
		await expect(
			list({ path: path.join(root, "README.md") }, "/", context),
		).rejects.toThrow("Use read_files to read it");
	});

	it("reports a missing directory", async () => {
		await expect(
			list({ path: path.join(root, "missing") }, "/", context),
		).rejects.toThrow("Directory not found");
	});

	it("refuses to list the home directory recursively", async () => {
		await expect(
			list({ path: os.homedir(), recursive: true }, "/", context),
		).rejects.toThrow("Refusing to list");
	});

	const canDenyAccess =
		process.platform !== "win32" && process.getuid?.() !== 0;

	it.runIf(canDenyAccess)(
		"fails when the listed directory cannot be read",
		async () => {
			const locked = path.join(root, "locked");
			mkdirSync(locked);
			chmodSync(locked, 0o000);
			try {
				await expect(list({ path: locked }, "/", context)).rejects.toThrow();
			} finally {
				chmodSync(locked, 0o755);
			}
		},
	);

	it.runIf(canDenyAccess)(
		"names unreadable subdirectories instead of hiding them",
		async () => {
			const locked = path.join(root, "src", "locked");
			mkdirSync(locked);
			chmodSync(locked, 0o000);
			try {
				const output = await list(
					{ path: root, recursive: true },
					"/",
					context,
				);
				expect(output).toContain("(Could not read: src/locked/)");
			} finally {
				chmodSync(locked, 0o755);
			}
		},
	);

	it.runIf(canDenyAccess)(
		"stops reading directories once the entry budget is spent",
		async () => {
			const wide = path.join(root, "wide");
			for (let i = 0; i < 50; i++) {
				write(wide, `dir${String(i).padStart(2, "0")}/file.txt`);
			}
			// Reading any of these would add a "Could not read" note.
			const locked = Array.from({ length: 40 }, (_, i) =>
				path.join(wide, `dir${i + 10}`),
			);
			for (const dir of locked) chmodSync(dir, 0o000);
			try {
				const output = await list(
					{ path: wide, recursive: true, limit: 55 },
					"/",
					context,
				);
				expect(output).toContain("(Truncated at 55 entries.");
				expect(output).not.toContain("Could not read");
			} finally {
				for (const dir of locked) chmodSync(dir, 0o755);
			}
		},
	);

	it("says so when a directory is empty", async () => {
		mkdirSync(path.join(root, "empty"));

		const output = await list({ path: path.join(root, "empty") }, "/", context);

		expect(output).toBe(`${path.join(root, "empty")}\nNo files found.`);
	});
});

describe("listDirectoryTopLevel", () => {
	it("lists one level", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "list-top-"));
		try {
			write(root, "a.txt");
			write(root, "sub/b.txt");

			expect(await listDirectoryTopLevel(root)).toBe(`${root}\na.txt\nsub/`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
