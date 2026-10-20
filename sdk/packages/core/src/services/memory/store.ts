import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveClineDataDir } from "@cline/shared/storage";
import YAML from "yaml";
import { splitFrontmatter } from "../../cron/specs/cron-spec-parser";
import { git } from "../../extensions/tools/uncommitted-work-check";

export type MemoryScope = "project" | "user";

export const MEMORY_SCOPES: readonly MemoryScope[] = ["project", "user"];
export const MEMORY_INDEX_FILE = "MEMORY.md";
export const PROJECT_INFO_FILE = "project.json";
export const MAX_MEMORIES_PER_SCOPE = 50;
const MAX_SLUG_LENGTH = 64;

export interface MemoryLocation {
	userDir: string;
	projectDir: string;
	/** The git common dir, or the workspace folder outside git. */
	projectKey: string;
}

export interface MemoryEntry {
	scope: MemoryScope;
	slug: string;
	name: string;
	description: string;
	content: string;
	updated?: string;
}

export interface MemoryInput {
	name: string;
	description: string;
	content: string;
}

export type MemoryWriteMode = "save" | "update";

export type MemoryWriteResult =
	| { ok: true; entry: MemoryEntry; created: boolean }
	| { ok: false; error: string };

function realpathOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * Every worktree of a repository resolves to the same key. A repository at
 * the home folder (dotfiles) only counts for the home folder itself.
 */
export async function resolveProjectMemoryKey(
	workspaceRoot: string,
	homeDir: string = homedir(),
): Promise<string> {
	const root = realpathOr(resolve(workspaceRoot));
	try {
		const [topLevel, commonDir] = (
			await git(root, ["rev-parse", "--show-toplevel", "--git-common-dir"])
		)
			.split(/\r?\n/)
			.map((line) => line.trim());
		const home = realpathOr(homeDir);
		if (
			topLevel &&
			commonDir &&
			(realpathOr(topLevel) !== home || root === home)
		) {
			return realpathOr(resolve(root, commonDir));
		}
	} catch {}
	return root;
}

export async function resolveMemoryLocation(
	workspaceRoot: string,
	dataDir: string = resolveClineDataDir(),
): Promise<MemoryLocation> {
	const projectKey = await resolveProjectMemoryKey(workspaceRoot);
	const hash = createHash("sha256").update(projectKey).digest("hex");
	return {
		userDir: join(dataDir, "memory"),
		projectDir: join(dataDir, "projects", hash, "memory"),
		projectKey,
	};
}

/** File-safe name for a memory, or undefined when nothing usable is left. */
export function memorySlug(name: string): string | undefined {
	const slug = name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, MAX_SLUG_LENGTH)
		.replace(/^-+|-+$/g, "");
	// "memory.md" is the index on case-insensitive file systems.
	return slug && slug !== "memory" ? slug : undefined;
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function writeFileAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temp, content, "utf8");
	renameSync(temp, path);
}

function parseMemoryFile(
	scope: MemoryScope,
	slug: string,
	raw: string,
): MemoryEntry {
	const { frontmatter, body } = splitFrontmatter(raw);
	let data: Record<string, unknown> = {};
	if (frontmatter !== undefined) {
		try {
			const parsed = YAML.parse(frontmatter);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				data = parsed as Record<string, unknown>;
			}
		} catch {}
	}
	const text = (key: string) =>
		typeof data[key] === "string" ? singleLine(data[key] as string) : "";
	const updated = data.updated;
	return {
		scope,
		slug,
		name: text("name") || slug,
		description: text("description"),
		content: body.trim(),
		updated:
			typeof updated === "string"
				? updated
				: updated instanceof Date
					? updated.toISOString()
					: undefined,
	};
}

function formatMemoryFile(entry: MemoryEntry): string {
	const frontmatter = YAML.stringify({
		name: entry.name,
		description: entry.description,
		scope: entry.scope,
		updated: entry.updated,
	}).trimEnd();
	return `---\n${frontmatter}\n---\n\n${entry.content.trim()}\n`;
}

export function formatIndexLine(
	entry: Pick<MemoryEntry, "name" | "slug" | "description">,
): string {
	const description = entry.description ? ` — ${entry.description}` : "";
	return `- [${entry.name}](${entry.slug}.md)${description}`;
}

