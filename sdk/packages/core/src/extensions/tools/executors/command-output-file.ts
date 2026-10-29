/**
 * Command output saved to disk. Detached commands stream into these logs, and
 * a finished command whose output was too long for its tool result keeps the
 * whole output here, so the model can read or grep it instead of re-running
 * the command. Each log lives in its own `cline-command-*` directory, removed
 * a retention window after completion by a timer in this process or by
 * `cleanupStaleDetachedCommandLogs` at the next host start.
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	mkdtempSync,
	openSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolContext } from "@cline/shared";

export const DETACHED_LOG_DIRECTORY_PREFIX = "cline-command-";
export const DETACHED_LOG_FILENAME = "output.log";
export const DETACHED_LOG_COMPLETED_FILENAME = "completed-at";
export const MAX_COMMAND_LOG_BYTES = 10 * 1024 * 1024;
export const DEFAULT_COMMAND_LOG_RETENTION_MS = 24 * 60 * 60 * 1_000;

const WRITE_BATCH_CHARS = 64 * 1024;

export function writeLifecycleMarker(path: string, text: string): void {
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, text, "utf8");
		try {
			renameSync(temporaryPath, path);
		} catch (error) {
			// Windows does not replace an existing destination atomically. Existing
			// lifecycle markers are only replaced when corrupt, so remove that
			// unusable generation before installing the valid one.
			if (
				error instanceof Error &&
				"code" in error &&
				["EEXIST", "EPERM"].includes(
					String((error as NodeJS.ErrnoException).code),
				)
			) {
				rmSync(path, { force: true });
				renameSync(temporaryPath, path);
			} else {
				throw error;
			}
		}
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

export function scheduleDetachedLogCleanup(
	directory: string,
	retentionMs: number,
): void {
	const cleanupTimer = setTimeout(() => {
		void rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}, retentionMs);
	cleanupTimer.unref();
}

export interface CommandOutputFileOptions {
	/** Output up to this many characters stays in memory only; the file opens past it. */
	maxChars: number;
	/** Where the log directory is created. @default os.tmpdir() */
	directory?: string;
	/** @default 24 hours */
	retentionMs?: number;
	/** @default 10 MB */
	maxBytes?: number;
	/** Named in the directory so a path shows which session, agent and tool call it belongs to. */
	owner?: Pick<AgentToolContext, "sessionId" | "agentId" | "toolCallId">;
}

export interface SavedCommandOutput {
	path: string;
	totalChars: number;
	/** The file stopped at `maxBytes`; later output was not saved. */
	capped: boolean;
	maxBytes: number;
	retentionMs: number;
}

export interface CommandOutputFile {
	append(text: string): void;
	/** Opens the file before `maxChars` is reached, for a caller about to drop output it holds. */
	spill(): void;
	/** Closes the file and starts its retention. Undefined when nothing was saved. */
	finish(): SavedCommandOutput | undefined;
}

/**
 * Holds a command's output in arrival order until it outgrows `maxChars`, then
 * writes it and everything after to a file. Output that fits never touches
 * disk. Writes are synchronous so the file is complete when `finish` returns.
 * A file that cannot be created or written is dropped quietly: `finish`
 * returns undefined and the caller keeps its plain truncation notice.
 */
