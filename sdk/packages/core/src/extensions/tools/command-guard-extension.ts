/**
 * Command Guard Extensions
 *
 * The plan-mode guard below, and the act-mode uncommitted-work guard at the
 * end of this file.
 *
 * The plan-mode guard is a runtime extension that enforces the plan-mode command blacklist
 * (./command-guard.ts) as a `beforeTool` hook. The runtime builder registers
 * it for plan-mode sessions, making command blocking session policy in one
 * shared place: the hook fires for every `run_commands` tool in the runtime —
 * the SDK built-in and host-provided replacements like the VS Code
 * extension's terminal-backed tool — without threading a flag through each
 * layer.
 *
 * Because `beforeTool` hooks run before tool policies and user approval,
 * a blocked call is rejected up front: the user is never asked to approve a
 * command that would only fail, and the model receives the plan-mode error
 * as the tool result (`skip`, not `stop`, so the run continues).
 */

import type {
	AgentAfterToolContext,
	AgentAfterToolResult,
	AgentBeforeToolContext,
	AgentBeforeToolResult,
	AgentExtension,
	AgentRuntimeEvent,
	ITelemetryService,
} from "@cline/shared";
import { capturePlanModeCommandBlocked } from "../../services/telemetry/core-events";
import {
	findFileEditingCommand,
	findWorkDiscardingGitCommand,
	formatPlanModeBlockedCommandError,
} from "./command-guard";
import { DefaultToolNames } from "./constants";
import { normalizeRunCommandsInput } from "./helpers";
import {
	findLostWork,
	findRepositoryRoot,
	formatLostWorkNotice,
	snapshotWorkingTree,
	type WorkingTreeSnapshot,
} from "./uncommitted-work-check";

export const PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME =
	"core.plan-mode-command-guard";

export interface PlanModeCommandGuardOptions {
	telemetry?: ITelemetryService;
}

export function createPlanModeCommandGuardExtension(
	options: PlanModeCommandGuardOptions = {},
): AgentExtension {
	const beforeTool = (
		context: AgentBeforeToolContext,
	): AgentBeforeToolResult | undefined => {
		if (context.tool.name !== DefaultToolNames.RUN_COMMANDS) {
			return undefined;
		}

		let commands: ReturnType<typeof normalizeRunCommandsInput>;
		try {
			commands = normalizeRunCommandsInput(context.input);
		} catch {
			// Unparseable input: let the tool produce its own validation error.
			return undefined;
		}

		for (const command of commands) {
			const blocked = findFileEditingCommand(command);
			if (blocked) {
				capturePlanModeCommandBlocked(options.telemetry, {
					tool_name: "run_commands",
					blocked_construct: blocked,
					command_count: commands.length,
					agent_id: context.snapshot.agentId,
					conversation_id: context.snapshot.conversationId,
					run_id: context.snapshot.runId,
					iteration: context.snapshot.iteration,
					tool_call_id: context.toolCall.toolCallId,
				});
				return {
					skip: true,
					reason: formatPlanModeBlockedCommandError(blocked),
				};
			}
		}

		return undefined;
	};

	return {
		name: PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME,
		manifest: {
			capabilities: ["hooks"],
		},
		hooks: {
			beforeTool,
		},
	};
}

export const UNCOMMITTED_WORK_GUARD_EXTENSION_NAME =
	"core.uncommitted-work-guard";

/**
 * Act-mode protection for uncommitted work in the session's repository:
 * - a run_commands call with a git command that throws away uncommitted
 *   changes (`git checkout -- file`, `git reset --hard`, …) always goes to the
 *   user for approval, even when auto-approval would run it; where nobody can
 *   approve, it is refused;
 * - after every run_commands call, work the call lost (changes discarded,
 *   files removed or emptied) is reported to the model.
 */
export function createUncommittedWorkGuardExtension(options: {
	cwd: string;
}): AgentExtension {
	let root: Promise<string | undefined> | undefined;
	const snapshots = new Map<string, WorkingTreeSnapshot>();

	const beforeTool = (
		context: AgentBeforeToolContext,
	): AgentBeforeToolResult | undefined => {
		if (context.tool.name !== DefaultToolNames.RUN_COMMANDS) {
			return undefined;
		}
		let commands: ReturnType<typeof normalizeRunCommandsInput>;
		try {
			commands = normalizeRunCommandsInput(context.input);
		} catch {
			return undefined;
		}
		return commands.some((command) => findWorkDiscardingGitCommand(command))
			? { policy: { requireApproval: true } }
			: undefined;
	};

	// Calls in one response are all prepared before any runs, so the baseline
	// is taken when the call starts, after approval.
	const onEvent = async (event: AgentRuntimeEvent): Promise<void> => {
		if (
			event.type !== "tool-started" ||
			event.toolCall.toolName !== DefaultToolNames.RUN_COMMANDS
		) {
			return;
		}
		root ??= findRepositoryRoot(options.cwd);
		const dir = await root;
		const snapshot = dir ? await snapshotWorkingTree(dir) : undefined;
		if (snapshot) {
			snapshots.set(event.toolCall.toolCallId, snapshot);
		}
	};

	const afterTool = async (
		context: AgentAfterToolContext,
	): Promise<AgentAfterToolResult | undefined> => {
		const before = snapshots.get(context.toolCall.toolCallId);
		snapshots.delete(context.toolCall.toolCallId);
		const dir = await root;
		if (!before || !dir) {
			return undefined;
		}
		const after = await snapshotWorkingTree(dir, before.changed.keys());
		const lost = after ? findLostWork(before, after) : [];
		return lost.length > 0
			? { appendContext: formatLostWorkNotice(lost) }
			: undefined;
	};

	return {
		name: UNCOMMITTED_WORK_GUARD_EXTENSION_NAME,
		manifest: {
			capabilities: ["hooks"],
		},
		hooks: {
			beforeTool,
			onEvent,
			afterTool,
		},
	};
}
