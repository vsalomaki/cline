import { type AgentMode, normalizeUserInput } from "@cline/shared";
import { nanoid } from "nanoid";
import { notifyTeamRunWaiters } from "../../session/team/team-session-coordinator";
import type {
	CoreSessionEvent,
	SessionPendingPrompt,
} from "../../types/events";
import type { ActiveSession, PendingPrompt } from "../../types/session";
import type {
	PendingPromptMutationResult,
	PendingPromptsDeleteInput,
	PendingPromptsUpdateInput,
} from "../host/runtime-host";

export type PendingPromptDelivery = "queue" | "steer";

export interface PendingPromptEntry {
	id: string;
	prompt: string;
	mode?: AgentMode;
	delivery: PendingPromptDelivery;
	typedInput?: boolean;
	userImages?: string[];
	userFiles?: string[];
}

export interface PendingPromptQueueState {
	pendingPrompts: PendingPromptEntry[];
}

export interface PendingPromptsControllerDeps {
	getSession(sessionId: string): ActiveSession | undefined;
	emit(event: CoreSessionEvent): void;
	send(input: {
		sessionId: string;
		prompt: string;
		mode?: AgentMode;
		userImages?: string[];
		userFiles?: string[];
	}): Promise<unknown>;
}

export interface PendingPromptEnqueueInput {
	prompt: string;
	mode?: AgentMode;
	delivery: PendingPromptDelivery;
	typedInput?: boolean;
	userImages?: string[];
	userFiles?: string[];
}

export interface PendingPromptConsumeResult {
	entry?: PendingPromptEntry;
	prompts: SessionPendingPrompt[];
}

export class PendingPromptService {
	list(state: PendingPromptQueueState | undefined): SessionPendingPrompt[] {
		return state ? snapshotPrompts(state) : [];
	}

	update(
		state: PendingPromptQueueState | undefined,
		input: PendingPromptsUpdateInput,
	): PendingPromptMutationResult {
		if (!state) {
			return { sessionId: input.sessionId, prompts: [], updated: false };
		}
		const promptId = input.promptId.trim();
		const index = state.pendingPrompts.findIndex(
			(entry) => entry.id === promptId,
		);
		if (index < 0) {
			return {
				sessionId: input.sessionId,
				prompts: snapshotPrompts(state),
				updated: false,
			};
		}

		const existing = state.pendingPrompts[index];
		if (!existing) {
			return {
				sessionId: input.sessionId,
				prompts: snapshotPrompts(state),
				updated: false,
			};
		}
		const prompt =
			input.prompt === undefined
				? existing.prompt
				: normalizeUserInput(input.prompt).trim();
		if (!prompt) {
			throw new Error("prompt cannot be empty");
		}
		const delivery = input.delivery ?? existing.delivery;
		const next: PendingPromptEntry = {
			...existing,
			prompt,
			mode: input.mode ?? existing.mode,
			delivery,
		};
		state.pendingPrompts.splice(index, 1);
		insertUpdatedPrompt(state, next, index, existing.delivery);
		return {
			sessionId: input.sessionId,
			prompts: snapshotPrompts(state),
			prompt: snapshotPrompt(next),
			updated: true,
		};
	}

	delete(
		state: PendingPromptQueueState | undefined,
		input: PendingPromptsDeleteInput,
	): PendingPromptMutationResult {
		if (!state) {
			return { sessionId: input.sessionId, prompts: [], removed: false };
		}
		const promptId = input.promptId.trim();
		const index = state.pendingPrompts.findIndex(
			(entry) => entry.id === promptId,
		);
		if (index < 0) {
			return {
				sessionId: input.sessionId,
				prompts: snapshotPrompts(state),
				removed: false,
			};
		}
		const [removed] = state.pendingPrompts.splice(index, 1);
		return {
			sessionId: input.sessionId,
			prompts: snapshotPrompts(state),
			prompt: removed ? snapshotPrompt(removed) : undefined,
			removed: true,
		};
	}

	enqueue(
		state: PendingPromptQueueState,
		input: PendingPromptEnqueueInput,
	): SessionPendingPrompt[] {
		const { prompt, mode, delivery, typedInput, userImages, userFiles } = input;
		const existingIndex = state.pendingPrompts.findIndex(
			(queued) => queued.delivery === "queue" && queued.prompt === prompt,
		);
		if (existingIndex >= 0) {
			const [existing] = state.pendingPrompts.splice(existingIndex, 1);
			insertPrompt(state, {
				...existing,
				prompt,
				mode: mode ?? existing.mode,
				delivery,
				typedInput,
				userImages: userImages ?? existing.userImages,
				userFiles: userFiles ?? existing.userFiles,
			});
		} else {
			insertPrompt(state, {
				id: `pending_${Date.now()}_${nanoid(5)}`,
				prompt,
				mode,
				delivery,
				typedInput,
				userImages,
				userFiles,
			});
		}
		return snapshotPrompts(state);
	}

