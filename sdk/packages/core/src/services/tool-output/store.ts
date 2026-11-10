/**
 * Durable store for tool output. Results the model has seen, and the full
 * output of commands whose tool result was truncated, are kept here so the
 * model can search or re-read them with the tool_output tool instead of
 * re-running the call. Rows belong to a session (lead and subagents share
 * the root session id) and survive compaction; they go when the session is
 * deleted or by the retention sweep.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { diagnostics } from "@cline/shared";
import { loadSqliteDb, type SqliteDb } from "@cline/shared/db";
import { resolveDbDataDir } from "@cline/shared/storage";

/** Results shorter than this stay in the transcript only. */
export const MIN_STORED_OUTPUT_CHARS = 2_000;
export const MAX_STORED_OUTPUT_CHARS = 10 * 1024 * 1024;
export const TOOL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const TOOL_OUTPUT_MAX_TOTAL_CHARS = 512 * 1024 * 1024;
const MEMORY_STORE_MAX_TOTAL_CHARS = 64 * 1024 * 1024;
const SWEEP_EVERY_PUTS = 200;

export interface ToolOutputRecord {
	id: string;
	sessionId: string;
	agentId?: string;
	toolCallId: string;
	toolName: string;
	/** What the call was, e.g. the command or path; shown by `list`. */
	summary: string;
	chars: number;
	lines: number;
	createdAt: number;
	/** How long the call ran, when known. */
	durationMs?: number;
}

export interface ToolOutputInput {
	sessionId: string;
	agentId?: string;
	toolCallId: string;
	toolName: string;
	summary: string;
	text: string;
	durationMs?: number;
}

export interface ToolOutputStore {
	/** Undefined when the write failed; callers carry on without a stored copy. */
	put(input: ToolOutputInput): ToolOutputRecord | undefined;
	get(sessionId: string, id: string): ToolOutputRecord | undefined;
	readText(sessionId: string, id: string): string | undefined;
	findByToolCall(
		sessionId: string,
		toolCallId: string,
	): ToolOutputRecord | undefined;
	/** Newest first. */
	list(sessionId: string, limit: number): ToolOutputRecord[];
	deleteSession(sessionId: string): void;
}

export function countLines(text: string): number {
	if (!text) return 0;
	let lines = 1;
	for (let index = text.indexOf("\n"); index !== -1; ) {
		if (index < text.length - 1) lines++;
		index = text.indexOf("\n", index + 1);
	}
	return lines;
}

function newOutputId(): string {
	return randomBytes(4).toString("hex");
}

function clampStoredText(text: string): string {
	return text.length > MAX_STORED_OUTPUT_CHARS
		? `${text.slice(0, MAX_STORED_OUTPUT_CHARS)}\n[Stored output stopped at ${MAX_STORED_OUTPUT_CHARS} chars]\n`
		: text;
}

const RECORD_COLUMNS =
	"id, session_id, agent_id, tool_call_id, tool_name, summary, chars, lines, created_at, duration_ms";

function toRecord(row: Record<string, unknown>): ToolOutputRecord {
	return {
		id: String(row.id),
		sessionId: String(row.session_id),
		agentId: typeof row.agent_id === "string" ? row.agent_id : undefined,
		toolCallId: String(row.tool_call_id),
		toolName: String(row.tool_name),
		summary: String(row.summary),
		chars: Number(row.chars),
		lines: Number(row.lines),
		createdAt: Number(row.created_at),
		durationMs:
			typeof row.duration_ms === "number" ? row.duration_ms : undefined,
	};
}

export class SqliteToolOutputStore implements ToolOutputStore {
	private putsSinceSweep = 0;

