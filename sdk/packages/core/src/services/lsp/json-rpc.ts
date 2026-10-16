import type { Readable, Writable } from "node:stream";

export const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export class JsonRpcError extends Error {
	constructor(
		message: string,
		readonly code: number,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "JsonRpcError";
	}
}

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export function encodeMessage(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	return Buffer.concat([
		Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
		body,
	]);
}

const HEADER_END = Buffer.from("\r\n\r\n", "ascii");

/** Splits a byte stream into `Content-Length` framed JSON messages. */
export class MessageParser {
	private buffer: Buffer = Buffer.alloc(0);
	private bodyLength: number | undefined;

	constructor(private readonly onMessage: (message: unknown) => void) {}

	push(chunk: Buffer): void {
		this.buffer =
			this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		for (;;) {
			if (this.bodyLength === undefined) {
				const headerEnd = this.buffer.indexOf(HEADER_END);
				if (headerEnd < 0) {
					return;
				}
				const header = this.buffer.subarray(0, headerEnd).toString("ascii");
				const match = /^content-length:\s*(\d+)\s*$/im.exec(header);
				this.buffer = this.buffer.subarray(headerEnd + HEADER_END.length);
				if (!match) {
					continue;
				}
				this.bodyLength = Number.parseInt(match[1], 10);
			}
			if (this.buffer.length < this.bodyLength) {
				return;
			}
			const body = this.buffer.subarray(0, this.bodyLength).toString("utf8");
			this.buffer = this.buffer.subarray(this.bodyLength);
			this.bodyLength = undefined;
			let message: unknown;
			try {
				message = JSON.parse(body);
			} catch {
				continue;
			}
			this.onMessage(message);
		}
	}
}

export interface JsonRpcHandlers {
	/** Answers a request from the other side; throw a JsonRpcError to reply with an error. */
	onRequest(method: string, params: unknown): unknown;
	onNotification(method: string, params: unknown): void;
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	cleanup(): void;
}

export class JsonRpcConnection {
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private closedError: Error | undefined;

	constructor(
		input: Readable,
		private readonly output: Writable,
		private readonly handlers: JsonRpcHandlers,
	) {
		const parser = new MessageParser((message) =>
			this.handleMessage(message as JsonRpcMessage),
		);
		input.on("data", (chunk: Buffer) => parser.push(chunk));
	}

	request<T>(
		method: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		if (this.closedError) {
			return Promise.reject(this.closedError);
		}
		if (signal?.aborted) {
			return Promise.reject(abortError(signal));
		}
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => {
				this.pending.get(id)?.cleanup();
				this.pending.delete(id);
				this.notify("$/cancelRequest", { id });
				reject(abortError(signal));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				cleanup: () => signal?.removeEventListener("abort", onAbort),
			});
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (!this.closedError) {
			this.write({ jsonrpc: "2.0", method, params });
		}
	}

	/** Rejects every pending request with `error`; later requests reject with it too. */
	close(error: Error): void {
		if (this.closedError) {
			return;
		}
		this.closedError = error;
		for (const request of this.pending.values()) {
			request.cleanup();
			request.reject(error);
		}
		this.pending.clear();
	}

	private write(message: JsonRpcMessage): void {
		this.output.write(encodeMessage(message));
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (message.method === undefined) {
			if (typeof message.id !== "number") {
				return;
			}
			const request = this.pending.get(message.id);
			if (!request) {
				return;
			}
			this.pending.delete(message.id);
			request.cleanup();
			if (message.error) {
				request.reject(
					new JsonRpcError(
						message.error.message,
						message.error.code,
						message.error.data,
					),
				);
			} else {
				request.resolve(message.result ?? null);
			}
			return;
		}
		if (message.id === undefined || message.id === null) {
			this.handlers.onNotification(message.method, message.params);
			return;
		}
		const id = message.id;
		void Promise.resolve()
			.then(() =>
				this.handlers.onRequest(message.method as string, message.params),
			)
			.then(
				(result) => {
					if (!this.closedError) {
						this.write({ jsonrpc: "2.0", id, result: result ?? null });
					}
				},
				(error: unknown) => {
					if (!this.closedError) {
						this.write({
							jsonrpc: "2.0",
							id,
							error: {
								code:
									error instanceof JsonRpcError ? error.code : INTERNAL_ERROR,
								message: error instanceof Error ? error.message : String(error),
							},
						});
					}
				},
			);
	}
}

function abortError(signal: AbortSignal | undefined): Error {
	const reason = signal?.reason;
	if (reason instanceof Error) {
		return reason;
	}
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}
