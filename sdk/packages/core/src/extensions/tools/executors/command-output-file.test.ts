import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createCommandOutputFile,
	savedCommandOutputNotice,
} from "./command-output-file";
import { truncateCommandOutput } from "./output-limits";

describe("createCommandOutputFile", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "cline-output-file-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("saves nothing while the output fits", async () => {
		const file = createCommandOutputFile({ maxChars: 10, directory });
		file.append("0123456789");

		expect(file.finish()).toBeUndefined();
		expect(await readdir(directory)).toEqual([]);
	});

	it("writes everything from the first character once the output outgrows the limit", async () => {
		const file = createCommandOutputFile({ maxChars: 10, directory });
		file.append("0123456789");
		file.append("abc");
		file.append("def");

		const saved = file.finish();
		expect(saved).toMatchObject({ totalChars: 16, capped: false });
		expect(await readFile(saved?.path as string, "utf8")).toBe(
			"0123456789abcdef",
		);
	});

	it("opens early on spill() for a caller about to drop output", async () => {
		const file = createCommandOutputFile({ maxChars: 1000, directory });
		file.append("first\n");
		file.spill();
		file.append("second\n");

		const saved = file.finish();
		expect(await readFile(saved?.path as string, "utf8")).toBe(
			"first\nsecond\n",
		);
	});

	it("stops at the byte cap and says so in the file and the notice", async () => {
		const file = createCommandOutputFile({
			maxChars: 10,
			directory,
			maxBytes: 1024,
		});
		file.append("x".repeat(1000));
		file.append("y".repeat(1000));

		const saved = file.finish();
		expect(saved).toMatchObject({ totalChars: 2000, capped: true });
		const text = await readFile(saved?.path as string, "utf8");
		expect(text.startsWith(`${"x".repeat(1000)}${"y".repeat(24)}\n`)).toBe(
			true,
		);
		expect(text).toContain(
			"[Output exceeded the 1 KB file cap; the rest was not saved]",
		);
		expect(savedCommandOutputNotice(saved as never)).toContain(
			"The first 1 KB of output is saved to",
		);
	});

	it("names the session, agent and tool call in the directory", () => {
		const file = createCommandOutputFile({
			maxChars: 1,
			directory,
			owner: {
				sessionId: "sess_1730000000_ab12cd34",
				agentId: "agent_0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
				toolCallId: "toolu_01AbCdEfGhIjKlMn/../x",
			},
		});
		file.append("abc");

		const path = file.finish()?.path as string;
		expect(path).toMatch(
			new RegExp(
				`^${directory}/cline-command-sab12cd34-ac3d2e1f0-cdEfGhIjKlMnx-[A-Za-z0-9]{6}/output\\.log$`,
			),
		);
	});

	it("gives concurrent commands of the same owner separate files", async () => {
		const owner = { sessionId: "s1", agentId: "lead", toolCallId: "call-1" };
		const first = createCommandOutputFile({ maxChars: 1, directory, owner });
		const second = createCommandOutputFile({ maxChars: 1, directory, owner });
		first.append("first");
		second.append("second");

		const firstPath = first.finish()?.path as string;
		const secondPath = second.finish()?.path as string;
		expect(firstPath).not.toBe(secondPath);
		expect(await readFile(firstPath, "utf8")).toBe("first");
		expect(await readFile(secondPath, "utf8")).toBe("second");
	});

	it("leaves out ids the owner lacks", () => {
		const file = createCommandOutputFile({
			maxChars: 1,
			directory,
			owner: { agentId: "agent-1" },
		});
		file.append("abc");

		expect(file.finish()?.path).toMatch(
			/\/cline-command-aagent1-[A-Za-z0-9]{6}\/output\.log$/,
		);
	});

	it("returns the same result from repeated finish() calls", () => {
		const file = createCommandOutputFile({ maxChars: 1, directory });
		file.append("abc");

		const saved = file.finish();
		expect(saved).toBeDefined();
		expect(file.finish()).toBe(saved);
	});

	it("falls back quietly when the file cannot be created", () => {
		const file = createCommandOutputFile({
			maxChars: 1,
			directory: join(directory, "missing"),
		});
		file.append("abc");

		expect(file.finish()).toBeUndefined();
	});

	it("puts the path and lifetime in the truncation notice", () => {
		const output = truncateCommandOutput("x".repeat(100), {
			maxChars: 20,
			savedOutput: {
				path: "/tmp/cline-command-abc/output.log",
				totalChars: 100,
				capped: false,
				maxBytes: 10 * 1024 * 1024,
				retentionMs: 24 * 60 * 60 * 1000,
			},
		});

		expect(output).toBe(
			`${"x".repeat(10)}\n` +
				"[... output truncated: 100 chars total. The full output is saved to /tmp/cline-command-abc/output.log for 24 hours; read line ranges from it with read_files or grep it instead of re-running the command ...]\n" +
				"x".repeat(10),
		);
	});
});