export function createCommandOutputFile(
	options: CommandOutputFileOptions,
): CommandOutputFile {
	const parentDirectory = options.directory ?? tmpdir();
	const retentionMs = options.retentionMs ?? DEFAULT_COMMAND_LOG_RETENTION_MS;
	const maxBytes = options.maxBytes ?? MAX_COMMAND_LOG_BYTES;
	const capNote = `\n[Output exceeded the ${formatBytes(maxBytes)} file cap; the rest was not saved]\n`;
	let state: "buffering" | "open" | "failed" | "finished" = "buffering";
	let pending = "";
	let totalChars = 0;
	let bytesWritten = 0;
	let capped = false;
	let directory: string | undefined;
	let path: string | undefined;
	let fd: number | undefined;
	let result: SavedCommandOutput | undefined;

	const closeFile = () => {
		if (fd === undefined) return;
		const open = fd;
		fd = undefined;
		closeSync(open);
	};

	const fail = () => {
		state = "failed";
		pending = "";
		try {
			closeFile();
		} catch {}
	};

	const flush = () => {
		if (fd === undefined || !pending) return;
		const data = Buffer.from(pending, "utf8");
		pending = "";
		const remaining = maxBytes - bytesWritten;
		const accepted =
			data.length <= remaining ? data : data.subarray(0, remaining);
		writeSync(fd, accepted);
		bytesWritten += accepted.length;
		if (accepted.length < data.length) {
			capped = true;
			writeSync(fd, capNote);
		}
	};

	const open = () => {
		try {
			directory = mkdtempSync(
				join(parentDirectory, ownedDirectoryPrefix(options.owner)),
			);
			path = join(directory, DETACHED_LOG_FILENAME);
			fd = openSync(path, "w");
			state = "open";
			flush();
		} catch {
			fail();
		}
	};

	return {
		append(text) {
			if (!text) return;
			totalChars += text.length;
			if (state === "buffering") {
				pending += text;
				if (totalChars > options.maxChars) open();
				return;
			}
			if (state !== "open" || capped) return;
			pending += text;
			if (pending.length < WRITE_BATCH_CHARS) return;
			try {
				flush();
			} catch {
				fail();
			}
		},
		spill() {
			if (state === "buffering") open();
		},
		finish() {
			if (state === "finished") return result;
			if (state === "open") {
				try {
					flush();
					closeFile();
					result = {
						path: path as string,
						totalChars,
						capped,
						maxBytes,
						retentionMs,
					};
				} catch {
					fail();
				}
			}
			state = "finished";
			pending = "";
			if (directory) {
				try {
					writeLifecycleMarker(
						join(directory, DETACHED_LOG_COMPLETED_FILENAME),
						String(Date.now()),
					);
				} catch {
					// The startup reaper falls back to the log's timestamp.
				}
				scheduleDetachedLogCleanup(directory, retentionMs);
			}
			return result;
		},
	};
}

/**
 * `cline-command-s<session>-a<agent>-c<call>-`, from the ends of the ids
 * (their starts are shared prefixes like `agent_`). mkdtemp adds the random
 * suffix that keeps concurrent commands apart.
 */
function ownedDirectoryPrefix(
	owner: CommandOutputFileOptions["owner"],
): string {
	const parts = [
		["s", owner?.sessionId, 8],
		["a", owner?.agentId, 8],
		["c", owner?.toolCallId, 12],
	] as const;
	let prefix = DETACHED_LOG_DIRECTORY_PREFIX;
	for (const [tag, id, length] of parts) {
		const short = id?.replace(/[^A-Za-z0-9]/g, "").slice(-length);
		if (short) prefix += `${tag}${short}-`;
	}
	return prefix;
}

function formatBytes(bytes: number): string {
	const megabytes = bytes / (1024 * 1024);
	return megabytes >= 1
		? `${Math.round(megabytes)} MB`
		: `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDuration(ms: number): string {
	const hours = Math.round(ms / 3_600_000);
	if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"}`;
	const minutes = Math.max(1, Math.round(ms / 60_000));
	return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** The truncation notice for output that was also saved to a file. */
export function savedCommandOutputNotice(saved: SavedCommandOutput): string {
	const what = saved.capped
		? `The first ${formatBytes(saved.maxBytes)} of output is`
		: "The full output is";
	return (
		`[... output truncated: ${saved.totalChars} chars total. ` +
		`${what} saved to ${saved.path} for ${formatDuration(saved.retentionMs)}; ` +
		"read line ranges from it with read_files or grep it instead of re-running the command ...]"
	);
}
