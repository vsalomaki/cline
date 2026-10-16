/**
 * Detects shell commands that threw away uncommitted work: the git status of
 * the session's repository is taken before and after each run_commands call,
 * and the differences that mean lost work are reported to the model.
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const GIT_TIMEOUT_MS = 5_000;

export interface ChangedPath {
	untracked: boolean;
	/** Staged as a new file. */
	added?: boolean;
	/** Whether the work tree differs from the index. */
	unstaged: boolean;
	/** Object name of the staged version. */
	indexHash?: string;
}

export interface WorkingTreeSnapshot {
	head: string | undefined;
	/** Changed paths, relative to the repository root. */
	changed: Map<string, ChangedPath>;
	/** Size in bytes of each changed path, undefined when it does not exist. */
	sizes: Map<string, number | undefined>;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await promisify(execFile)(
		"git",
		["--no-optional-locks", "-C", cwd, ...args],
		{ timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
	);
	return stdout;
}

async function sizeOf(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).size;
	} catch {
		return undefined;
	}
}

/** Changed paths, relative to the repository root, from `git status --porcelain=v2 -z`. */
export function parsePorcelainV2(output: string): {
	head: string | undefined;
	files: Map<string, ChangedPath>;
} {
	let head: string | undefined;
	const files = new Map<string, ChangedPath>();
	const entries = output.split("\0");
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const fields = entry.split(" ");
		const tracked = (): ChangedPath => ({
			untracked: false,
			added: fields[1]?.[0] === "A",
			unstaged: fields[1]?.[1] !== ".",
			indexHash: fields[7],
		});
		if (entry.startsWith("# branch.oid ")) {
			const oid = entry.slice("# branch.oid ".length);
			head = oid === "(initial)" ? undefined : oid;
		} else if (entry.startsWith("? ")) {
			files.set(entry.slice(2), { untracked: true, unstaged: true });
		} else if (entry.startsWith("1 ")) {
			files.set(fields.slice(8).join(" "), tracked());
		} else if (entry.startsWith("2 ")) {
			files.set(fields.slice(9).join(" "), tracked());
			// A rename's original path follows as its own entry.
			index += 1;
		} else if (entry.startsWith("u ")) {
			files.set(fields.slice(10).join(" "), {
				untracked: false,
				unstaged: true,
			});
		}
	}
	return { head, files };
}

/**
 * The repository root containing `cwd`, or undefined when `cwd` is not in a
 * git work tree.
 */
export async function findRepositoryRoot(
	cwd: string,
): Promise<string | undefined> {
	try {
		return (
			(await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || undefined
		);
	} catch {
		return undefined;
	}
}

/**
 * The repository's git status, with sizes for the changed paths and for
 * `alsoStat` (the paths a previous snapshot saw changed).
 */
export async function snapshotWorkingTree(
	root: string,
	alsoStat: Iterable<string> = [],
): Promise<WorkingTreeSnapshot | undefined> {
	let output: string;
	try {
		output = await git(root, [
			"status",
			"--porcelain=v2",
			"--branch",
			"--untracked-files=all",
			"-z",
		]);
	} catch {
		return undefined;
	}
	const { head, files } = parsePorcelainV2(output);
	const paths = new Set([...files.keys(), ...alsoStat]);
	const sizes = new Map<string, number | undefined>();
	await Promise.all(
		[...paths].map(async (path) => {
			sizes.set(path, await sizeOf(join(root, path)));
		}),
	);
	return { head, changed: files, sizes };
}

function formatBytes(size: number): string {
	return `${size.toLocaleString("en-US")} bytes`;
}

/**
 * Lines describing work lost between two snapshots: uncommitted changes that
 * are gone, untracked files that were removed, and files that became empty.
 */
export function findLostWork(
	before: WorkingTreeSnapshot,
	after: WorkingTreeSnapshot,
): string[] {
	const lost: string[] = [];
	// A moved HEAD (commit, reset to another commit) also clears changes on
	// purpose, so only removed and emptied files count then.
	const headMoved = before.head !== after.head;
	for (const [path, { untracked, unstaged, indexHash }] of before.changed) {
		if (
			before.sizes.get(path) !== undefined &&
			after.sizes.get(path) === undefined
		) {
			lost.push(`${path}: ${untracked ? "untracked, " : ""}now removed`);
		} else if (!untracked && !headMoved) {
			const now = after.changed.get(path);
			if (now === undefined) {
				lost.push(`${path}: its uncommitted changes are gone`);
			} else if (unstaged && !now.unstaged && now.indexHash === indexHash) {
				// Same staged version and no unstaged changes left: they were
				// discarded, not staged.
				lost.push(`${path}: its unstaged changes are gone`);
			}
		}
	}
	for (const [path, { untracked, added }] of after.changed) {
		const previous = before.sizes.get(path);
		// A new empty file (`touch`, `__init__.py`) is not lost work.
		const created = (untracked || added) && !before.changed.has(path);
		if (after.sizes.get(path) === 0 && previous !== 0 && !created) {
			lost.push(
				previous === undefined
					? `${path}: now empty`
					: `${path}: now empty (was ${formatBytes(previous)})`,
			);
		}
	}
	return lost;
}

export function formatLostWorkNotice(lost: string[]): string {
	return [
		"The last run_commands call discarded uncommitted work:",
		...lost.map((line) => `- ${line}`),
		"If this was not what the task needed, stop and tell the user now. Do not rewrite the lost content from memory; the user may be able to restore it from a checkpoint.",
	].join("\n");
}
