import * as fs from "node:fs/promises"
import * as path from "node:path"
import type {
	CodeDiagnostic,
	CodeDiagnosticSeverity,
	CodeIntelligenceProvider,
	CodeLocation,
	CodePosition,
	CodeSymbol,
} from "@cline/core"
import * as vscode from "vscode"

/** A diagnostics change counts as settled after this long without another one. */
export const DIAGNOSTICS_QUIET_MS = 300

/**
 * How long to wait for a first diagnostics change once the document shows the
 * new content. VS Code fires no event when a file's problems stay the same,
 * so without this a clean edit would wait the whole timeout. The TypeScript
 * extension alone delays its check 300-800 ms after a change.
 */
export const DIAGNOSTICS_GRACE_MS = 1500

/** Indexed by `vscode.SymbolKind`. */
const SYMBOL_KINDS = [
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
	"enummember",
	"struct",
	"event",
	"operator",
	"typeparameter",
]

/** Indexed by `vscode.DiagnosticSeverity`. */
const SEVERITIES: CodeDiagnosticSeverity[] = ["error", "warning", "information", "hint"]

export interface VscodeCodeIntelligenceOptions {
	graceMs?: number
	quietMs?: number
	readFile?: (filePath: string) => Promise<string>
}

function toVscodePosition(position: CodePosition): vscode.Position {
	return new vscode.Position(Math.max(0, position.line - 1), Math.max(0, position.column - 1))
}

function uriPath(uri: vscode.Uri): string {
	return uri.scheme === "file" ? uri.fsPath : uri.toString()
}

function toCodeLocation(item: vscode.Location | vscode.LocationLink): CodeLocation {
	if ("targetUri" in item) {
		const start = (item.targetSelectionRange ?? item.targetRange).start
		return { path: uriPath(item.targetUri), line: start.line + 1, column: start.character + 1 }
	}
	return { path: uriPath(item.uri), line: item.range.start.line + 1, column: item.range.start.character + 1 }
}

function toCodeDiagnostic(diagnostic: vscode.Diagnostic): CodeDiagnostic {
	const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code
	return {
		severity: SEVERITIES[diagnostic.severity] ?? "error",
		message: diagnostic.message,
		line: diagnostic.range.start.line + 1,
		column: diagnostic.range.start.character + 1,
		...(diagnostic.source ? { source: diagnostic.source } : {}),
		...(code !== undefined && code !== "" ? { code: String(code) } : {}),
	}
}

function symbolKind(kind: vscode.SymbolKind): string {
	return SYMBOL_KINDS[kind] ?? "symbol"
}

function fromDocumentSymbol(symbol: vscode.DocumentSymbol, filePath: string): CodeSymbol {
	const start = symbol.selectionRange.start
	const children = (symbol.children ?? []).map((child) => fromDocumentSymbol(child, filePath))
	return {
		name: symbol.name,
		kind: symbolKind(symbol.kind),
		path: filePath,
		line: start.line + 1,
		column: start.character + 1,
		...(children.length > 0 ? { children } : {}),
	}
}

function fromSymbolInformation(symbol: vscode.SymbolInformation): CodeSymbol {
	const start = symbol.location.range.start
	return {
		name: symbol.name,
		kind: symbolKind(symbol.kind),
		path: uriPath(symbol.location.uri),
		line: start.line + 1,
		column: start.character + 1,
		...(symbol.containerName ? { containerName: symbol.containerName } : {}),
	}
}

function hoverContentText(content: vscode.MarkdownString | vscode.MarkedString): string {
	if (typeof content === "string") {
		return content
	}
	if ("language" in content) {
		return `\`\`\`${content.language}\n${content.value}\n\`\`\``
	}
	return content.value
}

/** The text VS Code holds for a file: no BOM, and line endings compared as LF. */
function normalizeText(text: string): string {
	return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
}

function abortable<T>(work: Thenable<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) {
		return Promise.resolve(work)
	}
	signal.throwIfAborted()
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new Error("Aborted"))
		signal.addEventListener("abort", onAbort, { once: true })
		Promise.resolve(work).then(
			(value) => {
				signal.removeEventListener("abort", onAbort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener("abort", onAbort)
				reject(error)
			},
		)
	})
}

/**
 * Code intelligence from the language extensions installed in VS Code. The
 * SDK writes edits to disk and VS Code's file watcher reloads an open document
 * some time later, so diagnostics only count once the document's text matches
 * the file.
 */
