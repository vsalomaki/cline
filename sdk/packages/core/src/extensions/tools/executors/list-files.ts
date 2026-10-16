/**
 * Directory listing executor for the list_files tool.
 *
 * Lists with Node's filesystem API rather than a shell, so it behaves the same
 * under bash, zsh and PowerShell and needs no command approval.
 */

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ListFilesExecutor } from "../types";
import { globToRegExp } from "./glob-match";
import { MAX_SEARCH_OUTPUT_CHARS } from "./output-limits";

export interface ListFilesExecutorOptions {
	/** @default 200 */
	defaultLimit?: number;
	/** @default 1000 */
	maxLimit?: number;
	/** Depth used when recursive is set without max_depth. @default 3 */
	defaultDepth?: number;
	/** @default 10 */
	maxDepth?: number;
	/** Directories shown but never expanded in a recursive listing. */
	excludeDirs?: readonly string[];
	/** @default MAX_SEARCH_OUTPUT_CHARS */
	maxOutputChars?: number;
}

export const DEFAULT_LIST_EXCLUDE_DIRS = [
	".git",
	"node_modules",
	"__pycache__",
	".venv",
	"venv",
	".next",
	".turbo",
	".cache",
	"coverage",
];

interface Entry {
	/** Path relative to the listed root, with `/` separators. */
	relative: string;
	isDirectory: boolean;
	/** Shown, but its contents are not listed. */
	collapsed: boolean;
}

export function createListFilesExecutor(
	options: ListFilesExecutorOptions = {},
): ListFilesExecutor {
	const {
		defaultLimit = 200,
		maxLimit = 1000,
		defaultDepth = 3,
		maxDepth = 10,
		excludeDirs = DEFAULT_LIST_EXCLUDE_DIRS,
		maxOutputChars = MAX_SEARCH_OUTPUT_CHARS,
	} = options;
	const excluded = new Set(excludeDirs);

	return async (request, cwd, context) => {
		const root = path.resolve(cwd, request.path);
		const pattern = request.pattern?.trim() || undefined;
		const recursive =
			pattern !== undefined ||
			request.recursive === true ||
			request.max_depth !== undefined;
		const depth = recursive
			? clamp(
					request.max_depth ?? (pattern ? maxDepth : defaultDepth),
					1,
					maxDepth,
				)
			: 1;
		const limit = clamp(request.limit ?? defaultLimit, 1, maxLimit);

		const stat = await fs.stat(root).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				throw new Error(`Directory not found: ${root}`);
			}
			throw error;
		});
		if (!stat.isDirectory()) {
			throw new Error(
				`Path is a file, not a directory: ${root}. Use read_files to read it.`,
			);
		}
		if (recursive && isRestrictedRoot(root)) {
			throw new Error(
				`Refusing to list ${root} recursively. List a project directory instead, or omit recursive.`,
			);
		}

		const { entries, truncated, unreadable } = await collectEntries({
			root,
			depth,
			limit,
			recursive,
			excluded,
			matches: pattern ? globToRegExp(pattern) : undefined,
			signal: context.signal,
		});
		if (pattern) {
			return formatMatches(root, pattern, entries, {
				truncated,
				limit,
				maxOutputChars,
				unreadable,
			});
		}
		return formatListing(root, entries, {
			truncated,
			limit,
			maxOutputChars,
			unreadable,
		});
	};
}

/**
 * Lists one directory level, for read_files calls that name a directory.
 * Never recurses, so it needs no ignore handling.
 */
export async function listDirectoryTopLevel(
	directory: string,
	limit = 200,
	maxOutputChars = MAX_SEARCH_OUTPUT_CHARS,
): Promise<string> {
	const { entries, truncated, unreadable } = await collectEntries({
		root: directory,
		depth: 1,
		limit,
		recursive: false,
		excluded: new Set(),
	});
	return formatListing(directory, entries, {
		truncated,
		limit,
		maxOutputChars,
		unreadable,
	});
}

async function collectEntries(input: {
	root: string;
	depth: number;
	limit: number;
	recursive: boolean;
	excluded: ReadonlySet<string>;
	/** Keeps only files whose relative path matches; directories are still walked. */
	matches?: RegExp;
	signal?: AbortSignal;
}): Promise<{ entries: Entry[]; truncated: boolean; unreadable: string[] }> {
	const entries: Entry[] = [];
	const unreadable: string[] = [];
	// Breadth-first, so a truncated listing still covers the shallow levels.
	let level: string[] = [""];
	for (let currentDepth = 1; currentDepth <= input.depth; currentDepth++) {
		const next: string[] = [];
		let index = 0;
		while (index < level.length) {
			if (input.signal?.aborted) {
				throw new Error("Listing aborted");
			}
			// Read directories only until the batch could fill the remaining
			// budget, so a wide tree costs roughly `limit` entries of work.
			const remaining = input.limit - entries.length;
			const batch: Entry[] = [];
			while (index < level.length && batch.length <= remaining) {
				const relativeDir = level[index++];
				const dirents = await readDirectory(
					path.join(input.root, relativeDir),
					relativeDir === "",
				);
				if (dirents === undefined) {
					unreadable.push(relativeDir);
					continue;
				}
				for (const dirent of dirents) {
					const isDirectory = dirent.isDirectory();
					batch.push({
						relative: relativeDir
							? `${relativeDir}/${dirent.name}`
							: dirent.name,
						isDirectory,
						collapsed:
							isDirectory &&
							(input.excluded.has(dirent.name) || currentDepth === input.depth),
					});
				}
			}
			const ignored = input.recursive
				? await gitIgnored(
						input.root,
						batch.map((entry) =>
							entry.isDirectory ? `${entry.relative}/` : entry.relative,
						),
					)
				: new Set<string>();
			for (const entry of batch) {
				if (ignored.has(entry.relative)) {
					continue;
				}
				if (input.matches) {
					if (entry.isDirectory) {
						if (!entry.collapsed) {
							next.push(entry.relative);
						}
						continue;
					}
					if (!input.matches.test(entry.relative)) {
						continue;
					}
				}
				if (entries.length >= input.limit) {
					return { entries, truncated: true, unreadable };
				}
				entries.push(entry);
				if (entry.isDirectory && !entry.collapsed) {
					next.push(entry.relative);
				}
			}
		}
		if (next.length === 0) {
			break;
		}
		level = next;
	}
	return { entries, truncated: false, unreadable };
}

