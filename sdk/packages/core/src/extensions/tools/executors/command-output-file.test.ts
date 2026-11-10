import { describe, expect, it } from "vitest";
import { MemoryToolOutputStore } from "../../../services/tool-output/store";
import {
	type CommandOutputCaptureOptions,
	createCommandOutputCapture,
	savedCommandOutputNotice,
} from "./command-output-file";
import { truncateCommandOutput } from "./output-limits";

describe("createCommandOutputCapture", () => {
	function capture(
		store: MemoryToolOutputStore | undefined,
		options: Partial<CommandOutputCaptureOptions> & {
			context?: CommandOutputCaptureOptions["context"];
		} = {},
	) {
		return createCommandOutputCapture({
			maxChars: 10,
			summary: "make all",
			context: {
				sessionId: "sess_1",
				agentId: "agent-1",
				toolCallId: "call-1",
				metadata: store ? { toolOutputStore: store } : undefined,
			},
			...options,
		});
	}

	it("stores nothing while the output fits", () => {
		const store = new MemoryToolOutputStore();
		const output = capture(store);
		output.append("0123456789");

		expect(output.finish()).toBeUndefined();
		expect(store.list("sess_1", 10)).toEqual([]);
	});

	it("stores everything from the first character once the output outgrows the limit", () => {
		const store = new MemoryToolOutputStore();
		const output = capture(store);
		output.append("0123456789");
		output.append("abc");
		output.append("def");

		const saved = output.finish();
		expect(saved).toMatchObject({ totalChars: 16, capped: false });
		expect(store.readText("sess_1", saved?.id as string)).toBe(
			"0123456789abcdef",
		);
	});

	it("describes the stored output with the owner, the tool and the command", () => {
		const store = new MemoryToolOutputStore();
		const output = capture(store);
		output.append("x".repeat(20));

		const saved = output.finish();
		expect(store.get("sess_1", saved?.id as string)).toMatchObject({
			sessionId: "sess_1",
			agentId: "agent-1",
			toolCallId: "call-1/command",
			toolName: "run_commands",
			summary: "make all",
			chars: 20,
		});
		expect(store.findByToolCall("sess_1", "call-1/command")?.id).toBe(
			saved?.id,
		);
	});

	it("keys the record by the agent id when the context has no session", () => {
		const store = new MemoryToolOutputStore();
		const output = capture(store, {
			context: {
				agentId: "agent-1",
				metadata: { toolOutputStore: store },
			},
		});
		output.append("x".repeat(20));

		const saved = output.finish();
		expect(store.readText("agent-1", saved?.id as string)).toBe("x".repeat(20));
	});

	it("stores early output on spill() for a caller about to drop output", () => {
		const store = new MemoryToolOutputStore();
		const output = capture(store, { maxChars: 1000 });
		output.append("first\n");
		output.spill();
		output.append("second\n");

		const saved = output.finish();
		expect(store.readText("sess_1", saved?.id as string)).toBe(
			"first\nsecond\n",
		);
	});

	it("stops at the stored-characters cap and says so in the record and the notice", () => {
		const store = new MemoryToolOutputStore();
		const output = capture(store, { maxStoredChars: 1024 });
		output.append("x".repeat(1000));
		output.append("y".repeat(1000));

		const saved = output.finish();
		expect(saved).toMatchObject({
			totalChars: 2000,
			capped: true,
			maxStoredChars: 1024,
		});
		const text = store.readText("sess_1", saved?.id as string) ?? "";
		expect(text.startsWith(`${"x".repeat(1000)}${"y".repeat(24)}\n`)).toBe(
			true,
		);
		expect(text).toContain("[Output exceeded 1 KB; the rest was not stored]");
		expect(savedCommandOutputNotice(saved as never)).toContain(
			`The first 1 KB of output is stored as tool output ${saved?.id}`,
		);
	});

	it("keeps counting output past the cap", () => {
		const store = new MemoryToolOutputStore();
		const output = capture(store, { maxChars: 5, maxStoredChars: 10 });
		output.append("x".repeat(10));
		output.append("y".repeat(10));
		output.append("z");

		expect(output.finish()).toMatchObject({ totalChars: 21, capped: true });
	});

	it("returns the same result from repeated finish() calls and ignores later output", () => {
		const store = new MemoryToolOutputStore();
		const output = capture(store, { maxChars: 1 });
		output.append("abc");

		const saved = output.finish();
		expect(saved).toBeDefined();
		output.append("more");
		expect(output.finish()).toBe(saved);
		expect(store.list("sess_1", 10)).toHaveLength(1);
		expect(store.readText("sess_1", saved?.id as string)).toBe("abc");
	});

	it("falls back quietly when the context has no store", () => {
		const output = capture(undefined, { maxChars: 1 });
		output.append("abc");
		output.spill();

		expect(output.finish()).toBeUndefined();
	});

	it("falls back quietly when the store refuses the write", () => {
		const store = new MemoryToolOutputStore();
		store.put = () => undefined;
		const output = capture(store, { maxChars: 1 });
		output.append("abc");

		expect(output.finish()).toBeUndefined();
	});

	it("stores nothing for empty output even after spill()", () => {
		const store = new MemoryToolOutputStore();
		const output = capture(store);
		output.append("");
		output.spill();

		expect(output.finish()).toBeUndefined();
		expect(store.list("sess_1", 10)).toEqual([]);
	});

	it("says later output was not stored when the stored copy is capped", () => {
		const output = truncateCommandOutput("x".repeat(100), {
			maxChars: 20,
			savedOutput: {
				id: "ab12cd34",
				totalChars: 100,
				capped: true,
				maxStoredChars: 10 * 1024 * 1024,
			},
		});

		expect(output).toContain(
			"The first 10 MB of output is stored as tool output ab12cd34; later output was not stored. To see more of it, use tool_output",
		);
		expect(output).not.toContain("The full output");
	});

	it("puts the id and tool_output in the truncation notice", () => {
		const output = truncateCommandOutput("x".repeat(100), {
			maxChars: 20,
			savedOutput: {
				id: "ab12cd34",
				totalChars: 100,
				capped: false,
				maxStoredChars: 10 * 1024 * 1024,
			},
		});

		expect(output).toBe(
			`${"x".repeat(10)}\n` +
				'[... output truncated: 100 chars total. The full output is stored as tool output ab12cd34. To see more of it, use tool_output {"action": "search", "id": "ab12cd34", "pattern": "FAIL|Error", "ignore_case": true} or read a line range with tool_output instead of re-running the command ...]\n' +
				"x".repeat(10),
		);
	});
});
