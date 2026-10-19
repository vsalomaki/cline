import path from "node:path"
import {
	type CompactionHookRunner,
	type CoreSessionConfig,
	createHookConfigFileRuntime,
	type HookRunEvent,
	resolveFileHookOptions,
} from "@cline/core"
import { getAgentLimitValue } from "@shared/AgentLimits"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { getHooksEnabledSafe } from "@/core/hooks/hooks-utils"
import { documentsHooksDirectory } from "@/core/hooks/sdk-hook-files"
import { getWindowWorkspaceRoots } from "@/core/storage/disk"
import type { StateManager } from "@/core/storage/StateManager"
import type { HookMessageEmitter } from "./hooks-adapter"

export type HookEngine = "sdk" | "legacy"

/** The "Hook engine" Agent Limits choice: 0 is the SDK engine, 1 the legacy one. */
export function readHookEngine(stateManager: StateManager): HookEngine {
	return getAgentLimitValue(stateManager.getGlobalStateKey("agentLimitSettings"), "session.hookEngine") === 1 ? "legacy" : "sdk"
}

/** Whether sessions get the SDK's file hooks (the "hooks" config extension). */
export function sdkFileHooksEnabled(stateManager: StateManager): boolean {
	return getHooksEnabledSafe(stateManager.getGlobalSettingsKey("hooksEnabled")) && readHookEngine(stateManager) === "sdk"
}

/**
 * Hook directories the SDK does not search on its own: every window
 * workspace root, not just the session's, and the Documents folder as the
 * OS reports it, which can differ from `~/Documents`.
 */
async function extraHookDirectories(): Promise<string[]> {
	const roots = await getWindowWorkspaceRoots()
	return [
		await documentsHooksDirectory(),
		...roots.flatMap((root) => [path.join(root, ".clinerules", "hooks"), path.join(root, ".cline", "hooks")]),
	]
}

export async function buildFileHookSettings(stateManager: StateManager): Promise<CoreSessionConfig["fileHooks"]> {
	return {
		timeoutMs: getAgentLimitValue(stateManager.getGlobalStateKey("agentLimitSettings"), "timeout.hook"),
		// Like the legacy engine: TaskStart can stop the run or add context.
		blockingRunStart: true,
		// The hooks tab disables a hook by clearing its executable bit.
		requireExecutable: process.platform !== "win32",
		extraHookDirs: await extraHookDirectories(),
	}
}

/** PreCompact and post-compaction hooks for a manual compaction, when SDK file hooks are on. */
export function createManualCompactionHooks(
	stateManager: StateManager,
	config: Pick<
		CoreSessionConfig,
		"cwd" | "workspaceRoot" | "fileHooks" | "logger" | "providerId" | "modelId" | "mode" | "onHookRun"
	>,
	sessionId: string,
): CompactionHookRunner | undefined {
	if (!sdkFileHooksEnabled(stateManager)) {
		return undefined
	}
	return createHookConfigFileRuntime({
		...resolveFileHookOptions(config.fileHooks),
		cwd: config.cwd,
		workspacePath: config.workspaceRoot ?? config.cwd,
		rootSessionId: sessionId,
		logger: config.logger,
		model: { provider: config.providerId, slug: config.modelId },
		mode: config.mode,
		onHookRun: config.onHookRun,
	}).compaction
}

/**
 * Shows each SDK hook run as a hook_status chip. The final status reuses the
 * running message's timestamp, so it updates that chip.
 */
export function createHookRunChipEmitter(emit: HookMessageEmitter): (event: HookRunEvent) => void {
	const timestamps = new Map<string, number>()
	let lastTs = 0
	return (event) => {
		// Hooks that start in the same millisecond still need their own chip.
		const ts = timestamps.get(event.executionId) ?? Math.max(Date.now(), lastTs + 1)
		lastTs = Math.max(lastTs, ts)
		if (event.status === "running") {
			timestamps.set(event.executionId, ts)
		} else {
			timestamps.delete(event.executionId)
		}
		const message: ClineMessage = {
			ts,
			type: "say",
			say: "hook_status",
			text: JSON.stringify({
				hookName: event.hookName,
				...(event.toolName ? { toolName: event.toolName } : {}),
				status: event.status,
				...(event.noEffect ? { noEffect: true } : {}),
				...(event.error
					? {
							error: {
								type: event.error === "timed out" ? "timeout" : "execution",
								message: event.error,
								scriptPath: event.source,
							},
						}
					: {}),
			}),
			partial: false,
		}
		emit(message)
	}
}