	consumeSteers(state: PendingPromptQueueState): PendingPromptEntry[] {
		const steers = state.pendingPrompts.filter(
			(entry) => entry.delivery === "steer",
		);
		const queued = state.pendingPrompts.filter(
			(entry) => entry.delivery !== "steer",
		);
		state.pendingPrompts.splice(0, state.pendingPrompts.length, ...queued);
		return steers;
	}

	shiftNext(state: PendingPromptQueueState): PendingPromptConsumeResult {
		const entry = state.pendingPrompts.shift();
		return { entry, prompts: snapshotPrompts(state) };
	}

	requeueFront(
		state: PendingPromptQueueState,
		entry: PendingPromptEntry,
	): SessionPendingPrompt[] {
		state.pendingPrompts.unshift(entry);
		return snapshotPrompts(state);
	}

	clear(state: PendingPromptQueueState): SessionPendingPrompt[] {
		state.pendingPrompts.length = 0;
		return [];
	}
}

export class PendingPromptsController {
	private readonly service = new PendingPromptService();

	constructor(private readonly deps: PendingPromptsControllerDeps) {}

	list(sessionId: string): SessionPendingPrompt[] {
		return this.service.list(this.deps.getSession(sessionId));
	}

	steerFirst(sessionId: string): PendingPromptMutationResult {
		// Selection and promotion share one synchronous runtime operation. No
		// client snapshot or asynchronous request can intervene between them.
		const session = this.deps.getSession(sessionId);
		const first = session?.pendingPrompts[0];
		if (!first || first.delivery === "steer") {
			return { sessionId, prompts: this.service.list(session), updated: false };
		}
		return this.update({ sessionId, promptId: first.id, delivery: "steer" });
	}

	update(input: PendingPromptsUpdateInput): PendingPromptMutationResult {
		const session = this.deps.getSession(input.sessionId);
		if (!session) {
			return { sessionId: input.sessionId, prompts: [], updated: false };
		}
		const result = this.service.update(session, input);
		this.emitPrompts(session);
		this.scheduleDrain(input.sessionId, session);
		return result;
	}

	delete(input: PendingPromptsDeleteInput): PendingPromptMutationResult {
		const session = this.deps.getSession(input.sessionId);
		if (!session) {
			return { sessionId: input.sessionId, prompts: [], removed: false };
		}
		const result = this.service.delete(session, input);
		this.emitPrompts(session);
		this.scheduleDrain(input.sessionId, session);
		return result;
	}

	enqueue(
		sessionId: string,
		entry: {
			prompt: string;
			mode?: AgentMode;
			delivery: "queue" | "steer";
			typedInput?: boolean;
			userImages?: string[];
			userFiles?: string[];
		},
	): void {
		const session = this.deps.getSession(sessionId);
		if (!session) return;
		// The queue survives aborts and is visible while one settles, so
		// queue operations must keep working during the abort window: a
		// prompt typed right after Escape joins the queue instead of being
		// silently dropped, and queued prompts stay editable/deletable before
		// they auto-run. scheduleDrain/drain still refuse to run while the
		// abort is settling.
		this.service.enqueue(session, entry);
		this.emitPrompts(session);
		this.scheduleDrain(sessionId, session);
	}

	consumeSteers(sessionId: string): PendingPromptEntry[] {
		const session = this.deps.getSession(sessionId);
		if (!session) return [];
		const steers = this.service.consumeSteers(session);
		if (steers.length === 0) return [];
		this.emitPrompts(session);
		for (const steer of steers) {
			this.emitSubmitted(session, steer, { midRun: true });
		}
		return steers;
	}

	/**
	 * Drops every queued prompt. Only called when the user aborts a
	 * queue-initiated turn — that gesture means "stop the queued work", not
	 * just "stop this response", so the remainder must not auto-run.
	 */
	discardQueue(session: ActiveSession): void {
		if (session.pendingPrompts.length === 0) return;
		this.service.clear(session);
		this.emitPrompts(session);
	}

