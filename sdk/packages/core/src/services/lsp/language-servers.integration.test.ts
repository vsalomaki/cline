import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodeIntelligenceProvider } from "../../extensions/tools/code-intelligence/types";
import {
	LanguageServerPool,
	LspCodeIntelligence,
} from "./lsp-code-intelligence";
import { findExecutable, resolveLanguageServers } from "./servers";

// Runs only where the real servers are on PATH, e.g.
// `npm i -g typescript-language-server typescript pyright`.
const hasTypescript = Boolean(
	findExecutable("typescript-language-server", { root: process.cwd() }),
);
const hasPyright = Boolean(
	findExecutable("pyright-langserver", { root: process.cwd() }),
);

const STARTUP_BUDGET_MS = 60_000;
const SETTLE_TIMEOUT_MS = 15_000;

function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
	const started = performance.now();
	return run().finally(() =>
		console.info(
			`[lsp timing] ${label}: ${Math.round(performance.now() - started)} ms`,
		),
	);
}

function setup(serverName: string, files: Record<string, string>) {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), `lsp-${serverName}-`)),
	);
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
		writeFileSync(path.join(root, name), text);
	}
	const servers = resolveLanguageServers(undefined, { root }).available.filter(
		(server) => server.name === serverName,
	);
	const pool = new LanguageServerPool({ idleDisposeMs: 0 });
	const provider = new LspCodeIntelligence({ root, servers, pool });
	return { root, provider, file: (name: string) => path.join(root, name) };
}

async function expectDiagnosticsCycle(
	provider: CodeIntelligenceProvider,
	file: string,
	broken: string,
	fixed: string,
	label: string,
) {
	writeFileSync(file, broken);
	const after = await timed(
		`${label} diagnostics after introducing an error`,
		() =>
			provider.diagnosticsAfterChange([file], { timeoutMs: SETTLE_TIMEOUT_MS }),
	);
	const errors = (after.get(file) ?? []).filter((d) => d.severity === "error");
	expect(errors.length).toBeGreaterThan(0);

	writeFileSync(file, fixed);
	const cleared = await timed(`${label} diagnostics after fixing it`, () =>
		provider.diagnosticsAfterChange([file], { timeoutMs: SETTLE_TIMEOUT_MS }),
	);
	expect(
		(cleared.get(file) ?? []).filter((d) => d.severity === "error"),
	).toEqual([]);
	return errors;
}

describe.skipIf(!hasTypescript)("typescript-language-server", () => {
	const mathSource = [
		"export interface Shape {",
		"\tarea(): number;",
		"}",
		"export class Square implements Shape {",
		"\tconstructor(private readonly side: number) {}",
		"\tarea(): number {",
		"\t\treturn this.side * this.side;",
		"\t}",
		"}",
		"export function add(a: number, b: number): number {",
		"\treturn a + b;",
		"}",
		"",
	].join("\n");
	const mainSource = [
		'import { add, Square } from "./math";',
		"",
		"export const total: number = add(1, 2);",
		"export const square = new Square(3).area();",
		"",
	].join("\n");
	let ctx: ReturnType<typeof setup>;

	beforeAll(() => {
		ctx = setup("typescript", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					target: "ES2022",
					module: "ESNext",
					noEmit: true,
				},
				include: ["src"],
			}),
			"src/math.ts": mathSource,
			"src/main.ts": mainSource,
		});
	});
	afterAll(async () => {
		await ctx.provider.release();
		rmSync(ctx.root, { recursive: true, force: true });
	});

	it("follows an import on the first request after opening a file", {
		timeout: STARTUP_BUDGET_MS,
	}, async () => {
		const main = ctx.file("src/main.ts");
		ctx.provider.prepare(main);
		await expect(
			timed("typescript startup + first definition", () =>
				ctx.provider.definition({ path: main, line: 3, column: 30 }),
			),
		).resolves.toEqual([
			{ path: ctx.file("src/math.ts"), line: 10, column: 17 },
		]);
	});

	it("answers navigation requests", {
		timeout: STARTUP_BUDGET_MS,
	}, async () => {
		const main = ctx.file("src/main.ts");
		const math = ctx.file("src/math.ts");
		const symbols = await timed("typescript document symbols", () =>
			ctx.provider.documentSymbols(math),
		);
		expect(symbols.map((s) => `${s.kind} ${s.name}`)).toEqual(
			expect.arrayContaining([
				"interface Shape",
				"class Square",
				"function add",
			]),
		);

		await expect(
			ctx.provider.definition({ path: main, line: 3, column: 30 }),
		).resolves.toEqual([{ path: math, line: 10, column: 17 }]);

		const references = await ctx.provider.references({
			path: math,
			line: 10,
			column: 17,
		});
		expect(references).toEqual(
			expect.arrayContaining([
				{ path: math, line: 10, column: 17 },
				{ path: main, line: 3, column: 30 },
			]),
		);

		expect(
			await ctx.provider.hover({ path: main, line: 3, column: 30 }),
		).toContain("add(a: number, b: number): number");

		await expect(
			ctx.provider.implementation({ path: math, line: 1, column: 18 }),
		).resolves.toEqual([{ path: math, line: 4, column: 14 }]);

		const workspace = await ctx.provider.workspaceSymbols("Square");
		expect(workspace).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "Square", kind: "class", path: math }),
			]),
		);
	});

	it("reports a type error after a change and clears it once fixed", {
		timeout: STARTUP_BUDGET_MS,
	}, async () => {
		const main = ctx.file("src/main.ts");
		ctx.provider.prepare(main);
		const errors = await expectDiagnosticsCycle(
			ctx.provider,
			main,
			mainSource.replace("add(1, 2)", 'add(1, "2")'),
			mainSource,
			"typescript",
		);
		expect(errors[0]).toMatchObject({
			line: 3,
			source: "typescript",
			code: "2345",
		});
	});
});

