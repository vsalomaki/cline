import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LanguageServer } from "./language-server";
import {
	LanguageServerPool,
	LspCodeIntelligence,
} from "./lsp-code-intelligence";
import type { ResolvedLanguageServer } from "./servers";

const fixture = fileURLToPath(
	new URL("./__fixtures__/fake-lsp-server.mjs", import.meta.url),
);

const fakeServer: ResolvedLanguageServer = {
	name: "fake",
	command: [process.execPath, fixture],
	extensions: [".fake"],
	languageIds: { ".fake": "fakelang" },
	initializationOptions: { flavor: "test" },
	startupTimeoutMs: 10_000,
};

let root: string;
let providers: LspCodeIntelligence[];

function write(name: string, text: string): string {
	const file = path.join(root, name);
	writeFileSync(file, text);
	return file;
}

function track<T extends LspCodeIntelligence>(provider: T): T {
	providers.push(provider);
	return provider;
}

function createProvider(
	pool: LanguageServerPool,
	servers: ResolvedLanguageServer[] = [fakeServer],
): LspCodeIntelligence {
	return track(new LspCodeIntelligence({ root, servers, pool }));
}

function countingPool(
	options: { idleDisposeMs?: number; env?: NodeJS.ProcessEnv } = {},
) {
	const created: LanguageServer[] = [];
	const pool = new LanguageServerPool({
		idleDisposeMs: options.idleDisposeMs ?? 0,
		createServer: (config, serverRoot) => {
			const server = new LanguageServer(config, serverRoot, {
				...process.env,
				...options.env,
			});
			created.push(server);
			return server;
		},
	});
	return { pool, created };
}

const SOURCE = [
	"class Shape",
	"  method area",
	"function helper",
	"use helper here",
	"call helper again",
	"",
].join("\n");

beforeEach(() => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "lsp-provider-")));
	providers = [];
});

afterEach(async () => {
	await Promise.all(providers.map((provider) => provider.release()));
	rmSync(root, { recursive: true, force: true });
});

