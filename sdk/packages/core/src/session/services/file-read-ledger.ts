import * as fs from "node:fs/promises";

interface FileStamp {
	mtimeMs: number;
	size: number;
}

async function canonicalPath(absolutePath: string): Promise<string> {
	return fs.realpath(absolutePath).catch(() => absolutePath);
}

async function statStamp(absolutePath: string): Promise<FileStamp | undefined> {
	try {
		const { mtimeMs, size } = await fs.stat(absolutePath);
		return { mtimeMs, size };
	} catch {
		return undefined;
	}
}

/**
 * Session-owned record of the files the model has read, so edits to a file it
 * has not seen, or that changed since it last saw it, can be refused.
 */
export class FileReadLedger {
	private readonly stamps = new Map<string, FileStamp>();

	async record(absolutePath: string, stamp: FileStamp): Promise<void> {
		this.stamps.set(await canonicalPath(absolutePath), {
			mtimeMs: stamp.mtimeMs,
			size: stamp.size,
		});
	}

	/** Re-stamps a file after Cline itself wrote it. */
	async recordCurrent(absolutePath: string): Promise<void> {
		const stamp = await statStamp(absolutePath);
		if (stamp) {
			await this.record(absolutePath, stamp);
		}
	}

	/** Returns why an edit to an existing file must wait for a read, if it must. */
	async checkEditable(
		absolutePath: string,
		displayPath = absolutePath,
	): Promise<string | undefined> {
		const current = await statStamp(absolutePath);
		if (!current) {
			return undefined;
		}
		const recorded = this.stamps.get(await canonicalPath(absolutePath));
		if (!recorded) {
			return `${displayPath} has not been read in this session. Read it with read_files before editing it.`;
		}
		if (
			recorded.mtimeMs !== current.mtimeMs ||
			recorded.size !== current.size
		) {
			return `${displayPath} changed since it was last read. Read it again with read_files before editing it.`;
		}
		return undefined;
	}

	clear(): void {
		this.stamps.clear();
	}
}

export function getFileReadLedger(
	metadata: Record<string, unknown> | undefined,
): FileReadLedger | undefined {
	const ledger = metadata?.fileReadLedger;
	return ledger instanceof FileReadLedger ? ledger : undefined;
}
