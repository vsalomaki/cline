import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { createVscodeCodeIntelligence, DIAGNOSTICS_GRACE_MS, DIAGNOSTICS_QUIET_MS } from "./VscodeCodeIntelligence"

const mocks = vi.hoisted(() => {
	type Listener<T> = (event: T) => void
	const emitter = <T>() => {
		const listeners = new Set<Listener<T>>()
		return {
			listeners,
			event: (listener: Listener<T>) => {
				listeners.add(listener)
				return { dispose: () => listeners.delete(listener) }
			},
			fire: (event: T) => {
				for (const listener of [...listeners]) {
					listener(event)
				}
			},
		}
	}
	return {
		documents: new Map<string, { uri: unknown; languageId: string; isDirty: boolean; getText: () => string }>(),
		diagnostics: new Map<string, unknown[]>(),
		executeCommand: vi.fn(),
		openTextDocument: vi.fn(),
		textChanges: emitter<{ document: unknown }>(),
		diagnosticChanges: emitter<{ uris: Array<{ toString(): string }> }>(),
	}
})

vi.mock("vscode", () => {
	class Position {
		constructor(
			public line: number,
			public character: number,
		) {}
	}
	class Uri {
		static file(fsPath: string) {
			return new Uri(fsPath)
		}
		scheme = "file"
		constructor(public fsPath: string) {}
		toString() {
			return `file://${this.fsPath}`
		}
	}
	return {
		Position,
		Uri,
		commands: { executeCommand: mocks.executeCommand },
		workspace: {
			openTextDocument: mocks.openTextDocument,
			onDidChangeTextDocument: mocks.textChanges.event,
			get textDocuments() {
				return [...mocks.documents.values()]
			},
		},
		languages: {
			getDiagnostics: (uri: { fsPath: string }) => mocks.diagnostics.get(uri.fsPath) ?? [],
			onDidChangeDiagnostics: mocks.diagnosticChanges.event,
		},
	}
})

const FILE = "/ws/src/a.ts"

function range(line: number, character: number) {
	return { start: { line, character }, end: { line, character: character + 1 } }
}

function setDocument(filePath: string, text: string, options: { languageId?: string; isDirty?: boolean } = {}) {
	const document = {
		uri: vscode.Uri.file(filePath),
		languageId: options.languageId ?? "typescript",
		isDirty: options.isDirty ?? false,
		text,
		getText() {
			return this.text
		},
	}
	mocks.documents.set(filePath, document)
	return document
}

function fireDiagnostics(filePath: string) {
	mocks.diagnosticChanges.fire({ uris: [vscode.Uri.file(filePath)] })
}

