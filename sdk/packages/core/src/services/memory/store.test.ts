import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MAX_MEMORIES_PER_SCOPE,
	MemoryStore,
	memorySlug,
	resolveMemoryLocation,
	resolveProjectMemoryKey,
} from "./store";

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "cline-memory-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
	execFileSync("git", ["-C", cwd, ...args], {
		stdio: "ignore",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});
}

function makeStore(): MemoryStore {
	return new MemoryStore({
		userDir: join(root, "data", "memory"),
		projectDir: join(root, "data", "projects", "abc", "memory"),
		projectKey: "/repo/.git",
	});
}

const input = (name: string, description = `About ${name}`) => ({
	name,
	description,
	content: `Body of ${name}`,
});

describe("memorySlug", () => {
	it("keeps names inside the memory folder", () => {
		expect(memorySlug("../../etc/passwd")).toBe("etc-passwd");
		expect(memorySlug("/abs/path")).toBe("abs-path");
		expect(memorySlug("Build Quirk: Bun 1.4")).toBe("build-quirk-bun-1-4");
		expect(memorySlug("..")).toBeUndefined();
		expect(memorySlug("   ")).toBeUndefined();
		expect(memorySlug("MEMORY")).toBeUndefined();
		expect(memorySlug("x".repeat(200))).toHaveLength(64);
	});
});

describe("MemoryStore", () => {
	it("writes one file per memory and an index line for each", () => {
		const store = makeStore();
		expect(store.write("project", input("Build quirk"), "save").ok).toBe(true);
		expect(store.write("project", input("Auth flow"), "save").ok).toBe(true);

		const dir = store.dir("project");
		expect(readdirSync(dir).sort()).toEqual([
			"MEMORY.md",
			"auth-flow.md",
			"build-quirk.md",
		]);
		expect(store.readIndex("project")).toBe(
			"- [Auth flow](auth-flow.md) — About Auth flow\n- [Build quirk](build-quirk.md) — About Build quirk\n",
		);
		const file = readFileSync(join(dir, "build-quirk.md"), "utf8");
		expect(file).toMatch(
			/^---\nname: Build quirk\ndescription: About Build quirk\nscope: project\nupdated: /,
		);
		expect(file).toContain("\n---\n\nBody of Build quirk\n");
		expect(store.get("project", "build quirk")).toMatchObject({
			name: "Build quirk",
			content: "Body of Build quirk",
		});
		expect(
			JSON.parse(
				readFileSync(
					join(root, "data", "projects", "abc", "project.json"),
					"utf8",
				),
			),
		).toEqual({ key: "/repo/.git" });
	});

	it("updates and deletes entries and their index lines", () => {
		const store = makeStore();
		store.write("user", input("Tone"), "save");
		expect(store.write("user", input("Tone"), "save")).toMatchObject({
			ok: false,
		});
		expect(
			store.write("user", input("Tone", "Short answers"), "update"),
		).toMatchObject({ ok: true, created: false });
		expect(store.readIndex("user")).toBe("- [Tone](tone.md) — Short answers\n");
		expect(store.write("user", input("Other"), "update")).toMatchObject({
			ok: false,
		});

		expect(store.delete("user", "tone")).toEqual({ ok: true, slug: "tone" });
		expect(store.readIndex("user")).toBe("");
		expect(store.delete("user", "tone").ok).toBe(false);
		expect(existsSync(join(root, "data", "projects"))).toBe(false);
	});

	it("drops index lines for files removed by hand", () => {
		const store = makeStore();
		store.write("user", input("A"), "save");
		store.write("user", input("B"), "save");
		rmSync(join(store.dir("user"), "a.md"));
		store.write("user", input("C"), "save");
		expect(store.readIndex("user")).not.toContain("(a.md)");
	});

	it("refuses new memories past the cap but still updates", () => {
		const store = makeStore();
		for (let i = 0; i < MAX_MEMORIES_PER_SCOPE; i += 1) {
			expect(store.write("user", input(`m${i}`), "save").ok).toBe(true);
		}
		const refused = store.write("user", input("one more"), "save");
		expect(refused).toMatchObject({ ok: false });
		expect(refused.ok ? "" : refused.error).toMatch(/Update or delete/);
		expect(store.write("user", input("m3", "changed"), "update").ok).toBe(true);
		expect(store.write("project", input("other scope"), "save").ok).toBe(true);
	});

	it("needs a description and content", () => {
		const store = makeStore();
		expect(
			store.write("user", { name: "x", description: " ", content: "y" }, "save")
				.ok,
		).toBe(false);
	});
});

describe("project memory key", () => {
	it("is shared by a repository and its worktrees", async () => {
		const repo = join(root, "repo");
		mkdirSync(repo);
		git(repo, "init", "-q");
		writeFileSync(join(repo, "f"), "x");
		git(repo, "add", "f");
		git(repo, "commit", "-qm", "init");
		const worktree = join(root, "wt");
		git(repo, "worktree", "add", "-q", worktree);
		mkdirSync(join(repo, "sub"));

		const key = await resolveProjectMemoryKey(repo);
		expect(key).toBe(join(repo, ".git"));
		expect(await resolveProjectMemoryKey(worktree)).toBe(key);
		expect(await resolveProjectMemoryKey(join(repo, "sub"))).toBe(key);

		const a = await resolveMemoryLocation(repo, join(root, "data"));
		const b = await resolveMemoryLocation(worktree, join(root, "data"));
		expect(b.projectDir).toBe(a.projectDir);
		expect(a.projectDir).toMatch(/data\/projects\/[0-9a-f]{64}\/memory$/);
		expect(a.userDir).toBe(join(root, "data", "memory"));
	});

	it("ignores a repository at the home folder for folders below it", async () => {
		const home = join(root, "home");
		mkdirSync(join(home, "projects", "plain"), { recursive: true });
		git(home, "init", "-q");
		const plain = join(home, "projects", "plain");
		expect(await resolveProjectMemoryKey(plain, home)).toBe(plain);
		expect(await resolveProjectMemoryKey(home, home)).toBe(join(home, ".git"));
		const nested = join(home, "projects", "repo");
		mkdirSync(nested);
		git(nested, "init", "-q");
		expect(await resolveProjectMemoryKey(nested, home)).toBe(
			join(nested, ".git"),
		);
	});

	it("falls back to the folder outside git", async () => {
		const folder = join(root, "plain");
		mkdirSync(folder);
		expect(await resolveProjectMemoryKey(folder)).toBe(folder);
		const other = join(root, "other");
		mkdirSync(other);
		const a = await resolveMemoryLocation(folder, join(root, "data"));
		const b = await resolveMemoryLocation(other, join(root, "data"));
		expect(a.projectDir).not.toBe(b.projectDir);
	});
});
