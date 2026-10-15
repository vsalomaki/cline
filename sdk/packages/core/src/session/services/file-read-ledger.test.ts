import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplyPatchExecutor } from "../../extensions/tools/executors/apply-patch";
import { createEditorExecutor } from "../../extensions/tools/executors/editor";
import { createFileReadExecutor } from "../../extensions/tools/executors/file-read";
import { FileReadLedger } from "./file-read-ledger";

describe("FileReadLedger with the file tools", () => {
	let dir: string;
	let filePath: string;
	let context: AgentToolContext;
	let ledger: FileReadLedger;
	const read = createFileReadExecutor();
	const edit = createEditorExecutor();
	const patch = createApplyPatchExecutor();

	beforeEach(async () => {
		dir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), "file-read-ledger-")),
		);
		filePath = path.join(dir, "a.txt");
		await fs.writeFile(filePath, "one\ntwo\n");
		ledger = new FileReadLedger();
		context = {
			agentId: "agent",
			iteration: 1,
			metadata: { fileReadLedger: ledger },
		} as AgentToolContext;
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	const replaceTwo = (newText = "TWO") =>
		edit({ path: "a.txt", old_text: "two", new_text: newText }, dir, context);

	it("refuses to edit a file that was not read", async () => {
		await expect(replaceTwo()).rejects.toThrow(
			"a.txt has not been read in this session",
		);
		await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("one\ntwo\n");
	});

	it("allows edits after a read, including a ranged read, and after its own edits", async () => {
		await read({ path: filePath, start_line: 1, end_line: 1 }, context);

		await replaceTwo();
		await edit({ path: "a.txt", old_text: "TWO", new_text: "2" }, dir, context);

		await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("one\n2\n");
	});

	it("refuses an edit when the file changed since it was read", async () => {
		await read({ path: filePath }, context);
		await fs.writeFile(filePath, "one\ntwo\nthree\n");

		await expect(replaceTwo()).rejects.toThrow(
			"a.txt changed since it was last read",
		);
	});

	it("does not guard new files or sessions without a ledger", async () => {
		await edit({ path: "b.txt", new_text: "new" }, dir, context);
		await edit(
			{ path: "b.txt", old_text: "new", new_text: "newer" },
			dir,
			context,
		);
		await edit(
			{ path: "a.txt", old_text: "two", new_text: "TWO" },
			dir,
			{} as AgentToolContext,
		);

		await expect(fs.readFile(path.join(dir, "b.txt"), "utf-8")).resolves.toBe(
			"newer",
		);
	});

	it("refuses a patch that updates an unread file before writing anything", async () => {
		const input = [
			"*** Begin Patch",
			"*** Add File: c.txt",
			"+created",
			"*** Update File: a.txt",
			"@@",
			" one",
			"-two",
			"+TWO",
			"*** End Patch",
		].join("\n");

		await expect(patch({ input }, dir, context)).rejects.toThrow(
			"a.txt has not been read in this session",
		);
		await expect(fs.access(path.join(dir, "c.txt"))).rejects.toThrow();

		await read({ path: filePath }, context);
		await patch({ input }, dir, context);
		await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("one\nTWO\n");
	});

	it("forgets every read when cleared", async () => {
		await read({ path: filePath }, context);
		ledger.clear();

		await expect(replaceTwo()).rejects.toThrow("has not been read");
	});
});
