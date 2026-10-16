import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLanguageServerProvider } from "./create-language-server-provider";
import {
	findExecutable,
	languageIdFor,
	resolveLanguageServers,
} from "./servers";

const posixOnly = process.platform === "win32" ? it.skip : it;

let root: string;
let binDir: string;

function makeExecutable(dir: string, name: string, mode = 0o755): string {
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	writeFileSync(file, "#!/bin/sh\n");
	chmodSync(file, mode);
	return file;
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lsp-servers-"));
	binDir = path.join(root, "bin");
	mkdirSync(binDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("findExecutable", () => {
	posixOnly("prefers the workspace node_modules/.bin over PATH", () => {
		makeExecutable(binDir, "tool");
		const local = makeExecutable(
			path.join(root, "node_modules", ".bin"),
			"tool",
		);
		expect(findExecutable("tool", { root, env: { PATH: binDir } })).toBe(local);
	});

	posixOnly(
		"searches PATH in order and skips files that are not executable",
		() => {
			const other = path.join(root, "other");
			makeExecutable(binDir, "tool", 0o644);
			const executable = makeExecutable(other, "tool");
			expect(
				findExecutable("tool", {
					root,
					env: { PATH: [binDir, other].join(path.delimiter) },
				}),
			).toBe(executable);
			expect(findExecutable("missing", { root, env: { PATH: binDir } })).toBe(
				undefined,
			);
		},
	);

	posixOnly("resolves a path relative to the workspace root", () => {
		const file = makeExecutable(path.join(root, "tools"), "server");
		expect(findExecutable("./tools/server", { root, env: { PATH: "" } })).toBe(
			file,
		);
	});
});

describe("resolveLanguageServers", () => {
	posixOnly("keeps only the built-in servers whose binary is found", () => {
		makeExecutable(binDir, "typescript-language-server");
		makeExecutable(binDir, "gopls");
		const { available, unavailable } = resolveLanguageServers(undefined, {
			root,
			env: { PATH: binDir },
		});
		expect(available.map((server) => server.name)).toEqual([
			"typescript",
			"go",
		]);
		expect(available[0]).toMatchObject({
			command: [path.join(binDir, "typescript-language-server"), "--stdio"],
			startupTimeoutMs: 20_000,
		});
		expect(unavailable.map((server) => server.name)).toEqual([
			"python",
			"java",
			"rust",
		]);
		expect(unavailable[0].binary).toBe(
			"pyright-langserver or basedpyright-langserver",
		);
	});

	posixOnly("falls back to basedpyright when pyright is missing", () => {
		makeExecutable(binDir, "basedpyright-langserver");
		const { available } = resolveLanguageServers(undefined, {
			root,
			env: { PATH: binDir },
		});
		expect(available).toEqual([
			expect.objectContaining({
				name: "python",
				command: [path.join(binDir, "basedpyright-langserver"), "--stdio"],
			}),
		]);
	});

	posixOnly(
		"gives jdtls a per-workspace data directory and a longer startup timeout",
		() => {
			vi.stubEnv("CLINE_DATA_DIR", path.join(root, "data"));
			makeExecutable(binDir, "jdtls");
			const [java] = resolveLanguageServers(undefined, {
				root,
				env: { PATH: binDir },
			}).available;
			const hash = createHash("sha1").update(root).digest("hex").slice(0, 12);
			expect(java.command).toEqual([
				path.join(binDir, "jdtls"),
				"-data",
				path.join(root, "data", "jdtls", hash),
			]);
			expect(java.startupTimeoutMs).toBe(60_000);
		},
	);

	posixOnly("lets configured servers replace, disable and add servers", () => {
		makeExecutable(binDir, "typescript-language-server");
		makeExecutable(binDir, "pyright-langserver");
		makeExecutable(binDir, "my-ts");
		makeExecutable(binDir, "ruby-lsp");
		const { available } = resolveLanguageServers(
			{
				servers: {
					ruby: {
						command: ["ruby-lsp"],
						extensions: ["RB", ".rake"],
						languageIds: { rb: "ruby" },
						startupTimeoutMs: 5000,
					},
					typescript: {
						command: ["my-ts", "--stdio"],
						extensions: [".ts"],
						initializationOptions: { a: 1 },
					},
					python: false,
					broken: { command: [], extensions: [".x"] } as never,
				},
			},
			{ root, env: { PATH: binDir } },
		);
		expect(available).toEqual([
			{
				name: "ruby",
				command: [path.join(binDir, "ruby-lsp")],
				extensions: [".rb", ".rake"],
				languageIds: { ".rb": "ruby" },
				initializationOptions: undefined,
				startupTimeoutMs: 5000,
			},
			{
				name: "typescript",
				command: [path.join(binDir, "my-ts"), "--stdio"],
				extensions: [".ts"],
				languageIds: {},
				initializationOptions: { a: 1 },
				startupTimeoutMs: 20_000,
			},
		]);
	});
});

describe("languageIdFor", () => {
	it("uses the server's mapping, then the known ids, then the extension itself", () => {
		const server = { languageIds: { ".ts": "custom" } };
		expect(languageIdFor(server, "/a/b.ts")).toBe("custom");
		expect(languageIdFor(server, "/a/B.TSX")).toBe("typescriptreact");
		expect(languageIdFor(server, "/a/b.pyi")).toBe("python");
		expect(languageIdFor(server, "/a/b.go")).toBe("go");
	});
});

describe("createLanguageServerProvider", () => {
	it("returns undefined when no configured server binary is found", () => {
		vi.stubEnv("PATH", binDir);
		expect(createLanguageServerProvider({ workspaceRoot: root })).toBe(
			undefined,
		);
	});

	posixOnly(
		"returns a provider when a server binary exists, without starting it",
		async () => {
			vi.stubEnv("PATH", binDir);
			makeExecutable(path.join(root, "node_modules", ".bin"), "gopls");
			const session = createLanguageServerProvider({ workspaceRoot: root });
			expect(session).toBeDefined();
			await expect(
				session?.provider.documentSymbols(path.join(root, "a.rb")),
			).rejects.toThrow("No language server is configured for .rb files");
			await expect(
				session?.provider.documentSymbols(path.join(root, "a.py")),
			).rejects.toThrow(
				"No language server is available for .py files: pyright-langserver or basedpyright-langserver was not found on PATH",
			);
			await session?.release();
		},
	);
});
