import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentAfterToolContext,
	AgentRunLifecycleContext,
	AgentTool,
} from "@cline/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createRunReview, editedPaths, parseLsTreeSizes } from "./run-review";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "run-review-"));
	dirs.push(dir);
	return dir;
}

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
	});

function makeRepo(): string {
	const dir = tempDir();
	git(dir, "init", "-q");
	writeFileSync(join(dir, "a.txt"), "committed\n");
	writeFileSync(join(dir, "big.txt"), "x".repeat(1000));
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "init");
	return dir;
}

function startRun(review: ReturnType<typeof createRunReview>) {
	return review.extension.hooks?.beforeRun?.({} as AgentRunLifecycleContext);
}

function editorCall(
	review: ReturnType<typeof createRunReview>,
	path: string,
	result: { output: unknown; isError?: boolean } = {
		output: { query: `edit:${path}`, result: "Edited", success: true },
	},
) {
	return review.extension.hooks?.afterTool?.({
		tool: { name: "editor" } as AgentTool,
		input: { path, new_text: "x" },
		result,
	} as unknown as AgentAfterToolContext);
}

describe("createRunReview", () => {
	it("asks once per run for a review that lists what changed", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "a.txt"), "edited before the run\n");
		const review = createRunReview({ cwd: repo });
		await startRun(review);

		writeFileSync(join(repo, "a.txt"), "edited during the run, longer\n");
		writeFileSync(join(repo, "big.txt"), "");
		writeFileSync(join(repo, "new.ts"), "export {};\n");

		const request = await review.completionGuard();
		expect(request).toContain("review the whole run");
		expect(request).toContain("- a.txt: modified (22 bytes → 30 bytes)");
		expect(request).toContain("- big.txt: now empty (was 1,000 bytes)");
		expect(request).toContain("- new.ts: new (11 bytes)");
		expect(await review.completionGuard()).toBeUndefined();

		await startRun(review);
		expect(await review.completionGuard()).toBeUndefined();
	});

	it("does not ask when nothing changed", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "a.txt"), "edited before the run\n");
		const review = createRunReview({ cwd: repo });
		await startRun(review);

		expect(await review.completionGuard()).toBeUndefined();
	});

	it("reports discarded changes and commits made during the run", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "a.txt"), "uncommitted work\n");
		const review = createRunReview({ cwd: repo });
		await startRun(review);

		git(repo, "checkout", "--", "a.txt");
		const request = await review.completionGuard();
		expect(request).toContain(
			"- a.txt: back to the committed version; its uncommitted changes are gone",
		);

		await startRun(review);
		writeFileSync(join(repo, "big.txt"), "changed\n");
		git(repo, "commit", "-qam", "change");
		expect(await review.completionGuard()).toContain("- big.txt: committed");
	});

	it("reports the files of a first commit made during the run", async () => {
		const repo = tempDir();
		git(repo, "init", "-q");
		const review = createRunReview({ cwd: repo });
		await startRun(review);

		writeFileSync(join(repo, "main.ts"), "export {};\n");
		git(repo, "add", "main.ts");
		git(repo, "commit", "-qm", "init");

		expect(await review.completionGuard()).toContain("- main.ts: committed");
	});

	it("lists files the edit tools wrote outside a git repository", async () => {
		const dir = tempDir();
		const review = createRunReview({ cwd: dir });
		await startRun(review);

		await editorCall(review, "notes.md");
		await editorCall(review, join(dir, "thrown.md"), {
			output: { error: "timed out" },
			isError: true,
		});
		await editorCall(review, join(dir, "refused.md"), {
			output: { query: "edit:refused.md", error: "not read", success: false },
		});

		const request = await review.completionGuard();
		expect(request).toContain(`- ${join(dir, "notes.md")}: edited`);
		expect(request).not.toContain("thrown.md");
		expect(request).not.toContain("refused.md");
	});
});

describe("parseLsTreeSizes", () => {
	it("reads blob sizes and skips other entries", () => {
		const output = [
			"100644 blob 1111111111111111111111111111111111111111     1000\tsrc/a file.ts",
			"040000 tree 2222222222222222222222222222222222222222       -\tsrc",
			"",
		].join("\0");
		expect(parseLsTreeSizes(output)).toEqual(
			new Map([["src/a file.ts", 1000]]),
		);
	});
});

describe("editedPaths", () => {
	it("reads editor and apply_patch targets", () => {
		expect(editedPaths("editor", { path: "/repo/a.ts" })).toEqual([
			"/repo/a.ts",
		]);
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/a.ts",
			"*** Move to: src/b.ts",
			"@@",
			"*** Add File: src/c.ts",
			"*** Delete File: src/d.ts",
			"*** End Patch",
		].join("\n");
		expect(editedPaths("apply_patch", { input: patch })).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/d.ts",
		]);
		expect(editedPaths("apply_patch", patch)).toHaveLength(4);
		expect(editedPaths("read_files", { path: "/repo/a.ts" })).toEqual([]);
	});
});