	constructor(
		private readonly db: SqliteDb,
		private readonly limits = {
			retentionMs: TOOL_OUTPUT_RETENTION_MS,
			maxTotalChars: TOOL_OUTPUT_MAX_TOTAL_CHARS,
		},
	) {
		// Set first: the CLI hub and the IDE can open this file at the same time.
		db.exec("PRAGMA busy_timeout = 5000");
		// auto_vacuum only takes effect on a database without tables.
		db.exec("PRAGMA auto_vacuum = INCREMENTAL");
		db.exec("PRAGMA journal_mode = WAL");
		db.exec(`CREATE TABLE IF NOT EXISTS tool_outputs (
			session_id TEXT NOT NULL,
			id TEXT NOT NULL,
			agent_id TEXT,
			tool_call_id TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			summary TEXT NOT NULL,
			chars INTEGER NOT NULL,
			lines INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			text TEXT NOT NULL,
			duration_ms INTEGER,
			PRIMARY KEY (session_id, id)
		)`);
		try {
			db.exec("ALTER TABLE tool_outputs ADD COLUMN duration_ms INTEGER");
		} catch (error) {
			// Created with the column, or another process added it first.
			if (!String(error).includes("duplicate column name")) throw error;
		}
		db.exec(
			"CREATE INDEX IF NOT EXISTS tool_outputs_call ON tool_outputs (session_id, tool_call_id)",
		);
		db.exec(
			"CREATE INDEX IF NOT EXISTS tool_outputs_created ON tool_outputs (created_at)",
		);
		this.sweep();
	}

	put(input: ToolOutputInput): ToolOutputRecord | undefined {
		const start = diagnostics.startTimer();
		try {
			const text = clampStoredText(input.text);
			const record: Omit<ToolOutputRecord, "id"> = {
				sessionId: input.sessionId,
				agentId: input.agentId,
				toolCallId: input.toolCallId,
				toolName: input.toolName,
				summary: input.summary,
				chars: text.length,
				lines: countLines(text),
				createdAt: Date.now(),
				durationMs: input.durationMs,
			};
			const insert = this.db.prepare(
				`INSERT OR IGNORE INTO tool_outputs (${RECORD_COLUMNS}, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			// Ids are short for the model's sake, so retry the rare clash within a session.
			for (let attempt = 0; attempt < 5; attempt++) {
				const id = newOutputId();
				const { changes } = insert.run(
					id,
					record.sessionId,
					record.agentId ?? null,
					record.toolCallId,
					record.toolName,
					record.summary,
					record.chars,
					record.lines,
					record.createdAt,
					record.durationMs ?? null,
					text,
				);
				if (changes === 1) {
					if (++this.putsSinceSweep >= SWEEP_EVERY_PUTS) this.sweep();
					return { id, ...record };
				}
			}
			return undefined;
		} catch {
			diagnostics.bump("core.toolOutput.putFailed");
			return undefined;
		} finally {
			diagnostics.bumpElapsed("core.toolOutput.putMs", start);
		}
	}

	get(sessionId: string, id: string): ToolOutputRecord | undefined {
		const row = this.db
			.prepare(
				`SELECT ${RECORD_COLUMNS} FROM tool_outputs WHERE session_id = ? AND id = ?`,
			)
			.get(sessionId, id);
		return row ? toRecord(row) : undefined;
	}

	readText(sessionId: string, id: string): string | undefined {
		const row = this.db
			.prepare("SELECT text FROM tool_outputs WHERE session_id = ? AND id = ?")
			.get(sessionId, id);
		return typeof row?.text === "string" ? row.text : undefined;
	}

	findByToolCall(
		sessionId: string,
		toolCallId: string,
	): ToolOutputRecord | undefined {
		const row = this.db
			.prepare(
				`SELECT ${RECORD_COLUMNS} FROM tool_outputs WHERE session_id = ? AND tool_call_id = ? LIMIT 1`,
			)
			.get(sessionId, toolCallId);
		return row ? toRecord(row) : undefined;
	}

	list(sessionId: string, limit: number): ToolOutputRecord[] {
		return this.db
			.prepare(
				`SELECT ${RECORD_COLUMNS} FROM tool_outputs WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
			)
			.all(sessionId, limit)
			.map(toRecord);
	}

	deleteSession(sessionId: string): void {
		this.db
			.prepare("DELETE FROM tool_outputs WHERE session_id = ?")
			.run(sessionId);
	}

	/** Drops rows past the retention, then the oldest rows over the total cap. */
	sweep(now = Date.now()): void {
		this.putsSinceSweep = 0;
		try {
			this.db
				.prepare("DELETE FROM tool_outputs WHERE created_at < ?")
				.run(now - this.limits.retentionMs);
			this.db
				.prepare(
					`DELETE FROM tool_outputs WHERE rowid IN (
						SELECT rowid FROM (
							SELECT rowid, SUM(chars) OVER (ORDER BY created_at DESC, rowid DESC) AS running
							FROM tool_outputs
						) WHERE running > ?
					)`,
				)
				.run(this.limits.maxTotalChars);
			this.db.exec("PRAGMA incremental_vacuum");
		} catch {
			diagnostics.bump("core.toolOutput.sweepFailed");
		}
	}
}

/** Fallback when SQLite cannot be loaded: same contract, gone at process exit. */
export class MemoryToolOutputStore implements ToolOutputStore {
	private readonly entries = new Map<
		string,
		{ record: ToolOutputRecord; text: string }
	>();
	private totalChars = 0;

