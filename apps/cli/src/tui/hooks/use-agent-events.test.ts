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
	const { handleAgentEvent } = createHandlers({
		appendEntry,
		updateLastEntry: vi.fn(),
		updateEntry: vi.fn(),
		closeInlineStream: vi.fn(),
		activeInlineStreamRef: { current: null },
		setIsRunning,
		setIsStreaming: vi.fn(),
		addUsageDelta: vi.fn(),
		onTurnErrorReported,
		verbose: false,
	});
	return { handleAgentEvent, setIsRunning, appendEntry, onTurnErrorReported };
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
});