describe("LspCodeIntelligence against a fake server", () => {
	it("answers definition, implementation, references and hover with 1-based positions", async () => {
		const file = write("a.fake", SOURCE);
		const provider = createProvider(countingPool().pool);
		const position = { path: file, line: 4, column: 6 };

		await expect(provider.definition(position)).resolves.toEqual([
			{ path: file, line: 3, column: 10 },
		]);
		await expect(provider.implementation(position)).resolves.toEqual([
			{ path: file, line: 3, column: 10 },
		]);
		await expect(provider.references(position)).resolves.toEqual([
			{ path: file, line: 3, column: 10 },
			{ path: file, line: 4, column: 5 },
			{ path: file, line: 5, column: 6 },
		]);
		await expect(provider.hover(position)).resolves.toBe(
			"**helper** — ünïcødé ✓",
		);
	});

	it("turns a MarkedString array hover into text", async () => {
		const file = write("a.fake", "marked\n");
		const provider = createProvider(countingPool().pool);
		await expect(
			provider.hover({ path: file, line: 1, column: 1 }),
		).resolves.toBe("plain part\n\n```ts\nconst marked: 1\n```");
	});

	it("maps hierarchical document symbols and workspace symbols", async () => {
		const file = write("a.fake", SOURCE);
		const provider = createProvider(countingPool().pool);
		await expect(provider.workspaceSymbols("help")).rejects.toThrow(
			"No language server is running yet; call document_symbols or definition on a file first",
		);
		await expect(provider.documentSymbols(file)).resolves.toEqual([
			{
				name: "Shape",
				kind: "class",
				path: file,
				line: 1,
				column: 7,
				children: [
					{
						name: "area",
						kind: "method",
						path: file,
						line: 2,
						column: 10,
						containerName: "Shape",
					},
				],
			},
			{ name: "helper", kind: "function", path: file, line: 3, column: 10 },
		]);
		await expect(provider.workspaceSymbols("help")).resolves.toEqual([
			{ name: "helper", kind: "function", path: file, line: 3, column: 10 },
		]);
	});

	it("syncs a file changed on disk before answering", async () => {
		const file = write("a.fake", SOURCE);
		const provider = createProvider(countingPool().pool);
		await provider.documentSymbols(file);
		write("a.fake", `\n\n${SOURCE}`);
		await expect(
			provider.definition({ path: file, line: 6, column: 6 }),
		).resolves.toEqual([{ path: file, line: 5, column: 10 }]);
	});

	it("reports diagnostics after a change and clears them once fixed", async () => {
		const file = write("a.fake", "fine\n");
		const provider = createProvider(countingPool().pool);
		await expect(provider.diagnostics([file])).resolves.toEqual(new Map());

		provider.prepare(file);
		write("a.fake", "fine\nbad ERROR: Cannot find name 'x'.\nWARN: unused\n");
		const after = await provider.diagnosticsAfterChange([file], {
			timeoutMs: 5000,
		});
		expect(after.get(file)).toEqual([
			{
				severity: "error",
				message: "Cannot find name 'x'.",
				line: 2,
				column: 5,
				source: "fake",
				code: "1001",
			},
			{
				severity: "warning",
				message: "unused",
				line: 3,
				column: 1,
				source: "fake",
				code: "1001",
			},
		]);
		await expect(provider.diagnostics([file])).resolves.toEqual(after);

		write("a.fake", "fine\n");
		const fixed = await provider.diagnosticsAfterChange([file], {
			timeoutMs: 5000,
		});
		expect(fixed.get(file)).toEqual([]);
	});

	it.each([
		["without versions", {}],
		["with versions", { FAKE_LSP_VERSIONED: "1" }],
	])("waits past a stale publish of the previous diagnostics (%s)", async (_, env) => {
		const file = write("a.fake", "fine\n");
		const { pool } = countingPool({
			env: { FAKE_LSP_STALE: "1", FAKE_LSP_PUBLISH_DELAY_MS: "500", ...env },
		});
		const provider = createProvider(pool);
		await provider.diagnosticsAfterChange([file], { timeoutMs: 5000 });
		write("a.fake", "ERROR: new\n");
		const after = await provider.diagnosticsAfterChange([file], {
			timeoutMs: 5000,
		});
		expect(after.get(file)).toEqual([
			expect.objectContaining({ severity: "error", message: "new" }),
		]);
	});

	it("pulls diagnostics from a server that does not push them", async () => {
		const file = write("a.fake", "fine\n");
		const { pool } = countingPool({ env: { FAKE_LSP_PULL: "1" } });
		const provider = createProvider(pool);
		write("a.fake", "ERROR: pulled\n");
		const after = await provider.diagnosticsAfterChange([file], {
			timeoutMs: 5000,
		});
		expect(after.get(file)).toEqual([
			expect.objectContaining({ severity: "error", message: "pulled" }),
		]);
		write("a.fake", "fine\n");
		const started = Date.now();
		const fixed = await provider.diagnosticsAfterChange([file], {
			timeoutMs: 5000,
		});
		expect(fixed.get(file)).toEqual([]);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("rejects diagnosticsAfterChange when the signal aborts", async () => {
		const file = write("a.fake", "fine\n");
		const { pool } = countingPool({
			env: { FAKE_LSP_PUBLISH_DELAY_MS: "5000" },
		});
		const provider = createProvider(pool);
		await provider.documentSymbols(file);
		const controller = new AbortController();
		const pending = provider.diagnosticsAfterChange([file], {
			timeoutMs: 10_000,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(new Error("stopped")), 50);
		await expect(pending).rejects.toThrow("stopped");
	});

	it("returns at the timeout with what is known when the server is slow to publish", async () => {
		const file = write("a.fake", "ERROR: old\n");
		const { pool } = countingPool({
			env: { FAKE_LSP_PUBLISH_DELAY_MS: "5000" },
		});
		const provider = createProvider(pool);
		await provider.documentSymbols(file);
		const started = Date.now();
		const result = await provider.diagnosticsAfterChange([file], {
			timeoutMs: 200,
		});
		expect(Date.now() - started).toBeLessThan(2000);
		expect(result.get(file)).toEqual([]);
	});

	it("answers the server's own requests and passes initialize options", async () => {
		const file = write("a.fake", "STATE\n");
		const provider = createProvider(countingPool().pool);
		await provider.documentSymbols(file);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const state = JSON.parse(
			(await provider.hover({ path: file, line: 1, column: 1 })) ?? "{}",
		);
		expect(state).toMatchObject({
			processId: process.pid,
			rootPath: root,
			initializationOptions: { flavor: "test" },
			lastLanguageId: "fakelang",
			configuration: [null, null],
			register: null,
			folders: [{ name: path.basename(root) }],
			unknown: { error: -32601 },
		});
	});

	it("names the extension when no server handles a file", async () => {
		const provider = createProvider(countingPool().pool);
		await expect(
			provider.definition({
				path: path.join(root, "a.rb"),
				line: 1,
				column: 1,
			}),
		).rejects.toThrow("No language server is configured for .rb files");
		await expect(
			provider.diagnostics([path.join(root, "a.rb")]),
		).rejects.toThrow("No language server is configured for .rb files");
	});

	it("skips unhandled paths when some paths are handled", async () => {
		const file = write("a.fake", "ERROR: here\n");
		const provider = createProvider(countingPool().pool);
		const result = await provider.diagnosticsAfterChange(
			[file, path.join(root, "notes.md")],
			{ timeoutMs: 5000 },
		);
		expect([...result.keys()]).toEqual([file]);
		expect(result.get(file)).toHaveLength(1);
	});
});

describe("LanguageServerPool", () => {
	it("shares one server between sessions and disposes it when the last releases", async () => {
		const file = write("a.fake", SOURCE);
		const { pool, created } = countingPool();
		const first = createProvider(pool);
		const second = createProvider(pool);
		await first.documentSymbols(file);
		await second.documentSymbols(file);
		expect(created).toHaveLength(1);

		await first.release();
		expect(created[0].isDead).toBe(false);
		await expect(second.documentSymbols(file)).resolves.toHaveLength(2);

		await second.release();
		expect(created[0].isDead).toBe(true);
		expect(pool.size).toBe(0);

		const third = createProvider(pool);
		await third.documentSymbols(file);
		expect(created).toHaveLength(2);
	});

	it("keeps an idle server warm for the next session until the idle delay passes", async () => {
		const file = write("a.fake", SOURCE);
		const { pool, created } = countingPool({ idleDisposeMs: 300 });
		const first = createProvider(pool);
		await first.documentSymbols(file);
		await first.release();

		const second = createProvider(pool);
		await expect(second.workspaceSymbols("helper")).resolves.toEqual([]);
		await expect(second.documentSymbols(file)).resolves.toHaveLength(2);
		expect(created).toHaveLength(1);
		await second.release();

		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(created[0].isDead).toBe(true);
		expect(pool.size).toBe(0);
	});

	it("closes an idle server's documents so the next session reopens them from disk", async () => {
		const queried = write("a.fake", "STATE\n");
		const other = write("b.fake", "function before\n");
		const { pool, created } = countingPool({ idleDisposeMs: 60_000 });
		const first = createProvider(pool);
		await first.documentSymbols(queried);
		await first.documentSymbols(other);
		await first.release();

		write("b.fake", "function after\n");
		const second = createProvider(pool);
		const state = JSON.parse(
			(await second.hover({ path: queried, line: 1, column: 1 })) ?? "{}",
		);
		expect(created).toHaveLength(1);
		expect(state.closed).toEqual(
			expect.arrayContaining([
				pathToFileURL(queried).href,
				pathToFileURL(other).href,
			]),
		);
		await expect(second.workspaceSymbols("")).resolves.toEqual([]);
		await expect(second.documentSymbols(other)).resolves.toEqual([
			expect.objectContaining({ name: "after" }),
		]);
		await second.release();
		await created[0].dispose();
	});

	it("does not restart a crashed server within a session; a new session gets a new one", async () => {
		const file = write("a.fake", "CRASH\nfunction helper\n");
		const { pool, created } = countingPool();
		const provider = createProvider(pool);
		await expect(
			provider.hover({ path: file, line: 1, column: 1 }),
		).rejects.toThrow(
			"Language server fake exited: fake server crashed on purpose",
		);
		await expect(provider.documentSymbols(file)).rejects.toThrow(
			"Language server fake exited: fake server crashed on purpose",
		);
		expect(created).toHaveLength(1);

		const next = createProvider(pool);
		await expect(next.documentSymbols(file)).resolves.toHaveLength(1);
		expect(created).toHaveLength(2);
	});

	it("fails startup after the server's startup timeout", async () => {
		const file = write("a.fake", SOURCE);
		const { pool } = countingPool({ env: { FAKE_LSP_HANG_INITIALIZE: "1" } });
		const provider = createProvider(pool, [
			{ ...fakeServer, startupTimeoutMs: 200 },
		]);
		await expect(provider.documentSymbols(file)).rejects.toThrow(
			"Language server fake did not start within 200 ms",
		);
	});

	it("reports a server that is still starting instead of waiting past the timeout", async () => {
		const file = write("a.fake", SOURCE);
		const { pool } = countingPool({ env: { FAKE_LSP_HANG_INITIALIZE: "1" } });
		const provider = createProvider(pool);
		await expect(
			provider.diagnosticsAfterChange([file], { timeoutMs: 100 }),
		).rejects.toThrow(
			"Language server fake is still starting; try again shortly",
		);
	});

	it("reports a missing binary as a startup failure", async () => {
		const file = write("a.fake", SOURCE);
		const provider = createProvider(countingPool().pool, [
			{ ...fakeServer, command: [path.join(root, "does-not-exist")] },
		]);
		await expect(provider.documentSymbols(file)).rejects.toThrow(
			/Language server fake (failed to start|exited)/,
		);
	});
});
