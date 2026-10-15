import type { GatewayProviderSettings } from "@cline/shared";

export function ensureFetch(fetchImpl?: typeof fetch): typeof fetch {
	const resolved = fetchImpl ?? globalThis.fetch;
	if (!resolved) {
		throw new Error(
			"No fetch implementation is available. Pass one in the gateway or provider config.",
		);
	}
	return resolved;
}

/**
 * Time to wait for a provider response to start when no timeout is configured.
 *
 * Deliberately generous: Ollama holds `/api/chat` open while it cold-loads
 * the model and only sends response headers once loading finishes, so with a
 * large model the first request of a session routinely takes minutes before
 * the stream starts, and hosted reasoning models can also sit on a request
 * for a while. Unreachable servers are not this timeout's job: connection
 * failures (refused, DNS) reject on their own immediately, and users can
 * always cancel a request. This only bounds the accepted-but-silent case,
 * and 5 minutes matches the header-timeout default other AI SDK-based agents
 * use.
 */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 300_000;

/** The configured timeout, or the default for a missing, zero or invalid one. */
export function resolveResponseTimeoutMs(
	timeoutMs: number | undefined,
): number {
	return typeof timeoutMs === "number" &&
		Number.isFinite(timeoutMs) &&
		timeoutMs > 0
		? Math.floor(timeoutMs)
		: DEFAULT_RESPONSE_TIMEOUT_MS;
}

/**
 * Wraps a fetch so the *response* must start within `timeoutMs`. Once headers
 * arrive the timer is cleared, so streaming the body is never interrupted.
 *
 * A timeout rejects the way undici reports its own headers timeout — a
 * `TypeError("fetch failed")` whose cause carries `UND_ERR_HEADERS_TIMEOUT` —
 * so the AI SDK and the network-retry middleware retry it like any other
 * dropped connection. An upstream abort still rejects as an abort.
 */
export function withResponseTimeout(
	baseFetch: typeof fetch | undefined,
	timeoutMs: number,
): typeof fetch {
	return (async (input, init) => {
		const fetchImpl = ensureFetch(baseFetch);
		const timeoutController = new AbortController();
		const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
		// AbortSignal.any keeps upstream cancellation live for the entire
		// request, including body streaming after the timer is cleared.
		const upstreamSignal =
			init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const signal = upstreamSignal
			? AbortSignal.any([upstreamSignal, timeoutController.signal])
			: timeoutController.signal;
		try {
			return await fetchImpl(input, { ...init, signal });
		} catch (error) {
			if (timeoutController.signal.aborted && !upstreamSignal?.aborted) {
				const cause = Object.assign(
					new Error(
						`Provider request timed out after ${timeoutMs / 1000} seconds without a response`,
					),
					{ code: "UND_ERR_HEADERS_TIMEOUT" },
				);
				throw new TypeError("fetch failed", { cause });
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}) as typeof fetch;
}

export async function resolveApiKey(
	settings: GatewayProviderSettings,
): Promise<string | undefined> {
	const explicitApiKey = settings.apiKey?.trim();
	if (explicitApiKey) {
		return explicitApiKey;
	}

	const resolvedApiKey = await settings.apiKeyResolver?.();
	const trimmedResolvedApiKey = resolvedApiKey?.trim();
	if (trimmedResolvedApiKey) {
		return trimmedResolvedApiKey;
	}

	for (const key of settings.apiKeyEnv ?? []) {
		const value = readEnv(key);
		if (value) {
			return value;
		}
	}

	return undefined;
}

export async function fetchJson(
	url: string,
	init: RequestInit,
	options: {
		fetch: typeof fetch;
		timeoutMs?: number;
		signal?: AbortSignal;
	},
): Promise<unknown> {
	const controller = new AbortController();
	const signal = mergeSignals(options.signal, controller.signal);
	const timeoutMs = options.timeoutMs ?? 30_000;
	const timeout =
		timeoutMs > 0
			? setTimeout(
					() => controller.abort(new Error("Request timed out")),
					timeoutMs,
				)
			: undefined;

	try {
		const response = await options.fetch(url, { ...init, signal });
		const text = await response.text();
		const payload = text ? (JSON.parse(text) as unknown) : undefined;

		if (!response.ok) {
			const message =
				typeof payload === "object" && payload && "error" in payload
					? JSON.stringify((payload as { error: unknown }).error)
					: text || `${response.status} ${response.statusText}`;
			throw new Error(`Gateway request failed: ${message}`);
		}

		return payload;
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

function mergeSignals(
	first: AbortSignal | undefined,
	second: AbortSignal,
): AbortSignal {
	if (!first) {
		return second;
	}

	if (first.aborted) {
		second.throwIfAborted?.();
		return first;
	}

	const controller = new AbortController();
	const abort = (event?: Event) => {
		const target = event?.target as AbortSignal | null;
		controller.abort(target?.reason);
	};

	first.addEventListener("abort", abort, { once: true });
	second.addEventListener("abort", abort, { once: true });
	return controller.signal;
}

export function compactObject<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as T;
}

function readEnv(key: string): string | undefined {
	const env = globalThis.process?.env;
	if (!env) {
		return undefined;
	}

	const value = env[key];
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
