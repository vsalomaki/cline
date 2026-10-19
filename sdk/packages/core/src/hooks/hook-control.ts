import { randomUUID } from "node:crypto";
import type {
	AgentBeforeToolResult,
	BasicLogger,
	HookControl,
} from "@cline/shared";
import { truncateHookContext } from "./subprocess";

export type HookCommandControl = Omit<HookControl, "appendMessages"> & {
	systemPrompt?: string;
	appendMessages?: unknown[];
	/**
	 * Error message accompanying `cancel: true`. Kept separate from `context`
	 * so injectable context from one hook never leaks into another hook's
	 * cancellation reason when controls are merged.
	 */
	cancelReason?: string;
	/** Block this one tool call (or prompt) without stopping the run. */
	deny?: boolean;
	denyReason?: string;
	/** Ask the user before this tool call, whatever the approval settings. */
	ask?: boolean;
};

export type HookRunStatus = "running" | "completed" | "failed" | "cancelled";

/** Whether a hook's output changes the run: context, a block, a question, new input or messages. */
export function hookControlHasEffect(
	control: HookCommandControl | undefined,
): boolean {
	if (!control) return false;
	return Boolean(
		control.cancel ||
			control.deny ||
			control.ask ||
			control.review ||
			control.context?.trim() ||
			control.overrideInput !== undefined ||
			control.systemPrompt !== undefined ||
			control.appendMessages?.length ||
			control.replaceMessages?.length,
	);
}

export interface HookRunEvent {
	/** Same for the running and final report of one hook execution. */
	executionId: string;
	/** Hook file name, such as `PreToolUse`. */
	hookName: string;
	/** Hook file path, or the command of a hooks.json entry. */
	source: string;
	toolName?: string;
	toolCallId?: string;
	itemIndex?: number;
	status: HookRunStatus;
	durationMs?: number;
	error?: string;
	/** A completed hook whose output changes nothing, so a host may leave it out. */
	noEffect?: boolean;
}

/** Reports each hook execution, for host status UI. */
export type HookRunObserver = (event: HookRunEvent) => void;

export function logHookError(
	logger: BasicLogger | undefined,
	message: string,
	error?: unknown,
): void {
	const detail = error instanceof Error ? `: ${error.message}` : "";
	const text = `${message}${detail}`;
	if (logger) {
		try {
			logger.log(text, {
				severity: "warn",
				...(error !== undefined ? { error } : {}),
			});
		} catch {
			// Logging failures must not break hook execution.
		}
		return;
	}
	console.warn(text);
}

export function mergeHookControls(
	current: HookCommandControl | undefined,
	next: HookCommandControl | undefined,
): HookCommandControl | undefined {
	if (!next) {
		return current;
	}
	if (!current) {
		return { ...next };
	}
	const contexts = [current.context, next.context]
		.filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		)
		.join("\n");
	const cancelReasons = [current.cancelReason, next.cancelReason]
		.filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		)
		.join("\n");
	const appendMessages = [
		...(current.appendMessages ?? []),
		...(next.appendMessages ?? []),
	];
	const denyReasons = [current.denyReason, next.denyReason]
		.filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		)
		.join("\n");
	return {
		cancel: current.cancel === true || next.cancel === true ? true : undefined,
		deny: current.deny === true || next.deny === true ? true : undefined,
		denyReason: denyReasons || undefined,
		ask: current.ask === true || next.ask === true ? true : undefined,
		review: current.review === true || next.review === true ? true : undefined,
		context: contexts || undefined,
		cancelReason: cancelReasons || undefined,
		overrideInput:
			next.overrideInput !== undefined
				? next.overrideInput
				: current.overrideInput,
		systemPrompt:
			next.systemPrompt !== undefined
				? next.systemPrompt
				: current.systemPrompt,
		appendMessages: appendMessages.length > 0 ? appendMessages : undefined,
	};
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

/**
 * Reads Cline's own control fields and Claude Code's hook output fields
 * (`hookSpecificOutput`, `decision`, `continue`).
 */
