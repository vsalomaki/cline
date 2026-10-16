import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentBeforeToolContext,
	AgentExtension,
	AgentRuntimeStateSnapshot,
	AgentTool,
	ITelemetryService,
} from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPlanModeCommandGuardExtension,
	createUncommittedWorkGuardExtension,
	PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME,
	UNCOMMITTED_WORK_GUARD_EXTENSION_NAME,
} from "./command-guard-extension";

function makeSnapshot(): AgentRuntimeStateSnapshot {
	return {
		agentId: "agent-1",
		conversationId: "conv-1",
		runId: "run-1",
		status: "running",
		iteration: 2,
		messages: [],
		pendingToolCalls: [],
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		},
	} as unknown as AgentRuntimeStateSnapshot;
}

function makeContext(toolName: string, input: unknown): AgentBeforeToolContext {
	return {
		snapshot: makeSnapshot(),
		tool: { name: toolName } as AgentTool,
		toolCall: {
			type: "tool-call",
			toolCallId: "tool-call-1",
			toolName,
			input,
		},
		input,
	};
}

function makeTelemetryStub(): ITelemetryService {
	return {
		capture: vi.fn(),
		captureRequired: vi.fn(),
		setDistinctId: vi.fn(),
		setMetadata: vi.fn(),
		updateMetadata: vi.fn(),
		setCommonProperties: vi.fn(),
		updateCommonProperties: vi.fn(),
		isEnabled: vi.fn(() => true),
		recordCounter: vi.fn(),
		recordHistogram: vi.fn(),
		recordGauge: vi.fn(),
		flush: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
	};
}

async function runBeforeTool(
	extension: ReturnType<typeof createPlanModeCommandGuardExtension>,
	context: AgentBeforeToolContext,
) {
	const hook = extension.hooks?.beforeTool;
	expect(hook).toBeTypeOf("function");
	return hook?.(context);
}

describe("plan-mode command-guard extension", () => {
	it("declares the hooks capability under a stable name", () => {
		const extension = createPlanModeCommandGuardExtension();
		expect(extension.name).toBe(PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME);
		expect(extension.manifest.capabilities).toContain("hooks");
	});

	it("skips run_commands calls containing a file-editing command", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", { commands: ["rm -rf build"] }),
		);

		expect(result?.skip).toBe(true);
		expect(result?.stop).toBeUndefined();
		expect(result?.reason).toContain("PLAN MODE");
		expect(result?.reason).toContain("`rm`");
	});

	it("rejects the whole call when any command in a batch is blocked", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", {
				commands: ["git status", "echo hi > out.txt"],
			}),
		);

		expect(result?.skip).toBe(true);
		expect(result?.reason).toContain("output redirection");
	});

	it("allows read-only run_commands calls", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", {
				commands: ["ls -la", "git log --oneline", "grep -rn foo src/"],
			}),
		);

		expect(result).toBeUndefined();
	});

	it("guards structured command input", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", {
				commands: [{ command: "git", args: ["checkout", "main"] }],
			}),
		);

		expect(result?.skip).toBe(true);
		expect(result?.reason).toContain("`git checkout`");
	});

	it("ignores other tools", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("read_files", { files: [{ path: "/tmp/rm" }] }),
		);

		expect(result).toBeUndefined();
	});

	it("lets the tool report its own error for unparseable input", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", { bogus: 42 }),
		);

		expect(result).toBeUndefined();
	});

	it("captures block telemetry without raw command content", async () => {
		const telemetry = makeTelemetryStub();
		const extension = createPlanModeCommandGuardExtension({ telemetry });

		await runBeforeTool(
			extension,
			makeContext("run_commands", {
				commands: ["rm -rf /workspace/secret-project"],
			}),
		);

		const captured = (telemetry.capture as ReturnType<typeof vi.fn>).mock.calls
			.map((call) => call[0])
			.filter((event) => event.event === "sdk.plan_mode_command_blocked");
		expect(captured).toHaveLength(1);
		expect(captured[0].properties).toMatchObject({
			tool_name: "run_commands",
			blocked_construct: "`rm`",
			command_count: 1,
			agent_id: "agent-1",
			conversation_id: "conv-1",
			run_id: "run-1",
			iteration: 2,
			tool_call_id: "tool-call-1",
		});
		expect(JSON.stringify(captured[0].properties)).not.toContain(
			"secret-project",
		);
	});

	it("does not capture telemetry for allowed calls", async () => {
		const telemetry = makeTelemetryStub();
		const extension = createPlanModeCommandGuardExtension({ telemetry });

		await runBeforeTool(
			extension,
			makeContext("run_commands", { commands: ["ls"] }),
		);

		expect(telemetry.capture).not.toHaveBeenCalled();
	});
});