export function createVscodeCodeIntelligence(options: VscodeCodeIntelligenceOptions = {}): CodeIntelligenceProvider {
	const graceMs = options.graceMs ?? DIAGNOSTICS_GRACE_MS
	const quietMs = options.quietMs ?? DIAGNOSTICS_QUIET_MS
	const readFile = options.readFile ?? ((filePath: string) => fs.readFile(filePath, "utf8"))

	const openForQuery = async (filePath: string, signal?: AbortSignal): Promise<vscode.TextDocument> => {
		const document = await abortable(vscode.workspace.openTextDocument(vscode.Uri.file(filePath)), signal)
		if (document.languageId === "plaintext") {
			const kind = path.extname(filePath) || path.basename(filePath)
			throw new Error(`No VS Code language extension handles ${kind} files`)
		}
		return document
	}

	const locations = async (command: string, position: CodePosition, signal?: AbortSignal): Promise<CodeLocation[]> => {
		const document = await openForQuery(position.path, signal)
		const results = await abortable(
			vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
				command,
				document.uri,
				toVscodePosition(position),
			),
			signal,
		)
		return (results ?? []).map(toCodeLocation)
	}

	const currentDiagnostics = (paths: string[]): Map<string, CodeDiagnostic[]> =>
		new Map(
			paths.map((filePath) => [filePath, vscode.languages.getDiagnostics(vscode.Uri.file(filePath)).map(toCodeDiagnostic)]),
		)

	/**
	 * Resolves once the document shows the file's content on disk and its
	 * diagnostics have been quiet for `quietMs`, or no change came within
	 * `graceMs`, or at `timeoutMs`. Never rejects.
	 */
	const waitForSettledDiagnostics = (filePath: string, timeoutMs: number, signal?: AbortSignal): Promise<void> =>
		new Promise<void>((resolve) => {
			const uri = vscode.Uri.file(filePath)
			const key = uri.toString()
			const subscriptions: vscode.Disposable[] = []
			let diskText: string | undefined
			let readDone = false
			let synced = false
			let done = false
			let timer: ReturnType<typeof setTimeout> | undefined

			const finish = () => {
				if (done) {
					return
				}
				done = true
				clearTimeout(timer)
				clearTimeout(deadline)
				signal?.removeEventListener("abort", finish)
				for (const subscription of subscriptions) {
					subscription.dispose()
				}
				resolve()
			}
			const finishAfter = (ms: number) => {
				clearTimeout(timer)
				timer = setTimeout(finish, ms)
			}
			const checkSynced = (document: vscode.TextDocument) => {
				if (synced || !readDone || document.uri.toString() !== key) {
					return
				}
				// A dirty document never matches the disk; its diagnostics are for the user's buffer.
				if (diskText === undefined || document.isDirty || normalizeText(document.getText()) === diskText) {
					synced = true
					finishAfter(graceMs)
				}
			}

			const deadline = setTimeout(finish, timeoutMs)
			if (signal?.aborted) {
				finish()
				return
			}
			signal?.addEventListener("abort", finish, { once: true })
			subscriptions.push(
				vscode.languages.onDidChangeDiagnostics((event) => {
					if (synced && event.uris.some((changed) => changed.toString() === key)) {
						finishAfter(quietMs)
					}
				}),
				vscode.workspace.onDidChangeTextDocument((event) => checkSynced(event.document)),
			)
			readFile(filePath)
				.then(
					(text) => normalizeText(text),
					() => undefined,
				)
				.then(async (text) => {
					diskText = text
					readDone = true
					checkSynced(await vscode.workspace.openTextDocument(uri))
				})
				.catch(finish)
		})

	return {
		definition: (position, signal) => locations("vscode.executeDefinitionProvider", position, signal),
		implementation: (position, signal) => locations("vscode.executeImplementationProvider", position, signal),
		references: (position, signal) => locations("vscode.executeReferenceProvider", position, signal),

		async hover(position, signal) {
			const document = await openForQuery(position.path, signal)
			const hovers = await abortable(
				vscode.commands.executeCommand<vscode.Hover[] | undefined>(
					"vscode.executeHoverProvider",
					document.uri,
					toVscodePosition(position),
				),
				signal,
			)
			const texts = new Set<string>()
			for (const hover of hovers ?? []) {
				for (const content of hover.contents) {
					const text = hoverContentText(content).trim()
					if (text) {
						texts.add(text)
					}
				}
			}
			return texts.size > 0 ? [...texts].join("\n\n") : undefined
		},

		async documentSymbols(filePath, signal) {
			const document = await openForQuery(filePath, signal)
			const symbols = await abortable(
				vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined>(
					"vscode.executeDocumentSymbolProvider",
					document.uri,
				),
				signal,
			)
			return (symbols ?? []).map((symbol) =>
				"selectionRange" in symbol ? fromDocumentSymbol(symbol, filePath) : fromSymbolInformation(symbol),
			)
		},

		async workspaceSymbols(query, signal) {
			const symbols = await abortable(
				vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
					"vscode.executeWorkspaceSymbolProvider",
					query,
				),
				signal,
			)
			return (symbols ?? []).map(fromSymbolInformation)
		},

		async diagnostics(paths) {
			const open = new Set(vscode.workspace.textDocuments.map((document) => document.uri.toString()))
			return currentDiagnostics(paths.filter((filePath) => open.has(vscode.Uri.file(filePath).toString())))
		},

		async readText(filePath) {
			return (await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))).getText()
		},

		prepare(filePath) {
			try {
				Promise.resolve(vscode.workspace.openTextDocument(vscode.Uri.file(filePath))).catch(() => undefined)
			} catch {}
		},

		async diagnosticsAfterChange(paths, { timeoutMs, signal }) {
			await Promise.all(paths.map((filePath) => waitForSettledDiagnostics(filePath, timeoutMs, signal)))
			return currentDiagnostics(paths)
		},
	}
}
