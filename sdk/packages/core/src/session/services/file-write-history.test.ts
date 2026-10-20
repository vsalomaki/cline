import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplyPatchExecutor } from "../../extensions/tools/executors/apply-patch";
import { createEditorExecutor } from "../../extensions/tools/executors/editor";
import { FileReadLedger } from "./file-read-ledger";
import { FileWriteHistory } from "./file-write-history";

describe("FileWriteHistory", () => {
	let dir: string;
	let filePath: string;
	let history: FileWriteHistory;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-write-history-"));
		filePath = path.join(dir, "a.txt");
		history = new FileWriteHistory();
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function write(content: string): Promise<number | undefined> {
		await history.beforeWrite(filePath);
		await fs.writeFile(filePath, content);
		return history.afterWrite(filePath);
	}

	it("reports how many edits ago an earlier state was", async () => {
		expect(await write("a")).toBeUndefined();
		expect(await write("b")).toBeUndefined();
		expect(await write("c")).toBeUndefined();
		expect(await write("a")).toBe(2);
		expect(await write("c")).toBe(1);
	});

	it("ignores a write that repeats the current content", async () => {
		await write("a");
		await write("b");
		expect(await write("b")).toBeUndefined();
		expect(await write("a")).toBe(1);
	});

	it("detects a return to the content before the first write", async () => {
		await fs.writeFile(filePath, "original");
		expect(await write("changed")).toBeUndefined();
		expect(await write("original")).toBe(1);
	});

	it("keeps a bounded number of states per file", async () => {
		for (let i = 0; i <= 20; i++) {
			await write(`v${i}`);
		}
		expect(await write("v1")).toBe(19);
		expect(await write("v0")).toBeUndefined();
	});

	it("forgets a deleted file and everything when cleared", async () => {
		await write("a");
		await write("b");
		await fs.rm(filePath);
		expect(await history.afterWrite(filePath)).toBeUndefined();
		expect(await write("a")).toBeUndefined();

		await write("b");
		history.clear();
		expect(await write("a")).toBeUndefined();
	});

	it("treats a symlink and its target as one file", async () => {
		const linkPath = path.join(dir, "link.txt");
		await fs.writeFile(filePath, "a");
		await fs.symlink(filePath, linkPath);

		await history.beforeWrite(linkPath);
		await fs.writeFile(linkPath, "b");
		expect(await history.afterWrite(linkPath)).toBeUndefined();
		expect(await write("a")).toBe(1);
	});

	it("is not cleared with the read ledger", async () => {
		const ledger = new FileReadLedger();
		await write("a");
		await ledger.recordCurrent(filePath);
		await write("b");
		ledger.clear();
		expect(await write("a")).toBe(1);
	});
});

describe("FileWriteHistory with the file tools", () => {
	let dir: string;
	let context: AgentToolContext;
	const edit = createEditorExecutor();
	const patch = createApplyPatchExecutor();

	beforeEach(async () => {
		dir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), "file-write-history-tools-")),
		);
		await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\n");
		await fs.writeFile(path.join(dir, "b.txt"), "uno\ndos\n");
		context = {
			agentId: "agent",
			iteration: 1,
			metadata: { fileWriteHistory: new FileWriteHistory() },
		} as AgentToolContext;
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	const replace = (oldText: string, newText: string, ctx = context) =>
		edit({ path: "a.txt", old_text: oldText, new_text: newText }, dir, ctx);

	const patchBoth = (from: [string, string], to: [string, string]) =>
		patch(
			{
				input: [
					"*** Begin Patch",
					"*** Update File: a.txt",
					"@@",
					" one",
					`-${from[0]}`,
					`+${to[0]}`,
					"*** Update File: b.txt",
					"@@",
					" uno",
					`-${from[1]}`,
					`+${to[1]}`,
					"*** End Patch",
				].join("\n"),
			},
			dir,
			context,
		);

	it("notes when an editor call restores an earlier state", async () => {
		expect(await replace("two", "TWO")).not.toContain("Note:");
		expect(await replace("TWO", "2")).not.toContain("Note:");

		const result = await replace("2", "two");

		expect(result).toContain(
			`Note: this edit restores ${path.join(dir, "a.txt")} to its state from 2 edits ago, undoing the changes made since then.`,
		);
		expect(result.match(/Note:/g)).toHaveLength(1);
	});

	it("adds no note when the setting is off", async () => {
		const off = { ...context, metadata: {} } as AgentToolContext;
		await replace("two", "TWO", off);

		expect(await replace("TWO", "two", off)).not.toContain("Note:");
	});

	it("does not note a file that was created and then deleted", async () => {
		await edit({ path: "c.txt", new_text: "new" }, dir, context);
		const result = await patch(
			{ input: "*** Begin Patch\n*** Delete File: c.txt\n*** End Patch" },
			dir,
			context,
		);

		expect(result).not.toContain("Note:");
		expect(
			await edit({ path: "c.txt", new_text: "new" }, dir, context),
		).not.toContain("Note:");
	});

	it("lists every file an apply_patch call restores in one note", async () => {
		expect(await patchBoth(["two", "dos"], ["TWO", "DOS"])).not.toContain(
			"Note:",
		);

		const result = await patchBoth(["TWO", "DOS"], ["two", "dos"]);

		expect(result.match(/Note:/g)).toHaveLength(1);
		expect(result).toContain(
			`- ${path.join(dir, "a.txt")} (its state from 1 edit ago)`,
		);
		expect(result).toContain(
			`- ${path.join(dir, "b.txt")} (its state from 1 edit ago)`,
		);
	});
});
