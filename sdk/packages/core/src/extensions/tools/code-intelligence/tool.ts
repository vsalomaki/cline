import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AgentTool,
	createTool,
	validateWithZod,
	zodToJsonSchema,
} from "@cline/shared";
import { resolveExistingFilePath } from "@cline/shared/storage";
import { z } from "zod";
import { DEFAULT_PROBLEMS_TIMEOUT_MS } from "../../../settings/code-intelligence";
import { withTimeout } from "../helpers";
import {
	displayPath,
	formatDiagnostics,
	formatHover,
	formatLocations,
	formatSymbols,
} from "./format";
import type { CodeIntelligenceProvider, CodePosition } from "./types";

export const CODE_INTELLIGENCE_TOOL_NAME = "code_intelligence";

const POSITION_OPERATIONS = [
	"definition",
	"implementation",
	"references",
	"hover",
] as const;

export const CodeIntelligenceInputSchema = z.object({
	operation: z
		.enum([
			...POSITION_OPERATIONS,
			"document_symbols",
			"workspace_symbols",
			"diagnostics",
		])
		.describe("What to look up"),
	path: z
		.string()
		.optional()
		.describe(
			"File path, absolute or relative to the working directory. Required except for workspace_symbols.",
		),
	line: z.coerce
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			"1-based line, as numbered in read_files output. Required for definition, implementation, references and hover.",
		),
	symbol: z
		.string()
		.optional()
		.describe(
			"The identifier on that line to look up. Required for definition, implementation, references and hover.",
		),
	query: z
		.string()
		.optional()
		.describe(
			"Symbol name or prefix to search for. Required for workspace_symbols.",
		),
});

export type CodeIntelligenceInput = z.infer<typeof CodeIntelligenceInputSchema>;

const NEARBY_LINES = 2;
const MAX_NEARBY_MATCHES = 3;
const WORD = /^[\p{L}\p{N}_$]+$/u;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 1-based column of the first occurrence of `symbol` in `lineText`. */
export function findSymbolColumn(
	lineText: string,
	symbol: string,
): number | undefined {
	const index = WORD.test(symbol)
		? lineText.search(
				new RegExp(
					`(?<![\\p{L}\\p{N}_$])${escapeRegExp(symbol)}(?![\\p{L}\\p{N}_$])`,
					"u",
				),
			)
		: lineText.indexOf(symbol);
	return index >= 0 ? index + 1 : undefined;
}

/** Resolves a line plus symbol name to a position, or explains why it can't. */
export function resolveSymbolPosition(
	fileText: string,
	filePath: string,
	line: number,
	symbol: string,
	shownPath = filePath,
): CodePosition {
	const lines = fileText.split(/\r?\n/);
	if (line > lines.length) {
		throw new Error(
			`Line ${line} is past the end of ${shownPath}, which has ${lines.length} lines.`,
		);
	}
	const lineText = lines[line - 1] ?? "";
	const column = findSymbolColumn(lineText, symbol);
	if (column !== undefined) {
		return { path: filePath, line, column };
	}
	const nearby: string[] = [];
	for (
		let candidate = Math.max(1, line - NEARBY_LINES);
		candidate <= Math.min(lines.length, line + NEARBY_LINES) &&
		nearby.length < MAX_NEARBY_MATCHES;
		candidate++
	) {
		const text = lines[candidate - 1] ?? "";
		if (candidate !== line && findSymbolColumn(text, symbol) !== undefined) {
			nearby.push(`  ${candidate}: ${text.trim()}`);
		}
	}
	throw new Error(
		[
			`"${symbol}" is not on line ${line} of ${shownPath}: ${JSON.stringify(lineText.trim())}`,
			nearby.length > 0
				? `Nearby lines that contain it:\n${nearby.join("\n")}`
				: `No line within ${NEARBY_LINES} lines of it contains "${symbol}".`,
		].join("\n"),
	);
}

function resolveInputPath(inputPath: string, cwd: string): string {
	const initialPath = path.isAbsolute(inputPath)
		? path.normalize(inputPath)
		: path.resolve(cwd, inputPath);
	return resolveExistingFilePath(initialPath) ?? initialPath;
}

function requireFields(
	input: CodeIntelligenceInput,
	fields: Array<"path" | "line" | "symbol" | "query">,
): void {
	const missing = fields.filter((field) => {
		const value = input[field];
		return value === undefined || (typeof value === "string" && !value.trim());
	});
	if (missing.length > 0) {
		throw new Error(
			`${input.operation} needs ${missing.map((field) => `\`${field}\``).join(" and ")}.`,
		);
	}
}

async function runOperation(
	provider: CodeIntelligenceProvider,
	input: CodeIntelligenceInput,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	if (input.operation === "workspace_symbols") {
		requireFields(input, ["query"]);
		const query = input.query?.trim() ?? "";
		return formatSymbols(await provider.workspaceSymbols(query, signal), cwd, {
			withPath: true,
		});
	}
	requireFields(input, ["path"]);
	const filePath = resolveInputPath(input.path ?? "", cwd);
	if (input.operation === "document_symbols") {
		return formatSymbols(
			await provider.documentSymbols(filePath, signal),
			cwd,
			{
				withPath: false,
			},
		);
	}
	if (input.operation === "diagnostics") {
		const diagnostics = await provider.diagnosticsAfterChange([filePath], {
			timeoutMs: DEFAULT_PROBLEMS_TIMEOUT_MS,
			signal,
		});
		return formatDiagnostics(diagnostics.get(filePath) ?? []);
	}

	requireFields(input, ["line", "symbol"]);
	const fileText = await (provider.readText?.(filePath) ??
		fs.readFile(filePath, "utf8"));
	const position = resolveSymbolPosition(
		fileText,
		filePath,
		input.line ?? 1,
		input.symbol ?? "",
		displayPath(filePath, cwd),
	);
	switch (input.operation) {
		case "definition":
			return formatLocations(await provider.definition(position, signal), cwd);
		case "implementation":
			return formatLocations(
				await provider.implementation(position, signal),
				cwd,
			);
		case "references":
			return formatLocations(await provider.references(position, signal), cwd);
		case "hover":
			return formatHover(await provider.hover(position, signal));
	}
}

export function createCodeIntelligenceTool(
	provider: CodeIntelligenceProvider,
	config: { cwd?: string; timeoutMs?: number } = {},
): AgentTool<CodeIntelligenceInput, string> {
	// Covers a cold language-server start (up to 60 s for jdtls) plus the query.
	const timeoutMs = config.timeoutMs ?? 90_000;
	const cwd = config.cwd ?? process.cwd();

	return createTool<CodeIntelligenceInput, string>({
		name: CODE_INTELLIGENCE_TOOL_NAME,
		executionMode: "parallel",
		description:
			"Query the editor's or the CLI's language servers: go to definition or implementation, find references, hover (types and docs), list a file's symbols, search workspace symbols, or get a file's current problems. " +
			"Address a position with path, line and symbol: line is 1-based and matches read_files output, and symbol must appear on that line.",
		inputSchema: zodToJsonSchema(CodeIntelligenceInputSchema),
		timeoutMs,
		retryable: false,
		execute: async (rawInput, context) => {
			const input = validateWithZod(CodeIntelligenceInputSchema, rawInput);
			return withTimeout(
				runOperation(provider, input, cwd, context.signal),
				timeoutMs,
				`code_intelligence timed out after ${timeoutMs}ms`,
			);
		},
	});
}
