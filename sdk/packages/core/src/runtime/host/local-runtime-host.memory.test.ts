import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentResult, MessageWithMetadata } from "@cline/shared";
import { setClineDir, setHomeDir } from "@cline/shared/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryIdleExtractor } from "../../services/memory/extraction";
import { MemoryStore } from "../../services/memory/store";
import { createMemoryExtension } from "../../services/memory/tool";
import type { CoreSessionConfig } from "../../types/config";
import { LocalRuntimeHost } from "./local-runtime-host";
import { splitCoreSessionConfig } from "./runtime-host";

const createHandlerMock = vi.fn();

vi.mock("@cline/llms", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cline/llms")>()),
	createHandlerAsync: (config: unknown) => createHandlerMock(config),
}));

const result = (overrides: Partial<AgentResult> = {}): AgentResult => ({
	text: "ok",
	iterations: 1,
	finishReason: "completed",
	usage: { inputTokens: 1, outputTokens: 2, totalCost: 0 },
	messages: [],
	toolCalls: [],
	durationMs: 1,
	model: { id: "mock-model", provider: "mock-provider" },
	startedAt: new Date("2026-01-01T00:00:00.000Z"),
	endedAt: new Date("2026-01-01T00:00:01.000Z"),
	...overrides,
});

const correctedMessages: MessageWithMetadata[] = [
	{ id: "m1", role: "user", content: [{ type: "text", text: "add a test" }] },
	{
		id: "m2",
		role: "assistant",
		content: [
			{ type: "tool_use", id: "c1", name: "editor", input: { path: "a.ts" } },
		],
	},
	{
		id: "m3",
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: "c1", name: "editor", content: "ok" },
		],
	},
	{ id: "m4", role: "assistant", content: [{ type: "text", text: "done" }] },
	{
		id: "m5",
		role: "user",
		content: [{ type: "text", text: "that's wrong, tests go in src" }],
	},
	{ id: "m6", role: "assistant", content: [{ type: "text", text: "moved" }] },
];

let root: string;

const previousHome = process.env.HOME;
const previousClineDir = process.env.CLINE_DIR;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "host-memory-"));
	process.env.HOME = root;
	process.env.CLINE_DIR = join(root, ".cline");
	setHomeDir(root);
	setClineDir(process.env.CLINE_DIR);
	createHandlerMock.mockReset();
	createHandlerMock.mockReturnValue({
		createMessage: vi.fn(async function* () {
			yield { type: "text", id: "x", text: "[]" };
			yield { type: "done", id: "x", success: true };
		}),
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.env.HOME = previousHome;
	process.env.CLINE_DIR = previousClineDir;
	setHomeDir(previousHome ?? "~");
	setClineDir(previousClineDir ?? join("~", ".cline"));
	rmSync(root, { recursive: true, force: true });
});

async function startSession() {
	const store = new MemoryStore({
		userDir: join(root, "memory"),
		projectDir: join(root, "projects", "k", "memory"),
		projectKey: "/repo/.git",
	});
	const sessionService = {
		ensureSessionsDir: vi.fn().mockReturnValue(join(root, "sessions")),
		createRootSessionWithArtifacts: vi.fn().mockResolvedValue({
			manifestPath: join(root, "manifest.json"),
			messagesPath: join(root, "messages.json"),
			manifest: {
				version: 1,
				session_id: "sess-memory",
				source: "cli",
				pid: process.pid,
				started_at: "2026-01-01T00:00:00.000Z",
				status: "running",
				interactive: true,
				provider: "mock-provider",
				model: "mock-model",
				cwd: root,
				workspace_root: root,
				enable_tools: true,
				enable_spawn: false,
				enable_teams: false,
				prompt: "add a test",
				messages_path: join(root, "messages.json"),
			},
		}),
		persistSessionMessages: vi.fn(),
		updateSessionStatus: vi.fn().mockResolvedValue({ updated: true }),
		writeSessionManifest: vi.fn(),
		listSessions: vi.fn().mockResolvedValue([]),
		deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
	};
	const runtime = {
		tools: [],
		shutdown: vi.fn(),
		memory: {
			store,
			settings: { enabled: true, extractAfterRun: true },
			extension: createMemoryExtension(store),
		},
	};
	const agent = {
		run: vi.fn().mockResolvedValue(result()),
		continue: vi.fn().mockResolvedValue(result()),
		// Empty until the first run, so the start does not take the seeded-history path.
		getMessages: vi.fn(() =>
			agent.run.mock.calls.length > 0 ? correctedMessages : [],
		),
		getAgentId: vi.fn().mockReturnValue("agent-root"),
		getConversationId: vi.fn().mockReturnValue("conv-root"),
		abort: vi.fn(),
		subscribeEvents: vi.fn().mockReturnValue(() => {}),
		canStartRun: vi.fn().mockReturnValue(true),
		shutdown: vi.fn().mockResolvedValue(undefined),
	};
	const host = new LocalRuntimeHost({
		distinctId: "test",
		sessionService: sessionService as never,
		runtimeBuilder: { build: vi.fn().mockReturnValue(runtime) } as never,
		createAgent: () => agent as never,
	});
	const config: CoreSessionConfig = {
		sessionId: "sess-memory",
		providerId: "mock-provider",
		modelId: "mock-model",
		cwd: root,
		systemPrompt: "test",
		mode: "act",
		enableTools: true,
		enableSpawnAgent: false,
		enableAgentTeams: false,
	};
	await host.startSession({
		...splitCoreSessionConfig(config),
		prompt: "add a test",
		interactive: true,
	});
	return { host };
}

describe("LocalRuntimeHost memory extraction", () => {
	it("schedules a check when an interactive run completes", async () => {
		const schedule = vi.spyOn(MemoryIdleExtractor.prototype, "schedule");
		const { host } = await startSession();
		expect(schedule).toHaveBeenCalledTimes(1);
		expect(schedule).toHaveBeenCalledWith(correctedMessages);
		await host.stopSession("sess-memory");
	});

	it("cancels it when a new turn starts, then checks again", async () => {
		const cancel = vi.spyOn(MemoryIdleExtractor.prototype, "cancel");
		const schedule = vi.spyOn(MemoryIdleExtractor.prototype, "schedule");
		const { host } = await startSession();
		cancel.mockClear();
		await host.runTurn({ sessionId: "sess-memory", prompt: "more" });
		expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(
			schedule.mock.invocationCallOrder[1] ?? 0,
		);
		expect(schedule).toHaveBeenCalledTimes(2);
		await host.stopSession("sess-memory");
	});

	it("cancels it on an abort and when the session stops", async () => {
		const cancel = vi.spyOn(MemoryIdleExtractor.prototype, "cancel");
		const { host } = await startSession();
		cancel.mockClear();
		await host.abort("sess-memory");
		expect(cancel).toHaveBeenCalledTimes(1);
		await host.stopSession("sess-memory");
		expect(cancel.mock.calls.length).toBeGreaterThan(1);
		expect(createHandlerMock).not.toHaveBeenCalled();
	});
});