describe("createUncommittedWorkGuardExtension", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const git = (cwd: string, ...args: string[]) =>
		execFileSync(
			"git",
			["-c", "user.email=t@t", "-c", "user.name=t", ...args],
			{ cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
		);

	function makeRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "uncommitted-work-"));
		dirs.push(dir);
		git(dir, "init", "-q");
		writeFileSync(join(dir, "a.txt"), "committed\n");
		git(dir, "add", "a.txt");
		git(dir, "commit", "-qm", "init");
		return dir;
	}

	function hooksFor(extension: AgentExtension, command: string, id: string) {
		const context = makeContext("run_commands", { commands: [command] });
		context.toolCall.toolCallId = id;
		return {
			prepare: () => extension.hooks?.beforeTool?.(context),
			start: () =>
				extension.hooks?.onEvent?.({
					type: "tool-started",
					snapshot: context.snapshot,
					iteration: 1,
					toolCall: context.toolCall,
				}),
			finish: async () =>
				(
					await extension.hooks?.afterTool?.({
						...context,
						result: { output: [] },
						startedAt: new Date(),
						endedAt: new Date(),
						durationMs: 0,
					})
				)?.appendContext,
		};
	}

	/** Runs `change` as the command, between the extension's hooks. */
	async function runCommand(
		cwd: string,
		command: string,
		change: () => void = () => git(cwd, ...command.split(" ").slice(1)),
	) {
		const extension = createUncommittedWorkGuardExtension({ cwd });
		expect(extension.name).toBe(UNCOMMITTED_WORK_GUARD_EXTENSION_NAME);
		const call = hooksFor(extension, command, "call-1");
		await call.prepare();
		await call.start();
		change();
		return { notice: await call.finish() };
	}

	it("requires approval for a command that discards uncommitted changes", async () => {
		const extension = createUncommittedWorkGuardExtension({ cwd: tmpdir() });
		const beforeTool = (input: unknown, toolName = "run_commands") =>
			extension.hooks?.beforeTool?.(makeContext(toolName, input));

		expect(
			await beforeTool({
				commands: ["git status", "git checkout -- src/a.ts"],
			}),
		).toEqual({ policy: { requireApproval: true } });
		expect(await beforeTool("git reset --hard")).toEqual({
			policy: { requireApproval: true },
		});
		expect(
			await beforeTool({ commands: ["git status", "git diff"] }),
		).toBeUndefined();
		expect(
			await beforeTool(
				{ path: "/repo/a.ts", new_text: "git reset --hard" },
				"editor",
			),
		).toBeUndefined();
	});

	it("reports uncommitted changes a command discarded", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "a.txt"), "edited\n");

		const { notice } = await runCommand(repo, "git checkout -- a.txt");

		expect(notice).toContain("a.txt: its uncommitted changes are gone");
	});

	it("reports unstaged changes to a new file that a checkout reverted to its staged version", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "new.txt"), "staged\n");
		git(repo, "add", "new.txt");
		writeFileSync(join(repo, "new.txt"), "staged\nand a lot more work\n");

		const { notice } = await runCommand(repo, "git checkout -- new.txt");

		expect(notice).toContain("new.txt: its unstaged changes are gone");
	});

	it("reports emptied and removed files", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "scratch.txt"), "untracked work\n");
		mkdirSync(join(repo, "notes"));
		writeFileSync(join(repo, "notes", "keep.txt"), "kept\n");
		writeFileSync(join(repo, "notes", "work.txt"), "untracked work\n");

		const { notice } = await runCommand(repo, "rm and truncate", () => {
			writeFileSync(join(repo, "a.txt"), "");
			rmSync(join(repo, "scratch.txt"));
			rmSync(join(repo, "notes", "work.txt"));
		});

		expect(notice).toContain("a.txt: now empty");
		expect(notice).toContain("scratch.txt: untracked, now removed");
		expect(notice).toContain("notes/work.txt: untracked, now removed");
		expect(notice).not.toContain("keep.txt");
	});

	it("stays quiet for staging, commits and new empty files", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "a.txt"), "edited\n");

		expect((await runCommand(repo, "git add a.txt")).notice).toBeUndefined();
		expect(
			(await runCommand(repo, "git commit -qm edit")).notice,
		).toBeUndefined();
		expect(
			(
				await runCommand(repo, "touch init", () =>
					writeFileSync(join(repo, "__init__.py"), ""),
				)
			).notice,
		).toBeUndefined();
	});

	it("stays quiet for a new empty file that is staged", async () => {
		const repo = makeRepo();

		const { notice } = await runCommand(repo, "touch and add", () => {
			writeFileSync(join(repo, "new.py"), "");
			git(repo, "add", "new.py");
		});

		expect(notice).toBeUndefined();
	});

	it("compares each call of a batch with the state when it started", async () => {
		const repo = makeRepo();
		const extension = createUncommittedWorkGuardExtension({ cwd: repo });
		const create = hooksFor(extension, "create notes", "call-1");
		const remove = hooksFor(extension, "remove notes", "call-2");
		await create.prepare();
		await remove.prepare();

		await create.start();
		writeFileSync(join(repo, "notes.txt"), "work\n");
		expect(await create.finish()).toBeUndefined();
		await remove.start();
		rmSync(join(repo, "notes.txt"));

		expect(await remove.finish()).toContain(
			"notes.txt: untracked, now removed",
		);
	});

	it("does nothing outside a git repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "uncommitted-work-"));
		dirs.push(dir);
		writeFileSync(join(dir, "a.txt"), "work\n");

		const { notice } = await runCommand(dir, "rm a.txt", () =>
			rmSync(join(dir, "a.txt")),
		);

		expect(notice).toBeUndefined();
	});
});