/**
 * Reads one directory's entries, sorted by name. A failure on the listed
 * directory itself is an error; an unreadable subdirectory returns
 * undefined so the listing can say so.
 */
async function readDirectory(
	directory: string,
	isRoot: boolean,
): Promise<Dirent[] | undefined> {
	try {
		const dirents = await fs.readdir(directory, { withFileTypes: true });
		return dirents.sort((a, b) => a.name.localeCompare(b.name));
	} catch (error) {
		if (isRoot) {
			throw error;
		}
		return undefined;
	}
}

/**
 * Asks git which of `relativePaths` are ignored. Outside a work tree, or
 * without git, nothing is treated as ignored.
 */
function gitIgnored(
	root: string,
	relativePaths: string[],
): Promise<Set<string>> {
	if (relativePaths.length === 0) {
		return Promise.resolve(new Set());
	}
	return new Promise((resolve) => {
		const child = execFile(
			"git",
			["-C", root, "check-ignore", "--stdin", "-z"],
			{ maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
			(_error, stdout) => {
				// Exit 1 means nothing matched and 128 means not a repository;
				// both leave stdout empty, so the output alone decides.
				const ignored = new Set<string>();
				for (const item of String(stdout ?? "").split("\0")) {
					if (item) {
						ignored.add(item.replace(/\/$/, ""));
					}
				}
				resolve(ignored);
			},
		);
		child.stdin?.on("error", () => {});
		child.stdin?.end(`${relativePaths.join("\0")}\0`);
	});
}

function formatListing(
	root: string,
	entries: Entry[],
	options: {
		truncated: boolean;
		limit: number;
		maxOutputChars: number;
		unreadable: string[];
	},
): string {
	if (entries.length === 0) {
		return `${root}\nNo files found.`;
	}
	const lines = sortForDisplay(entries).map((entry) =>
		entry.isDirectory ? `${entry.relative}/` : entry.relative,
	);
	let body = lines.join("\n");
	let cutByChars = false;
	if (body.length > options.maxOutputChars) {
		const lastBreak = body.lastIndexOf("\n", options.maxOutputChars);
		body = body.slice(0, lastBreak > 0 ? lastBreak : options.maxOutputChars);
		cutByChars = true;
	}
	const notes: string[] = [];
	if (options.truncated || cutByChars) {
		notes.push(
			`(Truncated at ${options.truncated ? options.limit : body.split("\n").length} entries. List a subdirectory or lower max_depth.)`,
		);
	}
	const collapsed = entries.filter((entry) => entry.collapsed);
	if (
		collapsed.length > 0 &&
		entries.some((entry) => entry.relative.includes("/"))
	) {
		notes.push(
			"(Directories at the depth limit, and dependency or VCS directories, are listed without their contents.)",
		);
	}
	if (options.unreadable.length > 0) {
		notes.push(
			`(Could not read: ${options.unreadable.map((dir) => `${dir}/`).join(", ")})`,
		);
	}
	return [root, body, ...notes].join("\n");
}

function formatMatches(
	root: string,
	pattern: string,
	entries: Entry[],
	options: {
		truncated: boolean;
		limit: number;
		maxOutputChars: number;
		unreadable: string[];
	},
): string {
	if (entries.length === 0) {
		return `${root}\nNo files found matching ${pattern}.`;
	}
	const paths = entries.map((entry) => entry.relative).sort(compareCodePoints);
	let body = paths.join("\n");
	let shown = paths.length;
	if (body.length > options.maxOutputChars) {
		const lastBreak = body.lastIndexOf("\n", options.maxOutputChars);
		body = body.slice(0, lastBreak > 0 ? lastBreak : options.maxOutputChars);
		shown = body.split("\n").length;
	}
	const notes: string[] = [];
	if (options.truncated || shown < paths.length) {
		notes.push(
			`(Showing ${shown} files; more not shown. Narrow the pattern or path${options.truncated ? ", or raise limit" : ""}.)`,
		);
	}
	if (options.unreadable.length > 0) {
		notes.push(
			`(Could not read: ${options.unreadable.map((dir) => `${dir}/`).join(", ")})`,
		);
	}
	return [
		`${root}\nFound ${paths.length} files matching ${pattern}:`,
		body,
		...notes,
	].join("\n");
}

function compareCodePoints(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorts like a tree: each directory is followed by its own contents. */
function sortForDisplay(entries: Entry[]): Entry[] {
	return [...entries].sort((a, b) => {
		const aParts = a.relative.split("/");
		const bParts = b.relative.split("/");
		for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
			if (aParts[i] !== bParts[i]) {
				return aParts[i].localeCompare(bParts[i]);
			}
		}
		return aParts.length - bParts.length;
	});
}

function isRestrictedRoot(root: string): boolean {
	const normalized = path.resolve(root);
	return (
		normalized === path.parse(normalized).root ||
		normalized === path.resolve(os.homedir())
	);
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.min(max, Math.max(min, Math.floor(value)));
}