export function parseHookControl(
	value: unknown,
): HookCommandControl | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const specific =
		record.hookSpecificOutput && typeof record.hookSpecificOutput === "object"
			? (record.hookSpecificOutput as Record<string, unknown>)
			: undefined;
	const injectableContext =
		typeof record.context === "string"
			? record.context
			: typeof record.contextModification === "string"
				? record.contextModification
				: undefined;
	const errorMessage = nonEmptyString(record.errorMessage);
	const stopRun = record.continue === false;
	const cancel = stopRun
		? true
		: typeof record.cancel === "boolean"
			? record.cancel
			: undefined;
	const deny =
		specific?.permissionDecision === "deny" || record.decision === "block";
	const additionalContext = nonEmptyString(specific?.additionalContext);
	const context = [injectableContext ?? errorMessage, additionalContext]
		.filter((text): text is string => Boolean(text?.trim()))
		.join("\n");
	return {
		cancel,
		review: typeof record.review === "boolean" ? record.review : undefined,
		// A cancelling hook's message is its error/reason, not injectable
		// conversation context; errorMessage takes precedence there.
		context:
			cancel === true ? undefined : truncateHookContext(context || undefined),
		cancelReason:
			cancel === true
				? stopRun
					? (nonEmptyString(record.stopReason) ?? errorMessage)
					: (errorMessage ?? injectableContext)
				: undefined,
		deny: deny ? true : undefined,
		denyReason: deny
			? (nonEmptyString(specific?.permissionDecisionReason) ??
				nonEmptyString(record.reason))
			: undefined,
		ask: specific?.permissionDecision === "ask" ? true : undefined,
		overrideInput:
			specific && Object.hasOwn(specific, "updatedInput")
				? specific.updatedInput
				: Object.hasOwn(record, "overrideInput")
					? record.overrideInput
					: undefined,
	};
}

/** Which tool call a hook run belongs to, for status reporting. */
export type HookRunMeta = Pick<
	HookRunEvent,
	"toolName" | "toolCallId" | "itemIndex"
>;

/** Starts reporting one hook execution; the returned function reports its end. */
export function reportHookRun(
	observer: HookRunObserver | undefined,
	logger: BasicLogger | undefined,
	start: Omit<HookRunEvent, "executionId" | "status" | "durationMs" | "error">,
): (
	status: Exclude<HookRunStatus, "running">,
	error?: string,
	noEffect?: boolean,
) => void {
	if (!observer) {
		return () => {};
	}
	const executionId = randomUUID();
	const startedAt = Date.now();
	const emit = (event: HookRunEvent) => {
		try {
			observer(event);
		} catch (error) {
			logHookError(logger, "hook run observer failed", error);
		}
	};
	emit({ ...start, executionId, status: "running" });
	let finished = false;
	return (status, error, noEffect) => {
		if (finished) return;
		finished = true;
		emit({
			...start,
			executionId,
			status,
			durationMs: Date.now() - startedAt,
			...(error ? { error } : {}),
			...(noEffect && status === "completed" ? { noEffect } : {}),
		});
	};
}

const DEFAULT_DENY_REASON = "Blocked by a PreToolUse hook";

/** Stop beats deny, and deny beats ask. */
export function beforeToolResultFromControl(
	control: HookCommandControl | undefined,
): AgentBeforeToolResult | undefined {
	if (!control) {
		return undefined;
	}
	const result: AgentBeforeToolResult = {};
	if (control.cancel === true) {
		result.stop = true;
		if (control.cancelReason?.trim()) {
			result.reason = control.cancelReason;
		}
		return result;
	}
	if (control.context?.trim()) {
		// Context is injected only when the hook lets the run continue; a
		// cancelling hook's message travels as cancelReason instead (legacy
		// surfaced it as an error, never as conversation context).
		result.appendContext = control.context;
	}
	if (control.deny === true) {
		result.skip = true;
		result.reason = control.denyReason ?? DEFAULT_DENY_REASON;
		return result;
	}
	if (control.ask === true) {
		result.policy = { requireApproval: true };
	}
	if (control.overrideInput !== undefined) {
		result.input = control.overrideInput;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/** afterTool may stop the run or add context; a deny reason becomes context. */
export function afterToolResultFromControl(
	control: HookCommandControl | undefined,
): { stop?: boolean; reason?: string; appendContext?: string } | undefined {
	if (!control) {
		return undefined;
	}
	const result: { stop?: boolean; reason?: string; appendContext?: string } =
		{};
	if (control.cancel === true) {
		result.stop = true;
		if (control.cancelReason?.trim()) {
			result.reason = control.cancelReason;
		}
		return result;
	}
	const context = [control.denyReason, control.context]
		.filter((text): text is string => Boolean(text?.trim()))
		.join("\n");
	if (context) {
		result.appendContext = context;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/** beforeRun may stop the run or add context; a denied prompt stops the run. */
export function runStartResultFromControl(
	control: HookCommandControl | undefined,
): { stop?: boolean; reason?: string; appendContext?: string } | undefined {
	if (!control) {
		return undefined;
	}
	if (control.cancel === true || control.deny === true) {
		const reason =
			control.cancel === true ? control.cancelReason : control.denyReason;
		return { stop: true, ...(reason?.trim() ? { reason } : {}) };
	}
	return control.context?.trim()
		? { appendContext: control.context }
		: undefined;
}