beforeEach(() => {
	mocks.documents.clear()
	mocks.diagnostics.clear()
	mocks.executeCommand.mockReset()
	mocks.openTextDocument.mockReset()
	mocks.openTextDocument.mockImplementation(async (uri: { fsPath: string }) => {
		const document = mocks.documents.get(uri.fsPath)
		if (!document) {
			throw new Error(`cannot open ${uri.fsPath}`)
		}
		return document
	})
	mocks.textChanges.listeners.clear()
	mocks.diagnosticChanges.listeners.clear()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("createVscodeCodeIntelligence queries", () => {
	it("sends 0-based positions and maps Location and LocationLink to 1-based", async () => {
		setDocument(FILE, "")
		mocks.executeCommand.mockResolvedValue([
			{ uri: vscode.Uri.file("/ws/src/b.ts"), range: range(4, 2) },
			{ targetUri: vscode.Uri.file("/ws/src/c.ts"), targetRange: range(9, 0), targetSelectionRange: range(10, 6) },
			{ targetUri: vscode.Uri.file("/ws/src/d.ts"), targetRange: range(1, 3) },
		])
		const provider = createVscodeCodeIntelligence()

		const locations = await provider.definition({ path: FILE, line: 3, column: 7 })

		expect(mocks.executeCommand).toHaveBeenCalledWith(
			"vscode.executeDefinitionProvider",
			expect.objectContaining({ fsPath: FILE }),
			expect.objectContaining({ line: 2, character: 6 }),
		)
		expect(locations).toEqual([
			{ path: "/ws/src/b.ts", line: 5, column: 3 },
			{ path: "/ws/src/c.ts", line: 11, column: 7 },
			{ path: "/ws/src/d.ts", line: 2, column: 4 },
		])
	})

	it("uses the implementation and reference providers", async () => {
		setDocument(FILE, "")
		mocks.executeCommand.mockResolvedValue(undefined)
		const provider = createVscodeCodeIntelligence()

		expect(await provider.implementation({ path: FILE, line: 1, column: 1 })).toEqual([])
		expect(await provider.references({ path: FILE, line: 1, column: 1 })).toEqual([])
		expect(mocks.executeCommand.mock.calls.map((call) => call[0])).toEqual([
			"vscode.executeImplementationProvider",
			"vscode.executeReferenceProvider",
		])
	})

	it("joins hover contents as text", async () => {
		setDocument(FILE, "")
		mocks.executeCommand.mockResolvedValue([
			{ contents: [{ value: "**bold**" }, "plain", { language: "ts", value: "const x: number" }] },
			{ contents: ["plain", ""] },
		])
		const provider = createVscodeCodeIntelligence()

		expect(await provider.hover({ path: FILE, line: 1, column: 1 })).toBe("**bold**\n\nplain\n\n```ts\nconst x: number\n```")
		mocks.executeCommand.mockResolvedValue([])
		expect(await provider.hover({ path: FILE, line: 1, column: 1 })).toBeUndefined()
	})

	it("maps document symbols, nested or flat", async () => {
		setDocument(FILE, "")
		mocks.executeCommand.mockResolvedValue([
			{
				name: "Foo",
				kind: 4,
				range: range(0, 0),
				selectionRange: range(0, 13),
				children: [{ name: "bar", kind: 5, range: range(1, 1), selectionRange: range(1, 2), children: [] }],
			},
			{ name: "helper", kind: 11, containerName: "mod", location: { uri: vscode.Uri.file(FILE), range: range(5, 0) } },
		])
		const provider = createVscodeCodeIntelligence()

		expect(await provider.documentSymbols(FILE)).toEqual([
			{
				name: "Foo",
				kind: "class",
				path: FILE,
				line: 1,
				column: 14,
				children: [{ name: "bar", kind: "method", path: FILE, line: 2, column: 3 }],
			},
			{ name: "helper", kind: "function", path: FILE, line: 6, column: 1, containerName: "mod" },
		])
	})

	it("maps workspace symbols", async () => {
		mocks.executeCommand.mockResolvedValue([
			{ name: "Thing", kind: 10, containerName: "", location: { uri: vscode.Uri.file("/ws/t.ts"), range: range(2, 4) } },
		])
		const provider = createVscodeCodeIntelligence()

		expect(await provider.workspaceSymbols("Thing")).toEqual([
			{ name: "Thing", kind: "interface", path: "/ws/t.ts", line: 3, column: 5 },
		])
		expect(mocks.executeCommand).toHaveBeenCalledWith("vscode.executeWorkspaceSymbolProvider", "Thing")
	})

	it("refuses a file no language extension handles", async () => {
		setDocument("/ws/notes.txt", "", { languageId: "plaintext" })
		const provider = createVscodeCodeIntelligence()

		await expect(provider.documentSymbols("/ws/notes.txt")).rejects.toThrow(
			"No VS Code language extension handles .txt files",
		)
		expect(mocks.executeCommand).not.toHaveBeenCalled()
	})

	it("stops waiting when the signal aborts", async () => {
		setDocument(FILE, "")
		mocks.executeCommand.mockReturnValue(new Promise(() => {}))
		const provider = createVscodeCodeIntelligence()
		const controller = new AbortController()

		const pending = provider.definition({ path: FILE, line: 1, column: 1 }, controller.signal)
		controller.abort(new Error("stop"))

		await expect(pending).rejects.toThrow("stop")
	})

	it("maps diagnostics", async () => {
		setDocument(FILE, "")
		mocks.diagnostics.set(FILE, [
			{ severity: 0, message: "Cannot find name 'x'.", range: range(11, 4), source: "ts", code: 2304 },
			{ severity: 1, message: "unused", range: range(0, 0), code: { value: "no-unused", target: {} } },
			{ severity: 3, message: "hint", range: range(2, 2), source: "" },
		])
		const provider = createVscodeCodeIntelligence()

		expect((await provider.diagnostics([FILE])).get(FILE)).toEqual([
			{ severity: "error", message: "Cannot find name 'x'.", line: 12, column: 5, source: "ts", code: "2304" },
			{ severity: "warning", message: "unused", line: 1, column: 1, code: "no-unused" },
			{ severity: "hint", message: "hint", line: 3, column: 3 },
		])
	})

	it("has no diagnostics entry for a file that is not open", async () => {
		mocks.diagnostics.set(FILE, [{ severity: 0, message: "stale", range: range(0, 0) }])
		const provider = createVscodeCodeIntelligence()

		expect(await provider.diagnostics([FILE])).toEqual(new Map())
	})

	it("reads text from the document buffer", async () => {
		setDocument(FILE, "unsaved edit", { isDirty: true })
		const provider = createVscodeCodeIntelligence({ readFile: async () => "on disk" })

		expect(await provider.readText?.(FILE)).toBe("unsaved edit")
	})

	it("prepare opens the document and swallows failures", async () => {
		const provider = createVscodeCodeIntelligence()

		expect(() => provider.prepare("/ws/missing.ts")).not.toThrow()
		expect(mocks.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ fsPath: "/ws/missing.ts" }))
		mocks.openTextDocument.mockImplementation(() => {
			throw new Error("sync failure")
		})
		expect(() => provider.prepare("/ws/missing.ts")).not.toThrow()
	})
})

