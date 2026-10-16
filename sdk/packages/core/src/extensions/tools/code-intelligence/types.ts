export type CodeDiagnosticSeverity =
	| "error"
	| "warning"
	| "information"
	| "hint";

/** Line and column are 1-based. */
export interface CodeDiagnostic {
	severity: CodeDiagnosticSeverity;
	message: string;
	line: number;
	column: number;
	source?: string;
	code?: string;
}

/** Absolute path, 1-based line and column. */
export interface CodePosition {
	path: string;
	line: number;
	column: number;
}

/** Absolute path, 1-based line and column. */
export interface CodeLocation {
	path: string;
	line: number;
	column: number;
}

export interface CodeSymbol {
	name: string;
	kind: string;
	path: string;
	line: number;
	column: number;
	containerName?: string;
	children?: CodeSymbol[];
}

/**
 * Language intelligence for a session, backed by the host editor or by
 * language servers. A path no server handles makes a call throw an Error
 * whose message the tool returns as its result.
 */
export interface CodeIntelligenceProvider {
	definition(pos: CodePosition, signal?: AbortSignal): Promise<CodeLocation[]>;
	implementation(
		pos: CodePosition,
		signal?: AbortSignal,
	): Promise<CodeLocation[]>;
	/** Includes the declaration. */
	references(pos: CodePosition, signal?: AbortSignal): Promise<CodeLocation[]>;
	/** Plain text or markdown. */
	hover(pos: CodePosition, signal?: AbortSignal): Promise<string | undefined>;
	documentSymbols(path: string, signal?: AbortSignal): Promise<CodeSymbol[]>;
	workspaceSymbols(query: string, signal?: AbortSignal): Promise<CodeSymbol[]>;
	/**
	 * Diagnostics already known for these files, without waiting. A path the
	 * provider has no result for yet (not open, or not checked since it was
	 * opened) has no entry.
	 */
	diagnostics(paths: string[]): Promise<Map<string, CodeDiagnostic[]>>;
	/** Make the language server track this file (open it) so its diagnostics are ready later. Fire-and-forget; never throws. */
	prepare(path: string): void;
	/** The agent just wrote these files: sync them to the server and resolve with their diagnostics once they settle or timeoutMs passes. */
	diagnosticsAfterChange(
		paths: string[],
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<Map<string, CodeDiagnostic[]>>;
	/** The file's text as the language service sees it, when that can differ from the disk (an editor buffer). */
	readText?(path: string): Promise<string>;
}

export type ProblemsAfterEditLevel = "off" | "errors" | "warnings";

export interface LanguageServerConfig {
	command: string[];
	extensions: string[];
	/** languageId per file extension, e.g. `{ ".tsx": "typescriptreact" }`. */
	languageIds?: Record<string, string>;
	initializationOptions?: unknown;
	startupTimeoutMs?: number;
}

/**
 * Language servers the SDK starts itself when the host supplies no
 * `codeIntelligence`. A `servers` entry with a built-in name replaces that
 * server, `false` disables it, and a new name adds one.
 */
export interface LanguageServerSettings {
	enabled?: boolean;
	servers?: Record<string, LanguageServerConfig | false>;
}