	emitPrompts(session: ActiveSession): void {
		this.deps.emit({
			type: "pending_prompts",
			payload: {
				sessionId: session.sessionId,
				prompts: snapshotPrompts(session),
			},
		});
	}

	scheduleDrain(sessionId: string, session: ActiveSession): void {
		// A turn parked on teammate runs is still in progress: wake it, and the
		// queue drains when that turn returns.
		if (session.teamRunWaiters.length > 0) {
			notifyTeamRunWaiters(session);
			return;
		}
		if (
			session.pendingPrompts.length === 0 ||
			session.aborting ||
			session.drainingPendingPrompts ||
			!session.agent.canStartRun()
		) {
			return;
		}
		queueMicrotask(() => {
			void this.drain(sessionId);
		});
	}

	async drain(sessionId: string): Promise<void> {
		const session = this.deps.getSession(sessionId);
		if (!session) return;
		if (session.aborting || session.drainingPendingPrompts) {
			return;
		}
		if (!session.agent.canStartRun()) {
			return;
		}
		const { entry: next } = this.service.shiftNext(session);
		if (!next) return;
		this.emitPrompts(session);
		this.emitSubmitted(session, next);
		session.drainingPendingPrompts = true;
		let continueDrain = true;
		try {
			const result = await this.deps.send({
				sessionId,
				prompt: next.prompt,
				...(next.mode ? { mode: next.mode } : {}),
				userImages: next.userImages,
				userFiles: next.userFiles,
			});
			// A turn that resolves with an error finish ran (the prompt is in
			// the conversation and the error is surfaced), so the entry is not
			// requeued — but stop draining instead of firing the remaining
			// queue into a failing provider. The rest stays queued and drains
			// on the next enqueue/update or successful turn.
			if (isErrorFinish(result)) {
				continueDrain = false;
			}
		} catch {
			continueDrain = false;
			this.service.requeueFront(session, next);
			this.emitPrompts(session);
		} finally {
			session.drainingPendingPrompts = false;
			if (
				continueDrain &&
				session.pendingPrompts.length > 0 &&
				session.status !== "failed" &&
				session.status !== "cancelled"
			) {
				queueMicrotask(() => {
					void this.drain(sessionId);
				});
			}
		}
	}

	private emitSubmitted(
		session: ActiveSession,
		entry: PendingPrompt,
		options?: { midRun: true },
	): void {
		const prompt = snapshotPrompt(entry);
		this.deps.emit({
			type: "pending_prompt_submitted",
			payload: {
				sessionId: session.sessionId,
				id: prompt.id,
				prompt: prompt.prompt,
				delivery: prompt.delivery,
				attachmentCount: prompt.attachmentCount,
				userImages: prompt.userImages,
				userFiles: prompt.userFiles,
				...options,
			},
		});
	}
}

function isErrorFinish(result: unknown): boolean {
	return (
		typeof result === "object" &&
		result !== null &&
		"finishReason" in result &&
		(result as { finishReason?: unknown }).finishReason === "error"
	);
}

function snapshotPrompt(entry: PendingPromptEntry): SessionPendingPrompt {
	return {
		id: entry.id,
		prompt: entry.prompt,
		delivery: entry.delivery,
		attachmentCount:
			(entry.userImages?.length ?? 0) + (entry.userFiles?.length ?? 0),
		userImages: entry.userImages,
		userFiles: entry.userFiles,
	};
}

function snapshotPrompts(
	state: PendingPromptQueueState,
): SessionPendingPrompt[] {
	return state.pendingPrompts.map(snapshotPrompt);
}

function insertUpdatedPrompt(
	state: PendingPromptQueueState,
	next: PendingPromptEntry,
	previousIndex: number,
	previousDelivery: PendingPromptDelivery,
): void {
	if (next.delivery === previousDelivery) {
		state.pendingPrompts.splice(previousIndex, 0, next);
	} else {
		insertPrompt(state, next);
	}
}

/** A steer goes after the last steer, ahead of queued prompts; a queued prompt goes last. */
function insertPrompt(
	state: PendingPromptQueueState,
	entry: PendingPromptEntry,
): void {
	if (entry.delivery === "queue") {
		state.pendingPrompts.push(entry);
		return;
	}
	let afterLastSteer = 0;
	state.pendingPrompts.forEach((queued, index) => {
		if (queued.delivery === "steer") afterLastSteer = index + 1;
	});
	state.pendingPrompts.splice(afterLastSteer, 0, entry);
}
