/**
 * Review before the final report: when the model answers a request without
 * tool calls after files changed, it is sent back once to review the whole
 * run before reporting. The changes are listed from the session repository's
 * git status at the start of the run and now, plus the paths the edit tools
 * wrote (which also covers files git does not track).
 */

import { isAbsolute, relative, resolve } from "node:path";
import type {
	AgentAfterToolContext,
	AgentExtension,
	AgentRunStartResult,
} from "@cline/shared";
import { DefaultToolNames } from "../../extensions/tools/constants";
import {
	findRepositoryRoot,
	formatBytes,
	git,
	snapshotWorkingTree,
	type WorkingTreeSnapshot,
} from "../../extensions/tools/uncommitted-work-check";

export const RUN_REVIEW_EXTENSION_NAME = "core.run-review";

const MAX_LISTED_FILES = 50;

const PATCH_FILE_LINE =
	/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

/** Paths an editor or apply_patch call wrote, as the model gave them. */
export function editedPaths(toolName: string, input: unknown): string[] {
	if (input === null || typeof input !== "object") {
		return typeof input === "string" &&
			toolName === DefaultToolNames.APPLY_PATCH
			? [...input.matchAll(PATCH_FILE_LINE)].map((match) => match[1].trim())
			: [];
	}
	const record = input as Record<string, unknown>;
	if (toolName === DefaultToolNames.EDITOR && typeof record.path === "string") {
		return [record.path];
	}
	if (
		toolName === DefaultToolNames.APPLY_PATCH &&
		typeof record.input === "string"
	) {
		return [...record.input.matchAll(PATCH_FILE_LINE)].map((match) =>
			match[1].trim(),
		);
	}
	return [];
}

/**
 * One line per path that changed between the two snapshots. `committedSizes`
 * gives the size at the run's start of tracked files that were clean then.
 */
export function describeChanges(
	before: WorkingTreeSnapshot,
	after: WorkingTreeSnapshot,
	committedSizes: ReadonlyMap<string, number> = new Map(),
): Map<string, string> {
	const changes = new Map<string, string>();
	const headMoved = before.head !== after.head;
	const paths = new Set([...before.changed.keys(), ...after.changed.keys()]);
	for (const path of paths) {
		const was = before.changed.get(path);
		const now = after.changed.get(path);
		const wasSize = before.sizes.get(path);
		const size = after.sizes.get(path);
		if (
			was &&
			now &&
			wasSize === size &&
			before.mtimes.get(path) === after.mtimes.get(path) &&
			was.indexHash === now.indexHash &&
			was.unstaged === now.unstaged
		) {
			continue;
		}
		if (size === undefined) {
			changes.set(
				path,
				wasSize === undefined
					? "deleted"
					: `deleted (was ${formatBytes(wasSize)})`,
			);
		} else if (!now) {
			changes.set(
				path,
				headMoved
					? "committed"
					: "back to the committed version; its uncommitted changes are gone",
			);
		} else if (!was) {
			const committed = committedSizes.get(path);
			changes.set(
				path,
				now.untracked || now.added
					? `new (${formatBytes(size)})`
					: committed === undefined
						? size === 0
							? "now empty"
							: `modified (now ${formatBytes(size)})`
						: size === 0
							? `now empty (was ${formatBytes(committed)})`
							: `modified (${formatBytes(committed)} → ${formatBytes(size)})`,
			);
		} else if (size === 0 && wasSize !== 0) {
			changes.set(path, `now empty (was ${formatBytes(wasSize ?? 0)})`);
		} else {
			changes.set(
				path,
				`modified (${formatBytes(wasSize ?? 0)} → ${formatBytes(size)})`,
			);
		}
	}
	return changes;
}

/** Sizes in `commit` of `paths`, from `git ls-tree -l -z` output. */
export function parseLsTreeSizes(output: string): Map<string, number> {
	const sizes = new Map<string, number>();
	for (const entry of output.split("\0")) {
		const match = /^\S+ blob \S+\s+(\d+)\t(.+)$/.exec(entry);
		if (match) {
			sizes.set(match[2], Number(match[1]));
		}
	}
	return sizes;
}