	constructor(private readonly maxTotalChars = MEMORY_STORE_MAX_TOTAL_CHARS) {}

	put(input: ToolOutputInput): ToolOutputRecord | undefined {
		const text = clampStoredText(input.text);
		let id = newOutputId();
		while (this.entries.has(this.key(input.sessionId, id))) id = newOutputId();
		const record: ToolOutputRecord = {
			id,
			sessionId: input.sessionId,
			agentId: input.agentId,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			summary: input.summary,
			chars: text.length,
			lines: countLines(text),
			createdAt: Date.now(),
			durationMs: input.durationMs,
		};
		this.entries.set(this.key(input.sessionId, id), { record, text });
		this.totalChars += text.length;
		for (const [key, entry] of this.entries) {
			if (this.totalChars <= this.maxTotalChars) break;
			this.entries.delete(key);
			this.totalChars -= entry.text.length;
		}
		return this.entries.has(this.key(input.sessionId, id)) ? record : undefined;
	}

	get(sessionId: string, id: string): ToolOutputRecord | undefined {
		return this.entries.get(this.key(sessionId, id))?.record;
	}

	readText(sessionId: string, id: string): string | undefined {
		return this.entries.get(this.key(sessionId, id))?.text;
	}

	findByToolCall(
		sessionId: string,
		toolCallId: string,
	): ToolOutputRecord | undefined {
		for (const { record } of this.entries.values()) {
			if (record.sessionId === sessionId && record.toolCallId === toolCallId)
				return record;
		}
		return undefined;
	}

	list(sessionId: string, limit: number): ToolOutputRecord[] {
		return [...this.entries.values()]
			.filter(({ record }) => record.sessionId === sessionId)
			.map(({ record }) => record)
			.reverse()
			.slice(0, limit);
	}

	deleteSession(sessionId: string): void {
		for (const [key, { record, text }] of this.entries) {
			if (record.sessionId !== sessionId) continue;
			this.entries.delete(key);
			this.totalChars -= text.length;
		}
	}

	private key(sessionId: string, id: string): string {
		return `${sessionId}\u0000${id}`;
	}
}

/** The store the session runtime hands executors in `metadata.toolOutputStore`. */
export function getToolOutputStoreFromContext(context: {
	metadata?: Record<string, unknown>;
}): ToolOutputStore | undefined {
	const store = context.metadata?.toolOutputStore;
	return store && typeof store === "object" && "put" in store
		? (store as ToolOutputStore)
		: undefined;
}

let sharedStore: ToolOutputStore | undefined;

/** The process-wide store, opened on first use. */
export function getToolOutputStore(): ToolOutputStore {
	if (!sharedStore) {
		try {
			sharedStore = new SqliteToolOutputStore(
				loadSqliteDb(join(resolveDbDataDir(), "tool-output.db")),
			);
		} catch {
			diagnostics.bump("core.toolOutput.memoryFallback");
			sharedStore = new MemoryToolOutputStore();
		}
	}
	return sharedStore;
}
