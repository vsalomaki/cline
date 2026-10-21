import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentModel, AgentModelEvent } from "@cline/shared";
import { setClineDir, setHomeDir } from "@cline/shared/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreSessionConfig } from "../../types/config";
import type { CoreSessionEvent } from "../../types/events";
import { SessionRuntime } from "../orchestration/session-runtime-orchestrator";
import { LocalRuntimeHost } from "./local-runtime-host";
import {
	type SessionUsageSummary,
	splitCoreSessionConfig,
} from "./runtime-host";

const CHILD_MARKER = "CHILD_MARKER";
const LEAD_INPUT = [1_000, 1_200];
const CHILD_INPUT = [90_000, 95_000];

const prepared = vi.hoisted(
	() => [] as { agentId: string; previous: number | undefined }[],
);

vi.mock("../../extensions/context/compaction", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("../../extensions/context/compaction")
		>();
	const record =
		<T extends (context: never) => unknown>(prepareTurn: T | undefined) =>
		(context: Parameters<T>[0]) => {
			const { agentId, previousRequestInputTokens } = context as {
				agentId: string;
				previousRequestInputTokens?: number;
			};
			prepared.push({ agentId, previous: previousRequestInputTokens });
			return prepareTurn?.(context);
		};
	return {
		...original,
		createContextCompactionPrepareTurn: (
			...args: Parameters<typeof original.createContextCompactionPrepareTurn>
		) => record(original.createContextCompactionPrepareTurn(...args)) as never,
		createDelegatedAgentPrepareTurn: (
			...args: Parameters<typeof original.createDelegatedAgentPrepareTurn>
		) => record(original.createDelegatedAgentPrepareTurn(...args)) as never,
	};
});

vi.mock("../../services/llms/handler-factory", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("../../services/llms/handler-factory")
		>();
	const script = (
		turns: AgentModelEvent[][],
		inputTokens: number[],
	): AgentModel => {
		let request = 0;
		return {
			async *stream() {
				const index = request++;
				yield* turns[index] ?? [];
				yield {
					type: "usage",
					usage: { inputTokens: inputTokens[index] ?? 0, outputTokens: 10 },
				};
				yield {
					type: "finish",
					reason: turns[index + 1] ? "tool-calls" : "stop",
				};
			},
		};
	};
	return {
		...original,
		createAgentModelFromConfig: (config: { systemPrompt?: string }) =>
			config.systemPrompt?.includes(CHILD_MARKER)
				? script(
						[
							[
								{
									type: "tool-call-delta",
									toolCallId: "child-list",
									toolName: "list_files",
									inputText: JSON.stringify({ path: "." }),
								},
							],
							[{ type: "text-delta", text: "child done" }],
						],
						CHILD_INPUT,
					)
				: script(
						[
							[
								{
									type: "tool-call-delta",
									toolCallId: "lead-spawn",
									toolName: "spawn_agent",
									inputText: JSON.stringify({
										task: "look around",
										systemPrompt: CHILD_MARKER,
									}),
								},
							],
							[{ type: "text-delta", text: "lead done" }],
						],
						LEAD_INPUT,
					),
	};
});

let root: string;
const previousHome = process.env.HOME;
const previousClineDir = process.env.CLINE_DIR;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "host-subagent-usage-"));
	process.env.HOME = root;
	process.env.CLINE_DIR = join(root, ".cline");
	setHomeDir(root);
	setClineDir(process.env.CLINE_DIR);
	prepared.length = 0;
});

afterEach(() => {
	process.env.HOME = previousHome;
	process.env.CLINE_DIR = previousClineDir;
	setHomeDir(previousHome ?? "~");
	setClineDir(previousClineDir ?? join("~", ".cline"));
	rmSync(root, { recursive: true, force: true });
});