async function committedSizesOf(
	root: string,
	commit: string,
	paths: string[],
): Promise<Map<string, number>> {
	if (paths.length === 0) {
		return new Map();
	}
	const output = await git(root, [
		"ls-tree",
		"-l",
		"-z",
		commit,
		"--",
		...paths.slice(0, MAX_LISTED_FILES),
	]).catch(() => "");
	return parseLsTreeSizes(output);
}

export function formatRunReviewRequest(changes: Map<string, string>): string {
	const lines = [...changes].map(([path, change]) => `- ${path}: ${change}`);
	const listed = lines.slice(0, MAX_LISTED_FILES);
	if (lines.length > listed.length) {
		listed.push(`- and ${lines.length - listed.length} more`);
	}
	return [
		"[SYSTEM] Before you give your final report, review the whole run. Files changed since this request started:",
		...listed,
		"Check each one against the request: read its diff (git diff, or the file itself), make sure nothing was emptied, deleted or reverted by mistake, and remove leftovers such as debug output, scratch files and commented-out code. If you have not run the checks that show the change works, run them now. Then give your final report: what changed, what you verified and how, and what is left unverified or unresolved.",
	].join("\n");
}

/** Edit tools report a failed write as `{ success: false }`, not as an error. */
function succeeded(result: AgentAfterToolContext["result"]): boolean {
	if (result.isError) {
		return false;
	}
	const outputs = Array.isArray(result.output)
		? result.output
		: [result.output];
	return outputs.some(
		(output) =>
			output === null ||
			typeof output !== "object" ||
			(output as { success?: unknown }).success !== false,
	);
}

export interface RunReview {
	extension: AgentExtension;
	/** The review request, once per run, when files changed. */
	completionGuard: () => Promise<string | undefined>;
}

export function createRunReview(options: { cwd: string }): RunReview {
	let root: Promise<string | undefined> | undefined;
	let runStart: WorkingTreeSnapshot | undefined;
	let edited = new Set<string>();
	let reviewed = false;

	const beforeRun = async (): Promise<AgentRunStartResult | undefined> => {
		reviewed = false;
		edited = new Set();
		root ??= findRepositoryRoot(options.cwd);
		const dir = await root;
		runStart = dir ? await snapshotWorkingTree(dir) : undefined;
		return undefined;
	};

	const afterTool = (context: AgentAfterToolContext): undefined => {
		if (succeeded(context.result)) {
			for (const path of editedPaths(context.tool.name, context.input)) {
				edited.add(resolve(options.cwd, path));
			}
		}
		return undefined;
	};

	const completionGuard = async (): Promise<string | undefined> => {
		if (reviewed) {
			return undefined;
		}
		const dir = await root;
		const changes = new Map<string, string>();
		if (dir && runStart) {
			const now = await snapshotWorkingTree(dir, runStart.changed.keys());
			if (now) {
				const cleanAtStart = [...now.changed]
					.filter(
						([path, file]) =>
							!runStart?.changed.has(path) && !file.untracked && !file.added,
					)
					.map(([path]) => path);
				const committedSizes = runStart.head
					? await committedSizesOf(dir, runStart.head, cleanAtStart)
					: new Map<string, number>();
				for (const [path, change] of describeChanges(
					runStart,
					now,
					committedSizes,
				)) {
					changes.set(path, change);
				}
				if (now.head && runStart.head !== now.head) {
					const committed = await git(
						dir,
						runStart.head
							? ["diff", "--name-only", runStart.head, now.head]
							: // The run made the repository's first commit.
								["ls-tree", "-r", "--name-only", now.head],
					).catch(() => "");
					for (const path of committed.split("\n").filter(Boolean)) {
						if (!changes.has(path)) {
							changes.set(path, "committed");
						}
					}
				}
			}
		}
		for (const absolute of edited) {
			const path = dir ? relative(dir, absolute) : absolute;
			const display =
				path.startsWith("..") || isAbsolute(path) ? absolute : path;
			if (!changes.has(display)) {
				changes.set(display, "edited");
			}
		}
		if (changes.size === 0) {
			return undefined;
		}
		reviewed = true;
		return formatRunReviewRequest(changes);
	};

	return {
		extension: {
			name: RUN_REVIEW_EXTENSION_NAME,
			manifest: { capabilities: ["hooks"] },
			hooks: { beforeRun, afterTool },
		},
		completionGuard,
	};
}