describe.skipIf(!hasPyright)("pyright", () => {
	const libSource = [
		"class Shape:",
		"    def area(self) -> float:",
		"        raise NotImplementedError",
		"",
		"",
		"class Square(Shape):",
		"    def area(self) -> float:",
		"        return 4.0",
		"",
		"",
		"def add(a: int, b: int) -> int:",
		"    return a + b",
		"",
	].join("\n");
	const mainSource = [
		"from shapes import add, Square",
		"",
		"total: int = add(1, 2)",
		"square = Square().area()",
		"",
	].join("\n");
	let ctx: ReturnType<typeof setup>;

	beforeAll(() => {
		ctx = setup("python", { "shapes.py": libSource, "main.py": mainSource });
	});
	afterAll(async () => {
		await ctx.provider.release();
		rmSync(ctx.root, { recursive: true, force: true });
	});

	it("answers navigation requests", {
		timeout: STARTUP_BUDGET_MS,
	}, async () => {
		const main = ctx.file("main.py");
		const lib = ctx.file("shapes.py");
		const symbols = await timed("pyright startup + document symbols", () =>
			ctx.provider.documentSymbols(lib),
		);
		expect(symbols.map((s) => `${s.kind} ${s.name}`)).toEqual(
			expect.arrayContaining(["class Shape", "class Square", "function add"]),
		);

		await expect(
			ctx.provider.definition({ path: main, line: 3, column: 14 }),
		).resolves.toEqual([{ path: lib, line: 11, column: 5 }]);

		const references = await ctx.provider.references({
			path: lib,
			line: 11,
			column: 5,
		});
		expect(references).toEqual(
			expect.arrayContaining([
				{ path: lib, line: 11, column: 5 },
				{ path: main, line: 3, column: 14 },
			]),
		);

		const hover = await ctx.provider.hover({ path: main, line: 3, column: 14 });
		expect(hover).toContain("def add(");
		expect(hover).toContain(") -> int");

		const workspace = await ctx.provider.workspaceSymbols("Square");
		expect(workspace).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "Square", kind: "class", path: lib }),
			]),
		);
	});

	it("reports a type error after a change and clears it once fixed", {
		timeout: STARTUP_BUDGET_MS,
	}, async () => {
		const main = ctx.file("main.py");
		ctx.provider.prepare(main);
		const errors = await expectDiagnosticsCycle(
			ctx.provider,
			main,
			mainSource.replace("add(1, 2)", 'add(1, "2")'),
			mainSource,
			"pyright",
		);
		expect(errors[0]).toMatchObject({ line: 3, source: "Pyright" });
	});
});
