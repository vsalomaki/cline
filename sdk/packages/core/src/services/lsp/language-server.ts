import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	CodeDiagnostic,
	CodeDiagnosticSeverity,
	CodeLocation,
	CodePosition,
	CodeSymbol,
} from "../../extensions/tools/code-intelligence/types";
import { JsonRpcConnection, JsonRpcError, METHOD_NOT_FOUND } from "./json-rpc";
import { languageIdFor, type ResolvedLanguageServer } from "./servers";

const STDERR_LIMIT = 4096;
const DIAGNOSTICS_QUIET_MS = 300;
/**
 * A publish without a version may answer a check that started before the
 * change, so when it could (see `storeDiagnostics`) it settles only when
 * nothing follows it for this long.
 */
const MAYBE_STALE_QUIET_MS = 1000;
const DISPOSE_KILL_MS = 2000;

const SYMBOL_KINDS = [
	"",
	"file",
	"module",
	"namespace",
	"package",
	"class",
	"method",
	"property",
	"field",
	"constructor",
	"enum",
	"interface",
	"function",
	"variable",
	"constant",
	"string",
	"number",
	"boolean",
	"array",
	"object",
	"key",
	"null",
	"enum member",
	"struct",
	"event",
	"operator",
	"type parameter",
];

const SEVERITIES: Record<number, CodeDiagnosticSeverity> = {
	1: "error",
	2: "warning",
	3: "information",
	4: "hint",
};

interface LspPosition {
	line: number;
	character: number;
}
interface LspRange {
	start: LspPosition;
	end: LspPosition;
}
interface LspLocation {
	uri: string;
	range: LspRange;
}
interface LspLocationLink {
	targetUri: string;
	targetRange: LspRange;
	targetSelectionRange?: LspRange;
}
interface LspDiagnostic {
	range: LspRange;
	severity?: number;
	code?: number | string;
	source?: string;
	message: string;
}
interface LspDocumentSymbol {
	name: string;
	kind: number;
	range: LspRange;
	selectionRange?: LspRange;
	children?: LspDocumentSymbol[];
}
interface LspSymbolInformation {
	name: string;
	kind: number;
	location: { uri: string; range?: LspRange };
	containerName?: string;
}
type MarkedString = string | { language: string; value: string };
interface MarkupContent {
	kind: string;
	value: string;
}

interface OpenDocument {
	uri: string;
	version: number;
	text: string;
}

