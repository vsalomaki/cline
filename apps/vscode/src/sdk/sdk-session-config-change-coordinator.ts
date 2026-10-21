import type { MemorySettings } from "@cline/core"
import type { DelegationMode } from "@shared/Delegation"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { Mode } from "@shared/storage/types"
import type { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import type { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import type { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import type { SdkSessionRebuildScheduler, SessionRebuildContext, SessionRebuildReason } from "./sdk-session-rebuild-scheduler"
import type { SdkSessionHost } from "./session-host"
import type { VscodeSessionHost } from "./vscode-session-host"
import { getEffectiveTerminalExecutionMode, type VscodeTerminalExecutionMode } from "./vscode-terminal-execution-mode"

type StartInput = Parameters<VscodeSessionHost["start"]>[0]
type InitialMessages = StartInput["initialMessages"]
type SessionConfig = Awaited<ReturnType<SdkSessionConfigBuilder["build"]>>

export interface SdkSessionConfigChangeCoordinatorOptions {
	stateManager: StateManager
	sessions: SdkSessionLifecycle
	messages: SdkMessageCoordinator
	sessionConfigBuilder: SdkSessionConfigBuilder
	getWorkspaceRoot: () => Promise<string>
	loadInitialMessages: (sdkHost: SdkSessionHost, sessionId: string) => Promise<unknown[] | undefined>
	buildStartSessionInput: (config: SessionConfig, input: { cwd: string; mode: Mode }) => StartInput
	postStateToWebview: () => Promise<void>
	rebuilds: Pick<SdkSessionRebuildScheduler, "request">
}

interface RebuildDetails {
	reason: SessionRebuildReason
	description: string
	disposeReason: string
	failureMessage: string
}

export class SdkSessionConfigChangeCoordinator {
	constructor(private readonly options: SdkSessionConfigChangeCoordinatorOptions) {}

	handleTerminalExecutionModeChanged(previous: VscodeTerminalExecutionMode, next: VscodeTerminalExecutionMode): void {
		if (previous === next) {
			return
		}
		this.requestRebuild({
			reason: "terminalExecutionMode",
			description: `terminal execution mode ${previous} -> ${next}`,
			disposeReason: "terminalExecutionModeChange",
			failureMessage: "Failed to reload terminal tools. Terminal mode changes may not apply until the next task.",
		})
	}

	/** The run_commands tool captures its timeouts when built, so a change needs the same rebuild. */
	handleCommandTimeoutsChanged(): void {
		this.requestRebuild({
			reason: "commandTimeouts",
			description: "command timeout settings changed",
			disposeReason: "commandTimeoutsChange",
			failureMessage: "Failed to reload command timeouts. The change may not apply until the next task.",
		})
	}

	/** Tools, the message builder and loop detection capture these limits when built. */
	handleAgentLimitsChanged(): void {
		this.requestRebuild({
			reason: "agentLimits",
			description: "agent limit settings changed",
			disposeReason: "agentLimitsChange",
			failureMessage: "Failed to reload agent limits. The change may not apply until the next task.",
		})
	}

	/** The SDK file hooks are added to a session when it is built. */
	handleHooksSettingChanged(previous: boolean, next: boolean): void {
		if (previous === next) {
			return
		}
		this.requestRebuild({
			reason: "hooks",
			description: `hooks ${previous ? "enabled" : "disabled"} -> ${next ? "enabled" : "disabled"}`,
			disposeReason: "hooksSettingChange",
			failureMessage: "Failed to reload hooks. The change may not apply until the next task.",
		})
	}

	/** The spawn_agent tool is added to a session when it is built. */
	handleDelegationSettingChanged(previous: DelegationMode, next: DelegationMode): void {
		if (previous === next) {
			return
		}
		this.requestRebuild({
			reason: "subagents",
			description: `delegation ${previous} -> ${next}`,
			disposeReason: "subagentsSettingChange",
			failureMessage: "Failed to reload subagent settings. The change may not apply until the next task.",
		})
	}

	/** The memory tool, the recalled index and the idle extractor are set up when a session is built. */
	handleMemorySettingChanged(previous: MemorySettings, next: MemorySettings): void {
		if (previous.enabled === next.enabled && previous.extractAfterRun === next.extractAfterRun) {
			return
		}
		this.requestRebuild({
			reason: "memory",
			description: `memory ${JSON.stringify(previous)} -> ${JSON.stringify(next)}`,
			disposeReason: "memorySettingChange",
			failureMessage: "Failed to reload memory settings. The change may not apply until the next task.",
		})
	}

	handleCheckpointsSettingChanged(previous: boolean, next: boolean): void {
		if (previous === next) {
			return
		}
		this.requestRebuild({
			reason: "checkpoints",
			description: `checkpoints ${previous ? "enabled" : "disabled"} -> ${next ? "enabled" : "disabled"}`,
			disposeReason: "checkpointsSettingChange",
			failureMessage: "Failed to reload checkpoint settings. The change may not apply until the next task.",
		})
	}

	private requestRebuild(details: RebuildDetails): void {
		Logger.log(`[SdkController] Session configuration changed: ${details.description}`)

		const activeSession = this.options.sessions.getActiveSession()
		if (!activeSession) {
			Logger.log("[SdkController] No active session - configuration will be picked up on next initTask")
			return
		}

		this.options.rebuilds.request(details.reason, (context) => this.restartSession(details, context))
	}

	private async restartSession(details: RebuildDetails, context: SessionRebuildContext): Promise<void> {
		const activeSession = this.options.sessions.getActiveSession()
		if (!activeSession) {
			return
		}

		const { sdkHost: oldManager, sessionId: oldSessionId } = activeSession
		const terminalMode = getEffectiveTerminalExecutionMode(
			this.options.stateManager.getGlobalStateKey("vscodeTerminalExecutionMode"),
		)
		Logger.log(`[SdkController] Restarting session ${oldSessionId} for ${details.description}; terminal mode ${terminalMode}`)

		this.options.messages.emitSessionEvents([], {
			type: "status",
			payload: { sessionId: oldSessionId, status: "running" },
		})

		try {
			const cwd = await this.options.getWorkspaceRoot()
			const modeValue = this.options.stateManager.getGlobalSettingsKey("mode")
			const mode: Mode = modeValue === "plan" || modeValue === "act" ? modeValue : "act"
			const config = await this.options.sessionConfigBuilder.build({ cwd, mode })
			config.sessionId = oldSessionId

			const initialMessages = await this.options.loadInitialMessages(oldManager, oldSessionId)
			const startInput = this.options.buildStartSessionInput(config, { cwd, mode })

			// Rebuilds may preserve the session ID, so identity is the only reliable
			// way to detect that another path replaced this session while we awaited.
			const currentSession = this.options.sessions.getActiveSession()
			if (!currentSession) {
				Logger.log(`[SdkController] Active session ended during configuration restart (was ${oldSessionId}); aborting`)
				return
			}
			// A newer change for the same reason runs next, so this stale
			// configuration must not be installed.
			if (!context.isCurrent()) {
				Logger.log(`[SdkController] Configuration restart superseded before replacing ${oldSessionId}; aborting`)
				return
			}
			// The scheduler only starts a rebuild on an idle session with nothing
			// queued; a prompt the user sent while we awaited re-queues the rebuild.
			if (currentSession !== activeSession || currentSession.isRunning || currentSession.queuedPromptCount > 0) {
				Logger.log(
					`[SdkController] Active session changed or received a prompt during configuration restart (was ${oldSessionId}); deferring`,
				)
				this.options.rebuilds.request(details.reason, (nextContext) => this.restartSession(details, nextContext))
				return
			}

			// replaceActiveSession detaches the old session synchronously before its
			// first suspension, so no send can enter it after this final state check.
			const restartResult = await this.options.sessions.replaceActiveSession({
				expectedSession: activeSession,
				startInput,
				initialMessages: initialMessages as InitialMessages,
				disposeReason: details.disposeReason,
			})
			if (!restartResult) {
				return
			}

			const { startResult, sdkHost } = restartResult
			if (startResult.sessionId !== oldSessionId) {
				Logger.warn(
					`[SdkController] Configuration restart returned a new session ID (${startResult.sessionId}); preserving task ID ${oldSessionId} for UI continuity`,
				)
			}

			this.options.messages.emitSessionEvents([], {
				type: "status",
				payload: { sessionId: startResult.sessionId, status: "idle" },
			})

			await this.options.postStateToWebview()
			Logger.log(
				`[SdkController] Session restarted for ${details.description}: ${oldSessionId} -> ${startResult.sessionId}`,
			)
		} catch (error) {
			Logger.error(`[SdkController] Failed to restart session for ${details.description}:`, error)

			const errorMessage: ClineMessage = {
				ts: Date.now(),
				type: "say",
				say: "error",
				text: `${details.failureMessage} ${error instanceof Error ? error.message : String(error)}`,
				partial: false,
			}
			this.options.messages.appendAndEmit([errorMessage], {
				type: "status",
				payload: { sessionId: oldSessionId, status: "error" },
			})
			await this.options.postStateToWebview()
		}
	}
}
