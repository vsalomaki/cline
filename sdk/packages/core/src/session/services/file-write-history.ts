import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { canonicalPath } from "./file-read-ledger";

const MAX_STATES_PER_FILE = 20;

async function hashFile(absolutePath: string): Promise<string | undefined> {
	try {
		return createHash("sha256")
			.update(await fs.readFile(absolutePath))
			.digest("hex");
	} catch {
		return undefined;
	}
}

export interface RevertedFile {
	path: string;
	editsAgo: number;
}

/**
 * Session-owned content hashes of the files Cline wrote, so a write that
 * restores a file to an earlier state can be pointed out to the model.
 */
export class FileWriteHistory {
	private readonly states = new Map<string, string[]>();

	/** Records the content a file has just before Cline writes it. */
	async beforeWrite(absolutePath: string): Promise<void> {
		const hash = await hashFile(absolutePath);
		if (hash) {
			this.push(await canonicalPath(absolutePath), hash);
		}
	}

	/**
	 * Records the content after a write. Returns how many states back the file
	 * last had this content, when the write restores an earlier state. A file
	 * that no longer exists is forgotten.
	 */
	async afterWrite(absolutePath: string): Promise<number | undefined> {
		const key = await canonicalPath(absolutePath);
		const hash = await hashFile(absolutePath);
		if (!hash) {
			this.states.delete(key);
			return undefined;
		}
		const states = this.states.get(key) ?? [];
		const current = states.length - 1;
		const earlier = states.lastIndexOf(hash);
		this.push(key, hash);
		return earlier === -1 || earlier === current
			? undefined
			: current - earlier;
	}

	clear(): void {
		this.states.clear();
	}

	private push(key: string, hash: string): void {
		const states = this.states.get(key) ?? [];
		if (states.at(-1) === hash) {
			return;
		}
		states.push(hash);
		if (states.length > MAX_STATES_PER_FILE) {
			states.shift();
		}
		this.states.set(key, states);
	}
}

export function getFileWriteHistory(
	metadata: Record<string, unknown> | undefined,
): FileWriteHistory | undefined {
	const history = metadata?.fileWriteHistory;
	return history instanceof FileWriteHistory ? history : undefined;
}

function editsAgo(count: number): string {
	return `${count} edit${count === 1 ? "" : "s"} ago`;
}

export function formatRevertNote(reverted: readonly RevertedFile[]): string {
	if (reverted.length === 0) {
		return "";
	}
	if (reverted.length === 1) {
		const [file] = reverted;
		return `\n\nNote: this edit restores ${file.path} to its state from ${editsAgo(file.editsAgo)}, undoing the changes made since then. Check why those changes were made before going back to the earlier version.`;
	}
	const list = reverted
		.map((file) => `- ${file.path} (its state from ${editsAgo(file.editsAgo)})`)
		.join("\n");
	return `\n\nNote: this edit restores these files to earlier states, undoing the changes made since then:\n${list}\nCheck why those changes were made before going back to the earlier versions.`;
}
