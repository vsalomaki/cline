import type { AgentEvent } from "@cline/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useCallback: <T>(fn: T) => fn,
	useRef: <T>(current: T) => ({ current }),
}));

const { useAgentEventHandlers: createHandlers } = await import(
	"./use-agent-events"
);

function setup() {
	const setIsRunning = vi.fn();
	const appendEntry = vi.fn();
	const onTurnErrorReported = vi.fn();
	const setContextUsage = vi.fn();
	const markContextCompacted = vi.fn();
	const { handleAgentEvent } = createHandlers({
		appendEntry,
		updateLastEntry: vi.fn(),
		updateEntry: vi.fn(),
		closeInlineStream: vi.fn(),
		activeInlineStreamRef: { current: undefined },
		setIsRunning,
		setIsStreaming: vi.fn(),
		addUsageDelta: vi.fn(),
		setContextUsage,
		markContextCompacted,
		onTurnErrorReported,
		verbose: false,
	});
	return {
		handleAgentEvent,
		setIsRunning,
		appendEntry,
		onTurnErrorReported,
		setContextUsage,
		markContextCompacted,
	};
}

describe("useAgentEventHandlers", () => {
	it("ends the turn on the lead's done and fatal error", () => {
		const { handleAgentEvent, setIsRunning, onTurnErrorReported } = setup();
		handleAgentEvent({
			type: "done",
			reason: "completed",
			text: "",
			iterations: 1,
		} as AgentEvent);
		handleAgentEvent({
			type: "error",
			error: new Error("boom"),
			recoverable: false,
		} as AgentEvent);
		expect(setIsRunning).toHaveBeenCalledTimes(2);
		expect(onTurnErrorReported).toHaveBeenCalledWith(true);
	});

	it("ignores a subagent's done and fatal error", () => {
		const { handleAgentEvent, setIsRunning, appendEntry, onTurnErrorReported } =
			setup();
		handleAgentEvent({
			type: "done",
			reason: "completed",
			text: "",
			iterations: 1,
			agentId: "child",
			parentAgentId: "lead",
		} as AgentEvent);
		handleAgentEvent({
			type: "error",
			error: new Error("boom"),
			recoverable: false,
			agentId: "child",
			parentAgentId: "lead",
		} as AgentEvent);
		expect(setIsRunning).not.toHaveBeenCalled();
		expect(appendEntry).not.toHaveBeenCalled();
		expect(onTurnErrorReported).not.toHaveBeenCalled();
	});

	it("keeps the lead's context breakdown, not a subagent's", () => {
		const { handleAgentEvent, setContextUsage } = setup();
		const snapshot = {
			estimatedTotal: 10,
			categories: {
				systemPrompt: 10,
				rules: [],
				memory: 0,
				tools: { builtin: 0, extension: 0, mcp: [] },
				messages: {
					conversation: 0,
					toolCalls: 0,
					toolResults: 0,
					filesAndImages: 0,
					summary: 0,
				},
			},
			windowTokens: 100,
		};
		const usage = {
			type: "usage",
			inputTokens: 40,
			outputTokens: 1,
			totalInputTokens: 40,
			totalOutputTokens: 1,
			contextUsage: snapshot,
		} as AgentEvent;
		handleAgentEvent({ ...usage, parentAgentId: "lead" } as AgentEvent);
		handleAgentEvent(usage);
		expect(setContextUsage).toHaveBeenCalledTimes(1);
		expect(setContextUsage).toHaveBeenCalledWith({
			snapshot,
			inputTokens: 40,
			compactedAfter: false,
		});
	});

	it("marks the breakdown as before the compaction once it completes", () => {
		const { handleAgentEvent, markContextCompacted } = setup();
		handleAgentEvent({
			type: "notice",
			noticeType: "status",
			displayRole: "status",
			message: "compacted",
			metadata: { kind: "auto_compaction", phase: "completed" },
		} as AgentEvent);
		expect(markContextCompacted).toHaveBeenCalledTimes(1);
	});

	it("ignores a subagent's completed compaction", () => {
		const { handleAgentEvent, markContextCompacted } = setup();
		handleAgentEvent({
			type: "notice",
			noticeType: "status",
			displayRole: "status",
			message: "compacted",
			parentAgentId: "lead",
			metadata: { kind: "auto_compaction", phase: "completed" },
		} as AgentEvent);
		expect(markContextCompacted).not.toHaveBeenCalled();
	});
});
