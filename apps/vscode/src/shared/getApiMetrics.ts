import type { ContextUsageSnapshot } from "@cline/shared"
import { ClineApiReqInfo, ClineMessage } from "./ExtensionMessage"

interface ApiMetrics {
	totalTokensIn: number
	totalTokensOut: number
	totalCacheWrites?: number
	totalCacheReads?: number
	totalCost: number
}

/**
 * Calculates API metrics from an array of ClineMessages.
 *
 * This function processes usage-carrying say messages.
 * It includes:
 * - 'api_req_started' messages that have been combined with their corresponding 'api_req_finished' messages
 * - 'deleted_api_reqs' messages, which are aggregated from deleted messages
 * - 'subagent_usage' messages, which are aggregated usage snapshots emitted by subagent batches
 * It extracts and sums up the tokensIn, tokensOut, cacheWrites, cacheReads, and cost from these messages.
 *
 * @param messages - An array of ClineMessage objects to process.
 * @returns An ApiMetrics object containing totalTokensIn, totalTokensOut, totalCacheWrites, totalCacheReads, and totalCost.
 *
 * @example
 * const messages = [
 *   { type: "say", say: "api_req_started", text: '{"request":"GET /api/data","tokensIn":10,"tokensOut":20,"cost":0.005}', ts: 1000 }
 * ];
 * const { totalTokensIn, totalTokensOut, totalCost } = getApiMetrics(messages);
 * // Result: { totalTokensIn: 10, totalTokensOut: 20, totalCost: 0.005 }
 */
export function getApiMetrics(messages: ClineMessage[]): ApiMetrics {
	const result: ApiMetrics = {
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalCacheWrites: undefined,
		totalCacheReads: undefined,
		totalCost: 0,
	}

	messages.forEach((message) => {
		if (
			message.type === "say" &&
			(message.say === "api_req_started" || message.say === "deleted_api_reqs" || message.say === "subagent_usage") &&
			message.text
		) {
			try {
				const parsedData = JSON.parse(message.text)
				const { tokensIn, tokensOut, cacheWrites, cacheReads, cost } = parsedData

				if (typeof tokensIn === "number") {
					result.totalTokensIn += tokensIn
				}
				if (typeof tokensOut === "number") {
					result.totalTokensOut += tokensOut
				}
				if (typeof cacheWrites === "number") {
					result.totalCacheWrites = (result.totalCacheWrites ?? 0) + cacheWrites
				}
				if (typeof cacheReads === "number") {
					result.totalCacheReads = (result.totalCacheReads ?? 0) + cacheReads
				}
				if (typeof cost === "number") {
					result.totalCost += cost
				}
			} catch {
				// Ignore JSON parse errors
			}
		}
	})

	return result
}

interface LastRequestScan {
	info: ClineApiReqInfo
	/** The request's provider input: uncached, cache reads and cache writes. */
	inputTokens: number
	/** Input plus output tokens. */
	totalTokens: number
	/** A compaction completed after the request. */
	compactedAfter: boolean
	/** Compounded tokensAfter/tokensBefore of the completed compactions that report both; undefined when none does. */
	shrinkFraction?: number
}

/**
 * Finds the newest api_req_started row that carries tokens, and what completed
 * compactions have happened since. Every "last request" value derives from this
 * one scan, so they agree on which request and which compactions count.
 */
function scanLastRequest(messages: ClineMessage[]): LastRequestScan | undefined {
	let compactedAfter = false
	let shrinkFraction: number | undefined
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.type !== "say" || !msg.text) {
			continue
		}
		try {
			if (msg.say === "compaction") {
				const { status, tokensBefore, tokensAfter } = JSON.parse(msg.text)
				if (status === "completed") {
					compactedAfter = true
					if (
						typeof tokensBefore === "number" &&
						typeof tokensAfter === "number" &&
						tokensBefore > 0 &&
						tokensAfter > 0
					) {
						shrinkFraction = (shrinkFraction ?? 1) * (tokensAfter / tokensBefore)
					}
				}
			}
			if (msg.say === "api_req_started") {
				const info: ClineApiReqInfo = JSON.parse(msg.text)
				const inputTokens = (info.tokensIn || 0) + (info.cacheReads || 0) + (info.cacheWrites || 0)
				const totalTokens = inputTokens + (info.tokensOut || 0)
				if (totalTokens > 0) {
					return { info, inputTokens, totalTokens, compactedAfter, shrinkFraction }
				}
			}
		} catch {
			// Ignore JSON parse errors, continue searching
		}
	}
	return undefined
}

const rescale = (tokens: number, shrinkFraction: number | undefined) =>
	shrinkFraction === undefined ? tokens : Math.ceil(tokens * shrinkFraction)

/**
 * Gets the total token count from the last API request.
 *
 * This is used for context window progress display - it shows how much of the
 * context window is used in the current/most recent request, not cumulative totals.
 *
 * A completed compaction divider that postdates the last request rescales that
 * request's total by the compaction's tokensAfter/tokensBefore ratio, so the
 * context-window bar updates immediately instead of waiting for the next
 * request to run. The ratio is used rather than tokensAfter itself because the
 * compaction counters are the SDK's estimate (chars/4-class), a different
 * scale from the provider-reported usage that normally drives this value —
 * substituting the estimate would make the bar visibly re-snap when the next
 * request's real usage lands. Both counters come from the same estimator, so
 * their ratio is scale-free. Multiple compactions since the last request
 * compound. The ratio is deliberately not clamped to 1: compacting a small
 * conversation can grow the context (the summary outweighs the original
 * messages), and the header must move in the same direction as the divider row
 * (e.g. "1k → 1.3k tokens") rather than silently show the stale value. A
 * completed compaction without both counters leaves the value unscaled.
 *
 * @param messages - An array of ClineMessage objects to process.
 * @returns The total tokens (tokensIn + tokensOut + cacheWrites + cacheReads) from the last api_req_started message, rescaled by any completed compactions that happened after it, or 0 if none found.
 */
export function getLastApiReqTotalTokens(messages: ClineMessage[]): number {
	const last = scanLastRequest(messages)
	return last ? rescale(last.totalTokens, last.shrinkFraction) : 0
}

export interface LastContextUsage {
	snapshot: ContextUsageSnapshot
	/** The request's provider input tokens, cache reads and writes included. */
	inputTokens: number
	/** `inputTokens` rescaled by compactions completed since the request; the number the header shows. */
	usedTokens: number
	/** A compaction completed after the request, so the breakdown is out of date. */
	compactedAfter: boolean
}

/** The latest request's breakdown; undefined when that request carried none. */
export function getLastContextUsage(messages: ClineMessage[]): LastContextUsage | undefined {
	const last = scanLastRequest(messages)
	if (!last?.info.contextUsage || last.inputTokens <= 0) {
		return undefined
	}
	return {
		snapshot: last.info.contextUsage,
		inputTokens: last.inputTokens,
		usedTokens: rescale(last.inputTokens, last.shrinkFraction),
		compactedAfter: last.compactedAfter,
	}
}

/**
 * The context size the header shows: the latest request's provider input when
 * it has a breakdown (as the CLI and core report it), else its total with output.
 */
export function getContextUsedTokens(messages: ClineMessage[]): number {
	return getLastContextUsage(messages)?.usedTokens ?? getLastApiReqTotalTokens(messages)
}
