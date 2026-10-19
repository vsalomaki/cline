import { TeamMessageType } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import type { ActiveSession } from "../../types/session";
import {
	dispatchTeamEventToBackend,
	notifyTeamRunWaiters,
	waitForTeamRunUpdates,
} from "./team-session-coordinator";

describe("dispatchTeamEventToBackend", () => {
	it("persists intentionally aborted teammate tasks as cancelled", async () => {
		const invokeOptional = vi.fn(async () => {});
		const error = new DOMException("This operation was aborted", "AbortError");

		await dispatchTeamEventToBackend(
			"root-session",
			{
				type: TeamMessageType.TaskEnd,
				agentId: "teammate-1",
				status: "cancelled",
				error,
				messages: [],
			},
			invokeOptional,
		);

		expect(invokeOptional).toHaveBeenCalledWith(
			"onTeamTaskEnd",
			"root-session",
			"teammate-1",
			"cancelled",
			"[done] aborted",
			undefined,
			[],
		);
	});
});

describe("waitForTeamRunUpdates", () => {
	it("stops waiting when the user queues a message", async () => {
		const session = {
			aborting: false,
			pendingPrompts: [],
			pendingTeamRunUpdates: [],
			activeTeamRunIds: new Set(["run-1"]),
			teamRunWaiters: [],
		} as unknown as ActiveSession;

		const waiting = waitForTeamRunUpdates(session);
		session.pendingPrompts.push({
			id: "p1",
			prompt: "Status?",
			delivery: "queue",
		});
		notifyTeamRunWaiters(session);

		await expect(waiting).resolves.toEqual([]);
	});
});