/** Map key for a file path; Windows paths compare case-insensitively. */
export function pathKey(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function uriToPath(uri: string): string {
	if (!uri.startsWith("file:")) {
		return uri;
	}
	try {
		return fileURLToPath(uri);
	} catch {
		return uri;
	}
}

function toLocation(
	uri: string,
	position: LspPosition | undefined,
): CodeLocation {
	return {
		path: uriToPath(uri),
		line: (position?.line ?? 0) + 1,
		column: (position?.character ?? 0) + 1,
	};
}

export function normalizeLocations(result: unknown): CodeLocation[] {
	if (!result) {
		return [];
	}
	const items = (Array.isArray(result) ? result : [result]) as (
		| LspLocation
		| LspLocationLink
	)[];
	return items.flatMap((item) => {
		if (!item || typeof item !== "object") {
			return [];
		}
		if ("targetUri" in item) {
			return [
				toLocation(
					item.targetUri,
					(item.targetSelectionRange ?? item.targetRange)?.start,
				),
			];
		}
		return item.uri ? [toLocation(item.uri, item.range?.start)] : [];
	});
}

function symbolKind(kind: number): string {
	return SYMBOL_KINDS[kind] || "symbol";
}

function fromDocumentSymbol(
	symbol: LspDocumentSymbol,
	filePath: string,
	containerName?: string,
): CodeSymbol {
	const start = (symbol.selectionRange ?? symbol.range).start;
	const children = symbol.children?.map((child) =>
		fromDocumentSymbol(child, filePath, symbol.name),
	);
	return {
		name: symbol.name,
		kind: symbolKind(symbol.kind),
		path: filePath,
		line: start.line + 1,
		column: start.character + 1,
		...(containerName ? { containerName } : {}),
		...(children?.length ? { children } : {}),
	};
}

function fromSymbolInformation(symbol: LspSymbolInformation): CodeSymbol {
	const location = toLocation(
		symbol.location.uri,
		symbol.location.range?.start,
	);
	return {
		name: symbol.name,
		kind: symbolKind(symbol.kind),
		...location,
		...(symbol.containerName ? { containerName: symbol.containerName } : {}),
	};
}

export function normalizeSymbols(
	result: unknown,
	filePath?: string,
): CodeSymbol[] {
	if (!Array.isArray(result)) {
		return [];
	}
	return (result as (LspDocumentSymbol | LspSymbolInformation)[]).map(
		(symbol) =>
			"location" in symbol
				? fromSymbolInformation(symbol)
				: fromDocumentSymbol(symbol, filePath ?? ""),
	);
}

function markedStringText(value: MarkedString): string {
	return typeof value === "string"
		? value
		: `\`\`\`${value.language}\n${value.value}\n\`\`\``;
}

export function normalizeHover(result: unknown): string | undefined {
	const contents = (
		result as {
			contents?: MarkedString | MarkedString[] | MarkupContent;
		} | null
	)?.contents;
	if (!contents) {
		return undefined;
	}
	let text: string;
	if (Array.isArray(contents)) {
		text = contents.map(markedStringText).join("\n\n");
	} else if (typeof contents === "object" && "kind" in contents) {
		text = contents.value;
	} else {
		text = markedStringText(contents);
	}
	return text.trim() ? text : undefined;
}

function fromLspDiagnostic(diagnostic: LspDiagnostic): CodeDiagnostic {
	return {
		severity: SEVERITIES[diagnostic.severity ?? 1] ?? "error",
		message: diagnostic.message,
		line: diagnostic.range.start.line + 1,
		column: diagnostic.range.start.character + 1,
		...(diagnostic.source ? { source: diagnostic.source } : {}),
		...(diagnostic.code !== undefined && diagnostic.code !== null
			? { code: String(diagnostic.code) }
			: {}),
	};
}

/** One language server process for one workspace root. */
export class LanguageServer {
	readonly name: string;
	/** Settles once `initialize` has completed; rejects when startup fails. */
	readonly ready: Promise<void>;
	private readonly root: string;
	private readonly config: ResolvedLanguageServer;
	private readonly child: ChildProcess;
	private readonly connection: JsonRpcConnection;
	private readonly documents = new Map<string, OpenDocument>();
	private readonly documentSyncs = new Map<string, Promise<void>>();
	private readonly diagnosticsByKey = new Map<string, CodeDiagnostic[]>();
	/** Per file, whether the publishes since its last sync are known to be for it. */
	private readonly publishedSinceSync = new Map<
		string,
		"fresh" | "maybe-stale"
	>();
	private readonly diagnosticsAtSync = new Map<string, string>();
	/** Files synced again before a publish answered the previous sync. */
	private readonly earlierPublishPending = new Set<string>();
	private readonly publishListeners = new Set<(key: string) => void>();
	private readonly exited: Promise<void>;
	private stderrTail = "";
	private deadError: Error | undefined;
	private initialized = false;
	private disposing = false;
	/** The server answers `textDocument/diagnostic` and may never push diagnostics. */
	private pullsDiagnostics = false;

	constructor(
		config: ResolvedLanguageServer,
		root: string,
		env: NodeJS.ProcessEnv = process.env,
	) {
		this.name = config.name;
		this.config = config;
		this.root = root;
		const [command, ...args] = config.command;
		const useShell =
			process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
		this.child = spawn(
			useShell ? quoteWindowsArg(command) : command,
			useShell ? args.map(quoteWindowsArg) : args,
			{
				cwd: root,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				shell: useShell,
			},
		);
		this.exited = new Promise((resolve) => {
			this.child.once("exit", (code, signal) => {
				this.markDead(
					`Language server ${this.name} exited: ${this.stderrTail.trim() || (signal ? `signal ${signal}` : `code ${code}`)}`,
				);
				resolve();
			});
			this.child.once("error", (error) => {
				this.markDead(
					`Language server ${this.name} failed to start: ${error.message}`,
				);
				resolve();
			});
		});
		this.child.stdin?.on("error", () => {});
		this.child.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(
				-STDERR_LIMIT,
			);
		});
		this.connection = new JsonRpcConnection(
			this.child.stdout as NonNullable<ChildProcess["stdout"]>,
			this.child.stdin as NonNullable<ChildProcess["stdin"]>,
			{
				onRequest: (method, params) => this.handleServerRequest(method, params),
				onNotification: (method, params) =>
					this.handleNotification(method, params),
			},
		);
		this.ready = this.initialize();
		this.ready.catch(() => {});
	}

	get isDead(): boolean {
		return this.deadError !== undefined;
	}

	get isReady(): boolean {
		return this.initialized && !this.deadError;
	}

	/** While unreferenced, the process does not keep the host's event loop alive. */
	setReferenced(referenced: boolean): void {
		const handles = [
			this.child,
			this.child.stdin,
			this.child.stdout,
			this.child.stderr,
		] as ({ ref?: () => void; unref?: () => void } | null)[];
		for (const handle of handles) {
			if (referenced) {
				handle?.ref?.();
			} else {
				handle?.unref?.();
			}
		}
	}

	private async initialize(): Promise<void> {
		const rootUri = pathToFileURL(this.root).href;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new Error(
							`Language server ${this.name} did not start within ${this.config.startupTimeoutMs} ms`,
						),
					),
				this.config.startupTimeoutMs,
			);
		});
		try {
			const result = (await Promise.race([
				this.connection.request("initialize", {
					processId: process.pid,
					clientInfo: { name: "Cline" },
					rootUri,
					rootPath: this.root,
					workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
					initializationOptions: this.config.initializationOptions,
					capabilities: {
						textDocument: {
							synchronization: { didSave: true },
							publishDiagnostics: {},
							definition: { linkSupport: true },
							implementation: { linkSupport: true },
							references: {},
							hover: { contentFormat: ["markdown", "plaintext"] },
							documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						},
						workspace: {
							symbol: {},
							workspaceFolders: true,
							configuration: true,
						},
					},
				}),
				timeout,
			])) as { capabilities?: { diagnosticProvider?: unknown } } | null;
			this.pullsDiagnostics = Boolean(result?.capabilities?.diagnosticProvider);
		} catch (error) {
			if (!this.deadError) {
				this.markDead(error instanceof Error ? error.message : String(error));
				this.child.kill("SIGKILL");
			}
			throw this.deadError;
		} finally {
			clearTimeout(timer);
		}
		this.connection.notify("initialized", {});
		this.initialized = true;
	}

	private markDead(message: string): void {
		if (this.deadError) {
			return;
		}
		this.deadError = new Error(
			this.disposing ? `Language server ${this.name} was shut down` : message,
		);
		this.connection.close(this.deadError);
		for (const listener of this.publishListeners) {
			listener("");
		}
	}

	private assertAlive(): void {
		if (this.deadError) {
			throw this.deadError;
		}
	}

	private handleServerRequest(method: string, params: unknown): unknown {
		switch (method) {
			case "workspace/configuration":
				return ((params as { items?: unknown[] })?.items ?? []).map(() => null);
			case "client/registerCapability":
			case "client/unregisterCapability":
			case "window/workDoneProgress/create":
				return null;
			case "workspace/workspaceFolders": {
				const uri = pathToFileURL(this.root).href;
				return [{ uri, name: path.basename(this.root) }];
			}
			default:
				throw new JsonRpcError(`Unhandled method ${method}`, METHOD_NOT_FOUND);
		}
	}

	private handleNotification(method: string, params: unknown): void {
		if (method !== "textDocument/publishDiagnostics") {
			return;
		}
		const { uri, version, diagnostics } = params as {
			uri: string;
			version?: number;
			diagnostics?: LspDiagnostic[];
		};
		this.storeDiagnostics(pathKey(uriToPath(uri)), diagnostics ?? [], version);
	}

	private storeDiagnostics(
		key: string,
		diagnostics: LspDiagnostic[],
		version: number | undefined,
	): void {
		const document = this.documents.get(key);
		if (version !== undefined && document && version < document.version) {
			return;
		}
		const mapped = diagnostics.map(fromLspDiagnostic);
		this.diagnosticsByKey.set(key, mapped);
		const maybeStale =
			version === undefined &&
			(this.earlierPublishPending.has(key) ||
				JSON.stringify(mapped) === this.diagnosticsAtSync.get(key));
		this.earlierPublishPending.delete(key);
		if (this.publishedSinceSync.get(key) !== "fresh") {
			this.publishedSinceSync.set(key, maybeStale ? "maybe-stale" : "fresh");
		}
		for (const listener of this.publishListeners) {
			listener(key);
		}
	}

	/** Pulls diagnostics for the document version just synced and stores them like a push. */
	private pullDiagnostics(key: string, document: OpenDocument): void {
		const { version } = document;
		void this.connection
			.request<{ kind?: string; items?: LspDiagnostic[] } | null>(
				"textDocument/diagnostic",
				{ textDocument: { uri: document.uri } },
			)
			.then((report) => {
				if (
					report?.kind === "full" &&
					this.documents.get(key)?.version === version
				) {
					this.storeDiagnostics(key, report.items ?? [], version);
				}
			})
			.catch(() => {});
	}

	/**
	 * Opens the file on first use; afterwards sends the disk text when it
	 * differs from what the server has, or always when `force` is set.
	 */
	private syncDocument(filePath: string, force: boolean): Promise<void> {
		const key = pathKey(filePath);
		const previous = this.documentSyncs.get(key) ?? Promise.resolve();
		const next = previous
			.catch(() => {})
			.then(async () => {
				await this.ready;
				const text = await readFile(filePath, "utf8");
				this.assertAlive();
				const open = this.documents.get(key);
				if (!open) {
					const uri = pathToFileURL(path.resolve(filePath)).href;
					const document = { uri, version: 1, text };
					this.documents.set(key, document);
					this.diagnosticsByKey.delete(key);
					this.markSynced(key, true);
					this.connection.notify("textDocument/didOpen", {
						textDocument: {
							uri,
							languageId: languageIdFor(this.config, filePath),
							version: 1,
							text,
						},
					});
					if (this.pullsDiagnostics) {
						this.pullDiagnostics(key, document);
					}
					return;
				}
				if (!force && open.text === text) {
					return;
				}
				open.version += 1;
				open.text = text;
				this.markSynced(key, false);
				this.connection.notify("textDocument/didChange", {
					textDocument: { uri: open.uri, version: open.version },
					contentChanges: [{ text }],
				});
				this.connection.notify("textDocument/didSave", {
					textDocument: { uri: open.uri },
				});
				if (this.pullsDiagnostics) {
					this.pullDiagnostics(key, open);
				}
			});
		this.documentSyncs.set(key, next);
		return next;
	}

	private markSynced(key: string, firstSync: boolean): void {
		if (!firstSync && !this.publishedSinceSync.has(key)) {
			this.earlierPublishPending.add(key);
		}
		this.publishedSinceSync.delete(key);
		this.diagnosticsAtSync.set(
			key,
			JSON.stringify(this.diagnosticsByKey.get(key) ?? []),
		);
	}

	/** Makes sure the server has the file open with its current disk text. */
	ensureCurrent(filePath: string): Promise<void> {
		return this.syncDocument(filePath, false);
	}

	/** Re-sends the disk text so the server re-checks the file. */
	syncFromDisk(filePath: string): Promise<void> {
		return this.syncDocument(filePath, true);
	}

	diagnosticsFor(filePath: string): CodeDiagnostic[] {
		return this.diagnosticsByKey.get(pathKey(filePath)) ?? [];
	}

	/** Diagnostics for an open file the server has reported on since opening it. */
	knownDiagnosticsFor(filePath: string): CodeDiagnostic[] | undefined {
		const key = pathKey(filePath);
		return this.documents.has(key) ? this.diagnosticsByKey.get(key) : undefined;
	}

	/** Closes every document, so the next use reopens each file from disk. */
	closeDocuments(): void {
		for (const [key, previous] of this.documentSyncs) {
			const closed = previous
				.catch(() => {})
				.then(() => {
					const document = this.documents.get(key);
					if (document) {
						this.connection.notify("textDocument/didClose", {
							textDocument: { uri: document.uri },
						});
					}
					this.documents.delete(key);
					this.diagnosticsByKey.delete(key);
					this.publishedSinceSync.delete(key);
					this.diagnosticsAtSync.delete(key);
					this.earlierPublishPending.delete(key);
					if (this.documentSyncs.get(key) === closed) {
						this.documentSyncs.delete(key);
					}
				});
			this.documentSyncs.set(key, closed);
		}
	}

	/**
	 * Resolves once every path has had a publish since its last sync and no
	 * further publish for them arrived for a quiet period, or at the timeout.
	 * A publish for an older document version does not count.
	 */
	waitForDiagnostics(
		paths: string[],
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Map<string, CodeDiagnostic[]>> {
		const keys = new Set(paths.map(pathKey));
		const settleDelay = (): number | undefined => {
			let delay = DIAGNOSTICS_QUIET_MS;
			for (const key of keys) {
				const published = this.publishedSinceSync.get(key);
				if (!published) {
					return undefined;
				}
				if (published === "maybe-stale") {
					delay = MAYBE_STALE_QUIET_MS;
				}
			}
			return delay;
		};
		const collect = () =>
			new Map(
				paths.map((filePath) => [filePath, this.diagnosticsFor(filePath)]),
			);
		return new Promise((resolve, reject) => {
			let quietTimer: NodeJS.Timeout | undefined;
			const cleanup = () => {
				clearTimeout(quietTimer);
				clearTimeout(timeoutTimer);
				this.publishListeners.delete(onPublish);
				signal?.removeEventListener("abort", onAbort);
			};
			const finish = () => {
				cleanup();
				resolve(collect());
			};
			const restartQuietTimer = () => {
				clearTimeout(quietTimer);
				const delay = settleDelay();
				if (delay !== undefined) {
					quietTimer = setTimeout(finish, delay);
				}
			};
			const onPublish = (key: string) => {
				if (this.deadError) {
					finish();
				} else if (keys.has(key)) {
					restartQuietTimer();
				}
			};
			const onAbort = () => {
				cleanup();
				reject(signal?.reason ?? new Error("The operation was aborted"));
			};
			const timeoutTimer = setTimeout(finish, timeoutMs);
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			this.publishListeners.add(onPublish);
			if (this.deadError) {
				finish();
			} else {
				restartQuietTimer();
			}
		});
	}

	private async request(
		method: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		await this.ready;
		return this.connection.request(method, params, signal);
	}

	private async positionRequest(
		method: string,
		position: CodePosition,
		signal: AbortSignal | undefined,
		extra: Record<string, unknown> = {},
	): Promise<unknown> {
		await this.ensureCurrent(position.path);
		const document = this.documents.get(pathKey(position.path));
		return this.request(
			method,
			{
				textDocument: { uri: document?.uri },
				position: {
					line: position.line - 1,
					character: position.column - 1,
				},
				...extra,
			},
			signal,
		);
	}

	async definition(
		position: CodePosition,
		signal?: AbortSignal,
	): Promise<CodeLocation[]> {
		return normalizeLocations(
			await this.positionRequest("textDocument/definition", position, signal),
		);
	}

	async implementation(
		position: CodePosition,
		signal?: AbortSignal,
	): Promise<CodeLocation[]> {
		return normalizeLocations(
			await this.positionRequest(
				"textDocument/implementation",
				position,
				signal,
			),
		);
	}

	async references(
		position: CodePosition,
		signal?: AbortSignal,
	): Promise<CodeLocation[]> {
		return normalizeLocations(
			await this.positionRequest("textDocument/references", position, signal, {
				context: { includeDeclaration: true },
			}),
		);
	}

	async hover(
		position: CodePosition,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		return normalizeHover(
			await this.positionRequest("textDocument/hover", position, signal),
		);
	}

	async documentSymbols(
		filePath: string,
		signal?: AbortSignal,
	): Promise<CodeSymbol[]> {
		await this.ensureCurrent(filePath);
		const document = this.documents.get(pathKey(filePath));
		return normalizeSymbols(
			await this.request(
				"textDocument/documentSymbol",
				{ textDocument: { uri: document?.uri } },
				signal,
			),
			path.resolve(filePath),
		);
	}

	async workspaceSymbols(
		query: string,
		signal?: AbortSignal,
	): Promise<CodeSymbol[]> {
		return normalizeSymbols(
			await this.request("workspace/symbol", { query }, signal),
		);
	}

	/** Asks the server to shut down and kills it if it has not exited after 2 s. */
	async dispose(): Promise<void> {
		if (this.disposing) {
			return this.exited;
		}
		this.disposing = true;
		if (this.deadError) {
			return;
		}
		const killTimer = setTimeout(
			() => this.child.kill("SIGKILL"),
			DISPOSE_KILL_MS,
		);
		void this.connection
			.request("shutdown", null)
			.catch(() => {})
			.then(() => this.connection.notify("exit", null));
		await this.exited;
		clearTimeout(killTimer);
	}
}

function quoteWindowsArg(arg: string): string {
	return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}