/**
 * One markdown file per memory plus a generated `MEMORY.md` index. Writers
 * in other processes can race; each write rebuilds the index from the files,
 * so the last writer's index wins and the next write repairs it.
 */
export class MemoryStore {
	constructor(readonly location: MemoryLocation) {}

	dir(scope: MemoryScope): string {
		return scope === "user" ? this.location.userDir : this.location.projectDir;
	}

	readIndex(scope: MemoryScope): string {
		try {
			return readFileSync(join(this.dir(scope), MEMORY_INDEX_FILE), "utf8");
		} catch {
			return "";
		}
	}

	list(scope: MemoryScope): MemoryEntry[] {
		let files: string[];
		try {
			files = readdirSync(this.dir(scope));
		} catch {
			return [];
		}
		const entries: MemoryEntry[] = [];
		for (const file of files) {
			if (!file.endsWith(".md") || file === MEMORY_INDEX_FILE) continue;
			const slug = file.slice(0, -3);
			if (memorySlug(slug) !== slug) continue;
			try {
				const raw = readFileSync(join(this.dir(scope), file), "utf8");
				entries.push(parseMemoryFile(scope, slug, raw));
			} catch {}
		}
		return entries.sort((a, b) => a.name.localeCompare(b.name));
	}

	get(scope: MemoryScope, name: string): MemoryEntry | undefined {
		const slug = memorySlug(name);
		if (!slug) return undefined;
		try {
			const raw = readFileSync(join(this.dir(scope), `${slug}.md`), "utf8");
			return parseMemoryFile(scope, slug, raw);
		} catch {
			return undefined;
		}
	}

	write(
		scope: MemoryScope,
		input: MemoryInput,
		mode: MemoryWriteMode,
	): MemoryWriteResult {
		const slug = memorySlug(input.name);
		if (!slug) {
			return {
				ok: false,
				error: `"${input.name}" is not a usable memory name. Use a few words of letters and digits.`,
			};
		}
		const name = singleLine(input.name);
		const description = singleLine(input.description);
		const content = input.content.trim();
		if (!description || !content) {
			return { ok: false, error: "A memory needs a description and content." };
		}
		const dir = this.dir(scope);
		const path = join(dir, `${slug}.md`);
		const exists = existsSync(path);
		if (exists && mode === "save") {
			return {
				ok: false,
				error: `A ${scope} memory named "${slug}" already exists. Use update to change it.`,
			};
		}
		if (!exists && mode === "update") {
			return { ok: false, error: `No ${scope} memory named "${slug}".` };
		}
		if (!exists && this.list(scope).length >= MAX_MEMORIES_PER_SCOPE) {
			return {
				ok: false,
				error: `The ${scope} memory is full (${MAX_MEMORIES_PER_SCOPE} memories). Update or delete an existing memory instead of adding one.`,
			};
		}
		if (scope === "project") {
			this.writeProjectInfo();
		}
		const entry: MemoryEntry = {
			scope,
			slug,
			name,
			description,
			content,
			updated: new Date().toISOString(),
		};
		writeFileAtomic(path, formatMemoryFile(entry));
		this.rebuildIndex(scope);
		return { ok: true, entry, created: !exists };
	}

	delete(
		scope: MemoryScope,
		name: string,
	): { ok: true; slug: string } | { ok: false; error: string } {
		const slug = memorySlug(name);
		const path = slug ? join(this.dir(scope), `${slug}.md`) : undefined;
		if (!slug || !path || !existsSync(path)) {
			return { ok: false, error: `No ${scope} memory named "${name}".` };
		}
		rmSync(path, { force: true });
		this.rebuildIndex(scope);
		return { ok: true, slug };
	}

	private rebuildIndex(scope: MemoryScope): void {
		const lines = this.list(scope).map(formatIndexLine);
		writeFileAtomic(
			join(this.dir(scope), MEMORY_INDEX_FILE),
			lines.length > 0 ? `${lines.join("\n")}\n` : "",
		);
	}

	private writeProjectInfo(): void {
		const path = join(this.location.projectDir, "..", PROJECT_INFO_FILE);
		if (existsSync(path)) return;
		writeFileAtomic(
			path,
			`${JSON.stringify({ key: this.location.projectKey }, null, 2)}\n`,
		);
	}
}
