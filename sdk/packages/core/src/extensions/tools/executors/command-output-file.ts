/**
 * Command output kept beyond the tool result. Detached commands stream into
 * log files, each in its own `cline-command-*` directory, removed a retention
 * window after completion by a timer in this process or by
 * `cleanupStaleDetachedCommandLogs` at the next host start. A finished
 * command whose output was too long for its tool result goes to the tool
 * output store, so the model can search it instead of re-running the command.
 */

import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AgentToolContext } from "@cline/shared";
import { getToolOutputStoreFromContext } from "../../../services/tool-output/store";
import { toolOutputSearchCall } from "../tool-output-tool";

export const DETACHED_LOG_DIRECTORY_PREFIX = "cline-command-";
export const DETACHED_LOG_FILENAME = "output.log";
export const DETACHED_LOG_COMPLETED_FILENAME = "completed-at";
export const MAX_COMMAND_LOG_BYTES = 10 * 1024 * 1024;
export const DEFAULT_COMMAND_LOG_RETENTION_MS = 24 * 60 * 60 * 1_000;

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

export interface CommandOutputCaptureOptions {
	/** Output up to this many characters fits the tool result and is not stored. */
	maxChars: number;
	/** Supplies the store (`metadata.toolOutputStore`) and the owning session, agent and tool call. */
	context: Pick<
		AgentToolContext,
		"sessionId" | "agentId" | "toolCallId" | "metadata"
	>;
	/** The command, shown when the model lists stored output. */
	summary: string;
	/** @default 10 MB */
	maxStoredChars?: number;
}

export interface SavedCommandOutput {
	id: string;
	totalChars: number;
	/** Storage stopped at `maxStoredChars`; later output was not kept. */
	capped: boolean;
	maxStoredChars: number;
}

export interface CommandOutputCapture {
	append(text: string): void;
	/** Stores the output even if it fits, for a caller about to drop output it holds. */
	spill(): void;
	/** Stores the output if it outgrew `maxChars`. Undefined when nothing was stored. */
	finish(): SavedCommandOutput | undefined;
}

/**
 * Keeps a command's output in arrival order, up to `maxStoredChars`, and puts
 * it in the tool output store when the command finishes with more output than
 * its tool result holds. Without a store in the context nothing is kept and
 * the caller falls back to its plain truncation notice.
 */
export function createCommandOutputCapture(
	options: CommandOutputCaptureOptions,
): CommandOutputCapture {
	const store = getToolOutputStoreFromContext(options.context);
	const maxStoredChars = options.maxStoredChars ?? MAX_COMMAND_LOG_BYTES;
	const startedAt = Date.now();
	let chunks: string[] = [];
	let storedChars = 0;
	let totalChars = 0;
	let capped = false;
	let spilled = false;
	let finished = false;
	let result: SavedCommandOutput | undefined;

	return {
		append(text) {
			if (!text || finished) return;
			totalChars += text.length;
			if (!store || capped) return;
			const room = maxStoredChars - storedChars;
			const kept = text.length <= room ? text : text.slice(0, room);
			if (kept.length < text.length) capped = true;
			if (!kept) return;
			chunks.push(kept);
			storedChars += kept.length;
		},
		spill() {
			spilled = true;
		},
		finish() {
			if (finished) return result;
			finished = true;
			if (
				store &&
				chunks.length > 0 &&
				(spilled || totalChars > options.maxChars)
			) {
				const capNote = capped
					? `\n[Output exceeded ${formatBytes(maxStoredChars)}; the rest was not stored]\n`
					: "";
				const record = store.put({
					sessionId: options.context.sessionId ?? options.context.agentId,
					agentId: options.context.agentId,
					// Kept apart from the tool call's own result, which a batch of commands shares.
					toolCallId: `${options.context.toolCallId ?? ""}/command`,
					toolName: "run_commands",
					summary: options.summary,
					text: chunks.join("") + capNote,
					durationMs: Date.now() - startedAt,
				});
				if (record) {
					result = { id: record.id, totalChars, capped, maxStoredChars };
				}
			}
			chunks = [];
			return result;
		},
	};
}

function formatBytes(bytes: number): string {
	const megabytes = bytes / (1024 * 1024);
	return megabytes >= 1
		? `${Math.round(megabytes)} MB`
		: `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The truncation notice for output that was also stored. */
export function savedCommandOutputNotice(saved: SavedCommandOutput): string {
	const what = saved.capped
		? `The first ${formatBytes(saved.maxStoredChars)} of output is`
		: "The full output is";
	return (
		`[... output truncated: ${saved.totalChars} chars total. ` +
		`${what} stored as tool output ${saved.id}${saved.capped ? "; later output was not stored" : ""}. ` +
		`To see more of it, use ${toolOutputSearchCall(saved.id)} or read a line range with tool_output instead of re-running the command ...]`
	);
}
