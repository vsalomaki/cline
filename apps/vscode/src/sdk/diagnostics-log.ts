import * as v8 from "node:v8"
import { diagnostics } from "@cline/shared"
import { Logger } from "@/shared/services/Logger"

const MB = 1024 * 1024
const INTERVAL_MS = 1000
const HEARTBEAT_MS = 30_000
const HEAP_STEP_BYTES = 20 * MB
const HIGH_RATIO = 0.6
const HEAP_CHECK_EVERY_EVENTS = 50

function fmt(n: number): string {
	const abs = Math.abs(n)
	if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`
	if (abs >= 1e4) return `${(n / 1e3).toFixed(0)}k`
	return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function mb(bytes: number): string {
	return (bytes / MB).toFixed(0)
}

/**
 * Writes one `[diag]` line a second to the Cline output while on: process memory plus the
 * diagnostics registry's counter deltas, per-line maxima, levels and gauges.
 */
export class DiagnosticsLog {
	private readonly printed = new Map<string, number>()
	private timer: NodeJS.Timeout | undefined
	private heapLimit = 0
	private startedAt = 0
	private lastEvalAt = 0
	private lastPrintAt = 0
	private lastPrintedHeap = 0
	private line = 0
	private eventsSinceHeapCheck = 0
	private highFired = false

	get running(): boolean {
		return this.timer !== undefined
	}

	setEnabled(enabled: boolean): void {
		if (enabled) this.start()
		else this.stop()
	}

	start(): void {
		if (this.timer) return
		this.heapLimit = v8.getHeapStatistics().heap_size_limit
		this.startedAt = performance.now()
		this.lastEvalAt = this.startedAt
		this.lastPrintAt = 0
		this.lastPrintedHeap = 0
		this.line = 0
		this.eventsSinceHeapCheck = 0
		this.highFired = false
		diagnostics.enable()
		Logger.info(
			`[diag] start heap_size_limit=${mb(this.heapLimit)}MB high_at=${mb(this.heapLimit * HIGH_RATIO)}MB pid=${process.pid} node=${process.version}`,
		)
		this.timer = setInterval(() => this.evaluate("timer"), INTERVAL_MS)
		this.timer.unref?.()
	}

	stop(): void {
		if (!this.timer) return
		clearInterval(this.timer)
		this.timer = undefined
		diagnostics.disable()
		this.printed.clear()
		Logger.info("[diag] stop")
	}

	/** Called on the event path so a starved timer still produces lines, and heap growth is caught between them. */
	tick(): void {
		if (!this.timer) return
		if (++this.eventsSinceHeapCheck >= HEAP_CHECK_EVERY_EVENTS) {
			this.eventsSinceHeapCheck = 0
			const used = v8.getHeapStatistics().used_heap_size
			if (!this.highFired && used > this.heapLimit * HIGH_RATIO) {
				this.evaluate("event", true)
				return
			}
		}
		if (performance.now() - this.lastEvalAt >= INTERVAL_MS) {
			this.evaluate("event")
		}
	}

	private evaluate(source: "timer" | "event", forceHigh = false): void {
		try {
			const now = performance.now()
			const dt = now - this.lastEvalAt
			this.lastEvalAt = now
			const mem = process.memoryUsage()
			const totals = diagnostics.totals()
			const deltas: string[] = []
			for (const [name, total] of totals) {
				const delta = total - (this.printed.get(name) ?? 0)
				if (delta !== 0) deltas.push(`${name}=${fmt(delta)}`)
			}
			const heapMoved = Math.abs(mem.heapUsed - this.lastPrintedHeap) > HEAP_STEP_BYTES
			const heartbeat = now - this.lastPrintAt >= HEARTBEAT_MS
			const high = !this.highFired && (forceHigh || mem.heapUsed > this.heapLimit * HIGH_RATIO)
			if (deltas.length === 0 && !heapMoved && !heartbeat && !high) {
				return
			}
			for (const [name, total] of totals) this.printed.set(name, total)
			const maxes = diagnostics.takeMaxes().map(([name, v]) => `${name}=${fmt(v)}`)
			const gauges = this.readGauges(false)
			this.line++
			this.lastPrintAt = now
			this.lastPrintedHeap = mem.heapUsed
			const head =
				`[diag] #${this.line} t=${((now - this.startedAt) / 1000).toFixed(1)}s src=${source} dt=${dt.toFixed(0)}ms ` +
				`heap=${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB ext=${mb(mem.external)} ab=${mb(mem.arrayBuffers)} rss=${mb(mem.rss)}`
			const parts = [head]
			if (deltas.length) parts.push(`d: ${deltas.join(" ")}`)
			if (maxes.length) parts.push(`max: ${maxes.join(" ")}`)
			if (gauges.length) parts.push(`g: ${gauges.join(" ")}`)
			Logger.info(parts.join(" | "))
			if (high) this.printHigh(mem)
		} catch (error) {
			Logger.info(`[diag] evaluate failed: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	private readGauges(includeZero: boolean): string[] {
		const out: string[] = []
		for (const [name, value] of diagnostics.levels()) {
			if (includeZero || value !== 0) out.push(`${name}=${fmt(value)}`)
		}
		for (const [name, read] of diagnostics.gauges()) {
			let value: number | Record<string, number>
			try {
				value = read()
			} catch {
				out.push(`${name}=ERR`)
				continue
			}
			if (typeof value === "number") {
				if (includeZero || value !== 0) out.push(`${name}=${fmt(value)}`)
				continue
			}
			for (const [key, v] of Object.entries(value)) {
				if (includeZero || v !== 0) out.push(`${name}.${key}=${fmt(v)}`)
			}
		}
		return out
	}

	private printHigh(mem: NodeJS.MemoryUsage): void {
		this.highFired = true
		const totals = [...diagnostics.totals()]
			.sort((a, b) => b[1] - a[1])
			.map(([name, v]) => `${name}=${fmt(v)}`)
			.join(" ")
		Logger.info(
			`[diag] HIGH heap=${mb(mem.heapUsed)}MB of limit ${mb(this.heapLimit)}MB after ${((performance.now() - this.startedAt) / 1000).toFixed(1)}s`,
		)
		Logger.info(`[diag] HIGH totals: ${totals}`)
		Logger.info(`[diag] HIGH gauges: ${this.readGauges(true).join(" ")}`)
		Logger.info("[diag] HIGH end")
	}
}

export const diagnosticsLog = new DiagnosticsLog()