async function runLeadWithSubagent() {
	const sessionId = "sess-subagent-usage";
	const sessionService = {
		ensureSessionsDir: vi.fn().mockReturnValue(join(root, "sessions")),
		createRootSessionWithArtifacts: vi.fn().mockResolvedValue({
			manifestPath: join(root, "manifest.json"),
			messagesPath: join(root, "messages.json"),
			manifest: {
				version: 1,
				session_id: sessionId,
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
				enable_spawn: true,
				enable_teams: false,
				prompt: "delegate",
				messages_path: join(root, "messages.json"),
			},
		}),
		persistSessionMessages: vi.fn(),
		updateSessionStatus: vi.fn().mockResolvedValue({ updated: true }),
		updateSession: vi.fn().mockResolvedValue({ updated: true }),
		writeSessionManifest: vi.fn(),
		listSessions: vi.fn().mockResolvedValue([]),
		deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
	};
	let lead: SessionRuntime | undefined;
	const host = new LocalRuntimeHost({
		distinctId: "test",
		sessionService: sessionService as never,
		createAgent: (config) => {
			lead = new SessionRuntime(config);
			return lead;
		},
	});
	const events: AgentEvent[] = [];
	const liveUsage: Promise<SessionUsageSummary | undefined>[] = [];
	host.subscribe((event: CoreSessionEvent) => {
		if (event.type !== "agent_event") return;
		events.push(event.payload.event);
		if (event.payload.event.type === "usage") {
			liveUsage.push(host.getAccumulatedUsage(sessionId));
		}
	});
	const config: CoreSessionConfig = {
		sessionId,
		providerId: "mock-provider",
		modelId: "mock-model",
		cwd: root,
		systemPrompt: "lead",
		mode: "act",
		enableTools: true,
		enableSpawnAgent: true,
		enableAgentTeams: false,
		compaction: { enabled: true, strategy: "basic" },
	};
	await host.startSession({
		...splitCoreSessionConfig(config),
		prompt: "delegate",
		interactive: true,
	});
	const usage = await host.getAccumulatedUsage(sessionId);
	await host.stopSession(sessionId);
	return {
		leadId: lead?.getAgentId() as string,
		events,
		usage,
		liveUsage: await Promise.all(liveUsage),
	};
}

const usageEvents = (events: AgentEvent[]) =>
	events.flatMap((event) => (event.type === "usage" ? [event] : []));

describe("subagent usage in a lead session", () => {
	it("keeps the subagent's request sizes out of the lead's compaction", async () => {
		const { leadId } = await runLeadWithSubagent();
		const previousFor = (isLead: boolean) =>
			prepared
				.filter((entry) => (entry.agentId === leadId) === isLead)
				.map((entry) => entry.previous);
		expect(previousFor(true)).toEqual([undefined, LEAD_INPUT[0]]);
		expect(previousFor(false)).toEqual([undefined, CHILD_INPUT[0]]);
	});

	it("attributes usage events to the agent that made the request", async () => {
		const { leadId, events } = await runLeadWithSubagent();
		const usage = usageEvents(events);
		const lead = usage.filter((event) => event.agentId === leadId);
		const children = usage.filter((event) => event.agentId !== leadId);
		expect(lead.map((event) => event.inputTokens)).toEqual(LEAD_INPUT);
		expect(children.map((event) => event.inputTokens)).toEqual(CHILD_INPUT);
		for (const event of children) {
			expect(event.agentId).toEqual(expect.any(String));
			expect(event.parentAgentId).toBe(leadId);
		}
	});

	it("counts only the lead's own requests in the session usage", async () => {
		const { usage, liveUsage } = await runLeadWithSubagent();
		expect(usage?.usage?.inputTokens).toBe(LEAD_INPUT[0] + LEAD_INPUT[1]);
		expect(usage?.aggregateUsage?.inputTokens).toBe(
			LEAD_INPUT[0] + LEAD_INPUT[1] + CHILD_INPUT[0] + CHILD_INPUT[1],
		);
		for (const snapshot of liveUsage) {
			expect(snapshot?.usage?.inputTokens).toBeLessThanOrEqual(
				LEAD_INPUT[0] + LEAD_INPUT[1],
			);
		}
	});
});
