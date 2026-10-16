// A minimal language server for tests. Lines containing `ERROR: text` or
// `WARN: text` produce diagnostics; `function|class|method name` lines are
// symbols. Hovering `STATE` returns what the client answered to the server's
// own requests; hovering `CRASH` makes the server exit. With FAKE_LSP_PULL=1
// it only answers `textDocument/diagnostic` and never pushes. With
// FAKE_LSP_STALE=1 each change first republishes the previous diagnostics, and
// FAKE_LSP_VERSIONED=1 adds the document version to publishes.
import { fileURLToPath } from "node:url";

const publishDelayMs = Number(process.env.FAKE_LSP_PUBLISH_DELAY_MS ?? 20);
const hangInitialize = process.env.FAKE_LSP_HANG_INITIALIZE === "1";
const pullOnly = process.env.FAKE_LSP_PULL === "1";
const staleFirst = process.env.FAKE_LSP_STALE === "1";
const versioned = process.env.FAKE_LSP_VERSIONED === "1";
const documents = new Map();
const state = {};
let nextServerRequestId = 1;
const serverRequests = new Map();

function send(message) {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
	process.stdout.write(
		Buffer.concat([
			Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
			body,
		]),
	);
}

function requestClient(method, params) {
	const id = `server-${nextServerRequestId++}`;
	send({ id, method, params });
	return new Promise((resolve) => serverRequests.set(id, resolve));
}

function lines(uri) {
	return (documents.get(uri)?.text ?? "").split("\n");
}

function wordAt(uri, position) {
	const line = lines(uri)[position.line] ?? "";
	const isWord = (char) => /[\w$]/.test(char ?? "");
	let start = position.character;
	let end = position.character;
	while (start > 0 && isWord(line[start - 1])) start--;
	while (isWord(line[end])) end++;
	return line.slice(start, end);
}

function range(line, character, length) {
	return {
		start: { line, character },
		end: { line, character: character + length },
	};
}

function diagnosticsFor(uri) {
	const diagnostics = [];
	lines(uri).forEach((text, line) => {
		for (const [marker, severity] of [
			["ERROR:", 1],
			["WARN:", 2],
		]) {
			const index = text.indexOf(marker);
			if (index >= 0) {
				diagnostics.push({
					range: range(line, index, marker.length),
					severity,
					source: "fake",
					code: 1001,
					message: text.slice(index + marker.length).trim(),
				});
			}
		}
	});
	return diagnostics;
}

function sendDiagnostics(uri, diagnostics, version) {
	send({
		method: "textDocument/publishDiagnostics",
		params: { uri, diagnostics, ...(versioned ? { version } : {}) },
	});
}

function publish(uri) {
	if (pullOnly) return;
	const diagnostics = diagnosticsFor(uri);
	const version = documents.get(uri)?.version;
	setTimeout(() => sendDiagnostics(uri, diagnostics, version), publishDelayMs);
}

function symbolsIn(uri) {
	const symbols = [];
	lines(uri).forEach((text, line) => {
		const match = /^(\s*)(function|class|method)\s+(\w+)/.exec(text);
		if (!match) return;
		const kind = { function: 12, class: 5, method: 6 }[match[2]];
		const character = match[1].length + match[2].length + 1;
		const symbol = {
			name: match[3],
			kind,
			range: range(line, 0, text.length),
			selectionRange: range(line, character, match[3].length),
		};
		const parent = symbols.at(-1);
		if (match[1].length > 0 && parent) {
			parent.children = [...(parent.children ?? []), symbol];
		} else {
			symbols.push(symbol);
		}
	});
	return symbols;
}

function occurrences(word) {
	const found = [];
	const pattern = new RegExp(`\\b${word}\\b`, "g");
	for (const uri of documents.keys()) {
		lines(uri).forEach((text, line) => {
			for (const match of text.matchAll(pattern)) {
				found.push({ uri, range: range(line, match.index, word.length) });
			}
		});
	}
	return found;
}

