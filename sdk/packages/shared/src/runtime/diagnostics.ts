export type DiagnosticGauge = () => number | Record<string, number>;

/**
 * Process-wide activity counters for troubleshooting a host process. Off by
 * default; while off, every recording call returns at once. Callers record
 * names and numbers only, never content.
 */
export class DiagnosticCounters {
	private on = false;
	private readonly totalByName = new Map<string, number>();
	private readonly maxByName = new Map<string, number>();
	private readonly levelByName = new Map<string, number>();
	private readonly gaugeByName = new Map<string, DiagnosticGauge>();

	get enabled(): boolean {
		return this.on;
	}

	enable(): void {
		this.on = true;
	}

	disable(): void {
		this.on = false;
		this.totalByName.clear();
		this.maxByName.clear();
		this.levelByName.clear();
	}

	bump(name: string, n = 1): void {
		if (!this.on) return;
		this.totalByName.set(name, (this.totalByName.get(name) ?? 0) + n);
	}

	/** Largest value since the last `takeMaxes()`. */
	max(name: string, value: number): void {
		if (!this.on) return;
		if (value > (this.maxByName.get(name) ?? Number.NEGATIVE_INFINITY)) {
			this.maxByName.set(name, value);
		}
	}

	/** A running level such as work in flight, counted from when recording was enabled. */
	level(name: string, delta: number): void {
		if (!this.on) return;
		this.levelByName.set(name, (this.levelByName.get(name) ?? 0) + delta);
	}

	/**
	 * Registers a value that is read only while recording. Registrations
	 * survive `disable()`; the returned function removes this one.
	 */
	gauge(name: string, read: DiagnosticGauge): () => void {
		this.gaugeByName.set(name, read);
		return () => {
			if (this.gaugeByName.get(name) === read) this.gaugeByName.delete(name);
		};
	}

	/** A start time for `bumpElapsed`, or 0 while disabled. */
	startTimer(): number {
		return this.on ? performance.now() : 0;
	}

	/** Adds the milliseconds since `start` to `name` and returns them. */
	bumpElapsed(name: string, start: number): number {
		if (!this.on || start === 0) return 0;
		const ms = performance.now() - start;
		this.bump(name, ms);
		return ms;
	}

	totals(): ReadonlyMap<string, number> {
		return this.totalByName;
	}

	levels(): ReadonlyMap<string, number> {
		return this.levelByName;
	}

	gauges(): ReadonlyMap<string, DiagnosticGauge> {
		return this.gaugeByName;
	}

	takeMaxes(): Array<[string, number]> {
		const maxes = [...this.maxByName];
		this.maxByName.clear();
		return maxes;
	}
}

export const diagnostics = new DiagnosticCounters();
