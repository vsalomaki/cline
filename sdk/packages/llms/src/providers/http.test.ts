import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_RESPONSE_TIMEOUT_MS,
	resolveResponseTimeoutMs,
	withResponseTimeout,
} from "./http";

const hangingFetch = ((_input, init) =>
	new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
	})) as typeof fetch;

describe("resolveResponseTimeoutMs", () => {
	it("reads a configured timeout", () => {
		expect(resolveResponseTimeoutMs(180_000)).toBe(180_000);
	});

	it("falls back to 5 minutes for missing or invalid values", () => {
		// Ollama only sends response headers once the model is loaded, so the
		// response-start budget must cover a cold load.
		expect(DEFAULT_RESPONSE_TIMEOUT_MS).toBe(300_000);
		expect(resolveResponseTimeoutMs(undefined)).toBe(300_000);
		expect(resolveResponseTimeoutMs(0)).toBe(300_000);
		expect(resolveResponseTimeoutMs(-5)).toBe(300_000);
		expect(resolveResponseTimeoutMs(Number.NaN)).toBe(300_000);
	});
});

describe("withResponseTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("rejects like a dropped connection when the response does not start in time", async () => {
		const wrapped = withResponseTimeout(hangingFetch, 1000);
		const pending = wrapped("https://api.example.com/v1/chat");
		const assertion = pending.then(
			() => expect.unreachable(),
			(error: TypeError & { cause?: Error & { code?: string } }) => {
				expect(error).toBeInstanceOf(TypeError);
				expect(error.message).toBe("fetch failed");
				expect(error.cause?.code).toBe("UND_ERR_HEADERS_TIMEOUT");
				expect(error.cause?.message).toBe(
					"Provider request timed out after 1 seconds without a response",
				);
			},
		);
		await vi.advanceTimersByTimeAsync(1001);
		await assertion;
	});

	it("does not abort once the response has started", async () => {
		let requestSignal: AbortSignal | undefined;
		const immediateFetch = (async (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			return new Response("ok");
		}) as typeof fetch;

		const wrapped = withResponseTimeout(immediateFetch, 1000);
		const response = await wrapped("https://api.example.com/v1/chat");
		await vi.advanceTimersByTimeAsync(5000);

		expect(response.ok).toBe(true);
		expect(requestSignal?.aborted).toBe(false);
	});

	it("propagates upstream aborts unchanged", async () => {
		const upstream = new AbortController();
		const wrapped = withResponseTimeout(hangingFetch, 60_000);
		const pending = wrapped("https://api.example.com/v1/chat", {
			signal: upstream.signal,
		});
		const assertion = expect(pending).rejects.toThrow("user cancelled");
		upstream.abort(new Error("user cancelled"));
		await assertion;
	});

	it("keeps the cancellation signal of a Request input", async () => {
		const upstream = new AbortController();
		const wrapped = withResponseTimeout(hangingFetch, 60_000);
		const pending = wrapped(
			new Request("https://api.example.com/v1/chat", {
				signal: upstream.signal,
			}),
		);
		const assertion = expect(pending).rejects.toThrow("user cancelled");
		upstream.abort(new Error("user cancelled"));
		await assertion;
	});

	it("falls back to the global fetch when none is configured", async () => {
		const globalFetch = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", globalFetch);
		try {
			await withResponseTimeout(undefined, 1000)("https://api.example.com");
			expect(globalFetch).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
