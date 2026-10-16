import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	encodeMessage,
	JsonRpcConnection,
	JsonRpcError,
	METHOD_NOT_FOUND,
	MessageParser,
} from "./json-rpc";

function collect(): { messages: unknown[]; parser: MessageParser } {
	const messages: unknown[] = [];
	return { messages, parser: new MessageParser((m) => messages.push(m)) };
}

describe("encodeMessage", () => {
	it("counts Content-Length in UTF-8 bytes", () => {
		const message = { text: "ä✓😀" };
		const encoded = encodeMessage(message).toString("utf8");
		const body = JSON.stringify(message);
		expect(encoded).toBe(
			`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
		);
		expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(body.length);
	});
});

describe("MessageParser", () => {
	it("parses messages split at every byte, including inside multi-byte characters", () => {
		const first = { id: 1, text: "ünïcødé 😀" };
		const second = { id: 2, text: "✓" };
		const bytes = Buffer.concat([encodeMessage(first), encodeMessage(second)]);
		const { messages, parser } = collect();
		for (let i = 0; i < bytes.length; i++) {
			parser.push(bytes.subarray(i, i + 1));
		}
		expect(messages).toEqual([first, second]);
	});

	it("parses several messages from one chunk and accepts extra headers", () => {
		const body = Buffer.from(JSON.stringify({ id: 3 }), "utf8");
		const withContentType = Buffer.concat([
			Buffer.from(
				`Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`,
			),
			body,
		]);
		const { messages, parser } = collect();
		parser.push(
			Buffer.concat([
				encodeMessage({ id: 1 }),
				withContentType,
				encodeMessage({ id: 2 }),
			]),
		);
		expect(messages).toEqual([{ id: 1 }, { id: 3 }, { id: 2 }]);
	});

	it("skips a body that is not JSON and keeps parsing", () => {
		const bad = Buffer.from("Content-Length: 3\r\n\r\n{x}");
		const { messages, parser } = collect();
		parser.push(Buffer.concat([bad, encodeMessage({ ok: true })]));
		expect(messages).toEqual([{ ok: true }]);
	});
});

function connectionPair(handlers?: {
	onRequest?: (method: string, params: unknown) => unknown;
	onNotification?: (method: string, params: unknown) => void;
}) {
	const toClient = new PassThrough();
	const toServer = new PassThrough();
	const sent: Record<string, unknown>[] = [];
	const serverParser = new MessageParser((message) =>
		sent.push(message as Record<string, unknown>),
	);
	toServer.on("data", (chunk: Buffer) => serverParser.push(chunk));
	const connection = new JsonRpcConnection(toClient, toServer, {
		onRequest: handlers?.onRequest ?? (() => null),
		onNotification: handlers?.onNotification ?? (() => {}),
	});
	const reply = (message: Record<string, unknown>) =>
		toClient.write(encodeMessage({ jsonrpc: "2.0", ...message }));
	const nextSent = async (count: number) => {
		for (let i = 0; i < 50 && sent.length < count; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		return sent;
	};
	return { connection, sent, reply, nextSent };
}

describe("JsonRpcConnection", () => {
	it("resolves a request with the response that has its id", async () => {
		const { connection, reply, nextSent } = connectionPair();
		const first = connection.request("a", { n: 1 });
		const second = connection.request("b", { n: 2 });
		const sent = await nextSent(2);
		expect(sent.map((m) => m.method)).toEqual(["a", "b"]);
		reply({ id: sent[1].id, result: "second" });
		reply({ id: sent[0].id, result: "first" });
		await expect(first).resolves.toBe("first");
		await expect(second).resolves.toBe("second");
	});

	it("rejects with a JsonRpcError on an error response", async () => {
		const { connection, reply, nextSent } = connectionPair();
		const pending = connection.request("a", null);
		const [sent] = await nextSent(1);
		reply({ id: sent.id, error: { code: -32000, message: "nope" } });
		await expect(pending).rejects.toMatchObject({
			name: "JsonRpcError",
			code: -32000,
			message: "nope",
		});
	});

	it("sends $/cancelRequest and rejects when the signal aborts", async () => {
		const { connection, nextSent } = connectionPair();
		const controller = new AbortController();
		const pending = connection.request("slow", null, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow(/abort/i);
		const sent = await nextSent(2);
		expect(sent[1]).toMatchObject({
			method: "$/cancelRequest",
			params: { id: sent[0].id },
		});
	});

	it("answers server requests and reports unknown methods as -32601", async () => {
		const { reply, nextSent } = connectionPair({
			onRequest: (method) => {
				if (method === "known") return [null];
				throw new JsonRpcError("unknown", METHOD_NOT_FOUND);
			},
		});
		reply({ id: "s1", method: "known", params: {} });
		reply({ id: "s2", method: "other", params: {} });
		const sent = await nextSent(2);
		expect(sent).toContainEqual({ jsonrpc: "2.0", id: "s1", result: [null] });
		expect(sent).toContainEqual({
			jsonrpc: "2.0",
			id: "s2",
			error: { code: METHOD_NOT_FOUND, message: "unknown" },
		});
	});

	it("delivers notifications", async () => {
		const notifications: unknown[] = [];
		const { reply } = connectionPair({
			onNotification: (method, params) => notifications.push([method, params]),
		});
		reply({ method: "note", params: { a: 1 } });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(notifications).toEqual([["note", { a: 1 }]]);
	});

	it("rejects pending and later requests once closed", async () => {
		const { connection } = connectionPair();
		const pending = connection.request("a", null);
		connection.close(new Error("gone"));
		await expect(pending).rejects.toThrow("gone");
		await expect(connection.request("b", null)).rejects.toThrow("gone");
	});
});