describe("diagnosticsAfterChange", () => {
	const error = { severity: 0, message: "boom", range: range(0, 0) }

	function start(provider: ReturnType<typeof createVscodeCodeIntelligence>, timeoutMs = 3_000, signal?: AbortSignal) {
		const state: { result?: Map<string, unknown> } = {}
		provider.diagnosticsAfterChange([FILE], { timeoutMs, signal }).then((result) => {
			state.result = result
		})
		return state
	}

	beforeEach(() => {
		vi.useFakeTimers()
	})

	it("ignores diagnostics until the document reloads, then waits for them to settle", async () => {
		const document = setDocument(FILE, "old")
		const provider = createVscodeCodeIntelligence({ readFile: async () => "new" })
		const state = start(provider)
		await vi.advanceTimersByTimeAsync(0)

		fireDiagnostics(FILE)
		await vi.advanceTimersByTimeAsync(DIAGNOSTICS_GRACE_MS + DIAGNOSTICS_QUIET_MS)
		expect(state.result).toBeUndefined()

		document.text = "new"
		mocks.textChanges.fire({ document })
		await vi.advanceTimersByTimeAsync(500)
		mocks.diagnostics.set(FILE, [error])
		fireDiagnostics(FILE)
		await vi.advanceTimersByTimeAsync(DIAGNOSTICS_QUIET_MS - 1)
		fireDiagnostics(FILE)
		await vi.advanceTimersByTimeAsync(DIAGNOSTICS_QUIET_MS - 1)
		expect(state.result).toBeUndefined()

		await vi.advanceTimersByTimeAsync(1)
		expect(state.result?.get(FILE)).toEqual([{ severity: "error", message: "boom", line: 1, column: 1 }])
		expect(mocks.textChanges.listeners.size).toBe(0)
		expect(mocks.diagnosticChanges.listeners.size).toBe(0)
	})

	it("returns after the grace window when no diagnostics change arrives", async () => {
		setDocument(FILE, "same\r\n")
		const provider = createVscodeCodeIntelligence({ readFile: async () => "\uFEFFsame\r\n" })
		const state = start(provider)

		await vi.advanceTimersByTimeAsync(DIAGNOSTICS_GRACE_MS - 1)
		expect(state.result).toBeUndefined()
		await vi.advanceTimersByTimeAsync(1)
		expect(state.result?.get(FILE)).toEqual([])
	})

	it("treats CRLF and LF as the same text", async () => {
		setDocument(FILE, "a\nb\n")
		const provider = createVscodeCodeIntelligence({ readFile: async () => "a\r\nb\r\n" })
		const state = start(provider)

		await vi.advanceTimersByTimeAsync(DIAGNOSTICS_GRACE_MS)
		expect(state.result).toBeDefined()
	})

	it("gives up at the timeout when the document never reloads", async () => {
		setDocument(FILE, "old")
		const provider = createVscodeCodeIntelligence({ readFile: async () => "new" })
		const state = start(provider, 2_000)

		await vi.advanceTimersByTimeAsync(1_999)
		expect(state.result).toBeUndefined()
		await vi.advanceTimersByTimeAsync(1)
		expect(state.result).toBeDefined()
	})

	it("caps the wait at the timeout while diagnostics keep changing", async () => {
		setDocument(FILE, "x")
		const provider = createVscodeCodeIntelligence({ readFile: async () => "x" })
		const state = start(provider, 1_000)

		for (let elapsed = 0; elapsed < 1_000; elapsed += 100) {
			fireDiagnostics(FILE)
			await vi.advanceTimersByTimeAsync(100)
		}
		expect(state.result).toBeDefined()
	})

	it("does not wait for a dirty document to match the disk", async () => {
		setDocument(FILE, "user typing", { isDirty: true })
		const provider = createVscodeCodeIntelligence({ readFile: async () => "new" })
		const state = start(provider)

		await vi.advanceTimersByTimeAsync(DIAGNOSTICS_GRACE_MS)
		expect(state.result).toBeDefined()
	})

	it("returns at once when the document cannot be opened", async () => {
		const provider = createVscodeCodeIntelligence({ readFile: async () => "x" })
		const state = start(provider)

		await vi.advanceTimersByTimeAsync(0)
		expect(state.result?.get(FILE)).toEqual([])
	})

	it("returns at once when the signal aborts", async () => {
		setDocument(FILE, "old")
		const provider = createVscodeCodeIntelligence({ readFile: async () => "new" })
		const controller = new AbortController()
		const state = start(provider, 3_000, controller.signal)
		await vi.advanceTimersByTimeAsync(0)

		controller.abort()
		await vi.advanceTimersByTimeAsync(0)
		expect(state.result).toBeDefined()
	})
})