function handleRequest(method, params) {
	switch (method) {
		case "initialize":
			state.processId = params.processId;
			state.rootPath = fileURLToPath(params.rootUri);
			state.initializationOptions = params.initializationOptions ?? null;
			return {
				capabilities: {
					textDocumentSync: 1,
					definitionProvider: true,
					implementationProvider: true,
					referencesProvider: true,
					hoverProvider: true,
					documentSymbolProvider: true,
					workspaceSymbolProvider: true,
					...(pullOnly
						? { diagnosticProvider: { interFileDependencies: false } }
						: {}),
				},
			};
		case "shutdown":
			return null;
		case "textDocument/definition": {
			const word = wordAt(params.textDocument.uri, params.position);
			return occurrences(word)
				.filter(({ uri, range: r }) =>
					/\b(function|class|method)\s+$/.test(
						lines(uri)[r.start.line].slice(0, r.start.character),
					),
				)
				.map(({ uri, range: r }) => ({
					targetUri: uri,
					targetRange: range(r.start.line, 0, 1),
					targetSelectionRange: r,
				}));
		}
		case "textDocument/implementation": {
			const word = wordAt(params.textDocument.uri, params.position);
			return occurrences(word)[0] ?? null;
		}
		case "textDocument/references":
			return occurrences(wordAt(params.textDocument.uri, params.position));
		case "textDocument/hover": {
			const word = wordAt(params.textDocument.uri, params.position);
			if (word === "CRASH") {
				process.stderr.write("fake server crashed on purpose\n");
				process.exit(3);
			}
			if (word === "STATE") {
				return {
					contents: { kind: "plaintext", value: JSON.stringify(state) },
				};
			}
			if (word === "marked") {
				return {
					contents: [
						"plain part",
						{ language: "ts", value: "const marked: 1" },
					],
				};
			}
			return word
				? { contents: { kind: "markdown", value: `**${word}** — ünïcødé ✓` } }
				: null;
		}
		case "textDocument/diagnostic":
			return { kind: "full", items: diagnosticsFor(params.textDocument.uri) };
		case "textDocument/documentSymbol":
			return symbolsIn(params.textDocument.uri);
		case "workspace/symbol":
			return [...documents.keys()].flatMap((uri) =>
				symbolsIn(uri)
					.flatMap((symbol) => [symbol, ...(symbol.children ?? [])])
					.filter((symbol) => symbol.name.includes(params.query))
					.map((symbol) => ({
						name: symbol.name,
						kind: symbol.kind,
						location: { uri, range: symbol.selectionRange },
					})),
			);
		default:
			throw Object.assign(new Error(`Unhandled ${method}`), { code: -32601 });
	}
}

async function handleNotification(method, params) {
	switch (method) {
		case "initialized": {
			send({ method: "window/logMessage", params: { type: 3, message: "hi" } });
			send({ method: "$/progress", params: { token: 1, value: {} } });
			state.configuration = await requestClient("workspace/configuration", {
				items: [{ section: "a" }, { section: "b" }],
			});
			state.register = await requestClient("client/registerCapability", {
				registrations: [],
			});
			state.folders = await requestClient("workspace/workspaceFolders", null);
			state.unknown = await requestClient("fake/unknown", null);
			break;
		}
		case "textDocument/didOpen":
			documents.set(params.textDocument.uri, {
				text: params.textDocument.text,
				languageId: params.textDocument.languageId,
				version: params.textDocument.version,
			});
			state.lastLanguageId = params.textDocument.languageId;
			publish(params.textDocument.uri);
			break;
		case "textDocument/didChange":
			if (staleFirst) {
				const previous = documents.get(params.textDocument.uri);
				sendDiagnostics(
					params.textDocument.uri,
					diagnosticsFor(params.textDocument.uri),
					previous?.version,
				);
			}
			documents.set(params.textDocument.uri, {
				...documents.get(params.textDocument.uri),
				text: params.contentChanges.at(-1).text,
				version: params.textDocument.version,
			});
			publish(params.textDocument.uri);
			break;
		case "textDocument/didClose":
			documents.delete(params.textDocument.uri);
			state.closed = [...(state.closed ?? []), params.textDocument.uri];
			break;
		case "textDocument/didSave":
			state.saves = (state.saves ?? 0) + 1;
			break;
		case "exit":
			process.exit(0);
	}
}

function handle(message) {
	if (message.method === undefined) {
		const resolve = serverRequests.get(message.id);
		serverRequests.delete(message.id);
		resolve?.(message.error ? { error: message.error.code } : message.result);
		return;
	}
	if (message.id === undefined) {
		void handleNotification(message.method, message.params);
		return;
	}
	if (message.method === "initialize" && hangInitialize) {
		return;
	}
	try {
		send({
			id: message.id,
			result: handleRequest(message.method, message.params),
		});
	} catch (error) {
		send({
			id: message.id,
			error: { code: error.code ?? -32603, message: error.message },
		});
	}
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		const length = Number(
			/content-length:\s*(\d+)/i.exec(
				buffer.subarray(0, headerEnd).toString(),
			)[1],
		);
		if (buffer.length < headerEnd + 4 + length) return;
		const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length);
		buffer = buffer.subarray(headerEnd + 4 + length);
		handle(JSON.parse(body.toString("utf8")));
	}
});
process.stdin.on("end", () => process.exit(0));
