import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CodeDiagnostic, CodeLocation, CodeSymbol } from "./types";

export const MAX_RESULTS = 50;
export const MAX_HOVER_CHARS = 4000;

/** Relative to cwd when inside it, otherwise absolute. */
export function displayPath(absolutePath: string, cwd: string): string {
	const relative = path.relative(cwd, absolutePath);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
		? relative
		: absolutePath;
}

function moreNotShown(total: number): string[] {
	return total > MAX_RESULTS ? [`… ${total - MAX_RESULTS} more not shown`] : [];
}

async function readLines(filePath: string): Promise<string[] | undefined> {
	try {
		return (await fs.readFile(filePath, "utf8")).split(/\r?\n/);
	} catch {
		return undefined;
	}
}

export async function formatLocations(
	locations: CodeLocation[],
	cwd: string,
): Promise<string> {
	if (locations.length === 0) {
		return "No results.";
	}
	const shown = locations.slice(0, MAX_RESULTS);
	const files = new Map<string, Promise<string[] | undefined>>();
	const lines = await Promise.all(
		shown.map(async (location) => {
			let file = files.get(location.path);
			if (!file) {
				file = readLines(location.path);
				files.set(location.path, file);
			}
			const source = (await file)?.[location.line - 1]?.trim();
			const position = `${displayPath(location.path, cwd)}:${location.line}:${location.column}`;
			return source ? `${position}  ${source}` : position;
		}),
	);
	return [...lines, ...moreNotShown(locations.length)].join("\n");
}

export function formatSymbols(
	symbols: CodeSymbol[],
	cwd: string,
	options: { withPath: boolean },
): string {
	if (symbols.length === 0) {
		return "No symbols.";
	}
	const lines: string[] = [];
	let total = 0;
	const visit = (symbol: CodeSymbol, depth: number) => {
		total++;
		if (lines.length < MAX_RESULTS) {
			const where = options.withPath
				? `${displayPath(symbol.path, cwd)}:${symbol.line}`
				: `line ${symbol.line}`;
			const container =
				options.withPath && symbol.containerName
					? ` (in ${symbol.containerName})`
					: "";
			lines.push(
				`${"  ".repeat(depth)}${symbol.kind} ${symbol.name}${container} — ${where}`,
			);
		}
		for (const child of symbol.children ?? []) {
			visit(child, depth + 1);
		}
	};
	for (const symbol of symbols) {
		visit(symbol, 0);
	}
	return [...lines, ...moreNotShown(total)].join("\n");
}

export function formatHover(text: string | undefined): string {
	const trimmed = text?.trim();
	if (!trimmed) {
		return "No hover information.";
	}
	return trimmed.length > MAX_HOVER_CHARS
		? `${trimmed.slice(0, MAX_HOVER_CHARS)}… (truncated)`
		: trimmed;
}

export function formatDiagnostic(diagnostic: CodeDiagnostic): string {
	const origin = [diagnostic.source, diagnostic.code].filter(Boolean).join(" ");
	return `${diagnostic.line}:${diagnostic.column} ${diagnostic.severity}: ${diagnostic.message}${origin ? ` [${origin}]` : ""}`;
}

export function formatDiagnostics(diagnostics: CodeDiagnostic[]): string {
	if (diagnostics.length === 0) {
		return "No problems.";
	}
	return [
		...diagnostics.slice(0, MAX_RESULTS).map(formatDiagnostic),
		...moreNotShown(diagnostics.length),
	].join("\n");
}
