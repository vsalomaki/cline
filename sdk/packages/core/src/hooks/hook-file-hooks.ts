import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AgentAfterToolContext,
	AgentBeforeToolContext,
	AgentExtension,
	AgentHooks,
	AgentMessage,
	AgentRunLifecycleContext,
	AgentRuntimeEvent,
	BasicLogger,
	HookSessionContext,
	WorkspaceInfo,
} from "@cline/shared";
import { augmentNodeCommandForDebug } from "@cline/shared";
import { ensureHookLogDir } from "@cline/shared/storage";
import type { CoreCompactionMode } from "../types/config";
import { ClaudeHooks } from "./claude-hooks";
import {
	afterToolResultFromControl,
	beforeToolResultFromControl,
	type HookCommandControl,
	type HookRunMeta,
	type HookRunObserver,
	logHookError,
	mergeHookControls,
	parseHookControl,
	reportHookRun,
	runStartResultFromControl,
} from "./hook-control";
import { createAgentHooksExtension } from "./hook-extension";
import {
	HOOK_CONFIG_FILE_EVENT_MAP,
	listHookConfigFiles,
} from "./hook-file-config";
import type { HookEventName, HookEventPayload } from "./subprocess";
import {
	type RunSubprocessEventOptions,
	type RunSubprocessEventResult,
	runSubprocessEvent,
} from "./subprocess-runner";

type HookContextBase = {
	agentId: string;
	conversationId: string;
	parentAgentId: string | null;
};

type HookCommandRunStartContext = HookContextBase & {
	userMessage: string;
};
type HookCommandToolCallStartContext = HookContextBase & {
	iteration: number;
	call: { id: string; name: string; input: unknown };
};
type HookCommandToolCallEndContext = HookContextBase & {
	iteration: number;
	record: {
		id: string;
		name: string;
		input: unknown;
		output: unknown;
		error?: string;
		durationMs: number;
		startedAt: Date;
		endedAt: Date;
	};
};
/**
 * Reports how long a fire-and-forget hook actually ran, once per hook. Hosts
 * use it to learn the real runtime distribution of detached hooks —
 * unmeasurable while nothing awaits them — before deciding to run any of them
 * blocking. `exited: false` is a censored observation (the hook was still
 * running after the observation window, so it ran at least `durationMs`),
 * which is what keeps the sample from covering only hooks that finish.
 */
export type HookRuntimeObserver = (event: {
	hookName: HookEventName;
	durationMs: number;
	exitCode: number | null;
	exited: boolean;
}) => void;

/** File hook settings a host can pass with the session config. */
export interface FileHookSettings {
	/** Timeout for each blocking hook. Default 120000, or `CLINE_HOOK_TIMEOUT_MS`. */
	timeoutMs?: number;
	/** Run TaskStart/TaskResume hooks blocking so they can stop the run or add context. */
	blockingRunStart?: boolean;
	/** Skip hook files without the executable bit (not on Windows). */
	requireExecutable?: boolean;
	/** Hook directories searched after the standard ones. */
	extraHookDirs?: string[];
	/**
	 * Which run-start event the session's first run fires. `none` is for a
	 * session rebuilt for a settings change. Default: `resume` when the
	 * conversation already has an assistant reply, otherwise `startup`.
	 */
	lifecycle?: "startup" | "resume" | "none";
}

type HookRuntimeOptions = {
	cwd: string;
	workspacePath: string;
	rootSessionId?: string;
	logger?: BasicLogger;
	toolCallTimeoutMs?: number;
	requireExecutable?: boolean;
	extraHookDirs?: readonly string[];
	lifecycle?: FileHookSettings["lifecycle"];
	/** Session mode (act, plan, yolo), for hooks.json `permission_mode`. */
	mode?: string;
	onHookRun?: HookRunObserver;
	model?: { provider: string; slug: string };
	/** Keep asynchronous hooks attached until exit. Intended for deterministic tests. */
	detachAsyncHooks?: boolean;
	/**
	 * Run agent_start/agent_resume hooks blocking, honoring their control
	 * output (cancel, contextModification). Off by default: these hooks have
	 * always been fire-and-forget with stdio ignored, so an existing
	 * long-running script would otherwise stall every run start until the
	 * timeout. A host that flips this on must tell hook authors that
	 * long-running run-start hooks need to background themselves (spawn a
	 * detached child and exit).
	 */
	blockingRunStartHooks?: boolean;
	/** Observes how long detached hooks run. See {@link HookRuntimeObserver}. */
	onHookRuntime?: HookRuntimeObserver;
	/** Structured git + path metadata forwarded into every hook payload. */
	workspaceInfo?: WorkspaceInfo;
};

/** Maps session settings onto runtime options; `CLINE_HOOK_TIMEOUT_MS` wins. */
export function resolveFileHookOptions(
	settings: FileHookSettings | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Pick<
	HookRuntimeOptions,
	| "toolCallTimeoutMs"
	| "blockingRunStartHooks"
	| "requireExecutable"
	| "extraHookDirs"
	| "lifecycle"
> {
	const envTimeout = Number(env.CLINE_HOOK_TIMEOUT_MS);
	const timeoutMs =
		Number.isFinite(envTimeout) && envTimeout > 0
			? envTimeout
			: settings?.timeoutMs;
	return {
		...(timeoutMs !== undefined && timeoutMs > 0
			? { toolCallTimeoutMs: timeoutMs }
			: {}),
		...(settings?.blockingRunStart !== undefined
			? { blockingRunStartHooks: settings.blockingRunStart }
			: {}),
		...(settings?.requireExecutable !== undefined
			? { requireExecutable: settings.requireExecutable }
			: {}),
		...(settings?.extraHookDirs
			? { extraHookDirs: settings.extraHookDirs }
			: {}),
		...(settings?.lifecycle ? { lifecycle: settings.lifecycle } : {}),
	};
}

function mapParams(input: unknown): Record<string, string> {
	if (!input || typeof input !== "object") {
		return {};
	}
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		output[key] = typeof value === "string" ? value : JSON.stringify(value);
	}
	return output;
}

function isAbortReason(reason?: string): boolean {
	const value = String(reason ?? "").toLowerCase();
	return (
		value.includes("cancel") ||
		value.includes("abort") ||
		value.includes("interrupt")
	);
}

function createPayloadBase(
	ctx: HookContextBase,
	options: HookRuntimeOptions,
): Omit<HookEventPayload, "hookName"> {
	const userId =
		process.env.CLINE_USER_ID?.trim() || process.env.USER?.trim() || "unknown";
	const sessionContext: HookSessionContext = {
		rootSessionId: options.rootSessionId || ctx.conversationId,
	};
	return {
		clineVersion: process.env.CLINE_VERSION?.trim() || "",
		timestamp: new Date().toISOString(),
		taskId: ctx.conversationId,
		sessionContext,
		workspaceRoots: options.workspacePath ? [options.workspacePath] : [],
		workspaceInfo: options.workspaceInfo,
		userId,
		...(options.model ? { model: options.model } : {}),
		agent_id: ctx.agentId,
		parent_agent_id: ctx.parentAgentId,
	} as Omit<HookEventPayload, "hookName">;
}

type HookCommand = { command: string[]; path: string };
type HookCommandMap = Partial<Record<HookEventName, HookCommand[]>>;

const HOOK_FILE_NAME_BY_EVENT = new Map<HookEventName, string>(
	Object.entries(HOOK_CONFIG_FILE_EVENT_MAP).flatMap(([fileName, event]) =>
		event ? [[event, fileName] as const] : [],
	),
);

export function hookFileNameForEvent(event: HookEventName): string {
	return HOOK_FILE_NAME_BY_EVENT.get(event) ?? event;
}

async function runHookCommand(
	payload: HookEventPayload,
	options: {
		command: string[];
		cwd: string;
		env?: NodeJS.ProcessEnv;
		detached: boolean;
		timeoutMs?: number;
		onDetachedSettled?: RunSubprocessEventOptions["onDetachedSettled"];
	},
): Promise<RunSubprocessEventResult | undefined> {
	if (options.command.length === 0) {
		throw new Error("runHookCommand requires non-empty command");
	}
	try {
		return await runSubprocessEvent(payload, options);
	} catch (error) {
		const fallbackCommand = getWindowsPythonFallbackCommand(
			options.command,
			process.platform,
			error,
		);
		if (!fallbackCommand) {
			throw error;
		}
		return await runSubprocessEvent(payload, {
			...options,
			command: fallbackCommand,
		});
	}
}

function parseShebangCommand(path: string): string[] | undefined {
	try {
		const content = readFileSync(path, "utf8");
		const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
		if (!firstLine?.startsWith("#!")) {
			return undefined;
		}
		const shebang = firstLine.slice(2).trim();
		if (!shebang) {
			return undefined;
		}
		const tokens = shebang.split(/\s+/).filter(Boolean);
		return tokens.length > 0 ? tokens : undefined;
	} catch {
		return undefined;
	}
}

function isMissingCommandError(error: unknown): boolean {
	return !!(
		error &&
		typeof error === "object" &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

export function getWindowsPythonFallbackCommand(
	command: string[],
	platform = process.platform,
	error?: unknown,
): string[] | undefined {
	if (platform !== "win32" || !isMissingCommandError(error)) {
		return undefined;
	}
	if (command[0] !== "py" || command[1] !== "-3") {
		return undefined;
	}
	return ["python", ...command.slice(2)];
}

function normalizeHookInterpreter(tokens: string[]): string[] | undefined {
	if (tokens.length === 0) {
		return undefined;
	}
	const [rawCommand, ...rest] = tokens;
	const normalizedCommand = rawCommand.replace(/\\/g, "/").toLowerCase();
	const commandName = normalizedCommand.split("/").at(-1) ?? normalizedCommand;

	if (commandName === "env") {
		return normalizeHookInterpreter(rest);
	}

	if (commandName === "bash" || commandName === "sh" || commandName === "zsh") {
		return [commandName, ...rest];
	}

	if (commandName === "python3" || commandName === "python") {
		return process.platform === "win32"
			? ["py", "-3", ...rest]
			: [commandName, ...rest];
	}

	return tokens;
}

function inferHookCommand(path: string): string[] {
	const shebang = parseShebangCommand(path);
	if (shebang && shebang.length > 0) {
		return [...(normalizeHookInterpreter(shebang) ?? shebang), path];
	}
	const lowered = path.toLowerCase();
	if (
		lowered.endsWith(".sh") ||
		lowered.endsWith(".bash") ||
		lowered.endsWith(".zsh")
	) {
		return ["bash", path];
	}
	if (
		lowered.endsWith(".js") ||
		lowered.endsWith(".mjs") ||
		lowered.endsWith(".cjs")
	) {
		return augmentNodeCommandForDebug(["node", path], {
			debugRole: "hook",
		});
	}
	if (
		lowered.endsWith(".ts") ||
		lowered.endsWith(".mts") ||
		lowered.endsWith(".cts")
	) {
		return ["bun", "run", path];
	}
	if (lowered.endsWith(".py")) {
		return process.platform === "win32"
			? ["py", "-3", path]
			: ["python3", path];
	}
	if (lowered.endsWith(".ps1")) {
		return [
			process.platform === "win32" ? "powershell" : "pwsh",
			"-File",
			path,
		];
	}
	// Default to bash for legacy hook files with no extension/shebang.
	return ["bash", path];
}

function createHookCommandMap(options: HookRuntimeOptions): HookCommandMap {
	const map: HookCommandMap = {};
	for (const file of listHookConfigFiles(options.workspacePath, {
		extraDirectories: options.extraHookDirs,
		requireExecutable: options.requireExecutable,
	})) {
		if (!file.hookEventName) {
			continue;
		}
		const hookEventName = file.hookEventName;
		const existing = map[hookEventName] ?? [];
		existing.push({ command: inferHookCommand(file.path), path: file.path });
		map[hookEventName] = existing;
	}
	return map;
}

async function runBlockingHookCommands(options: {
	commands: HookCommand[];
	payload: HookEventPayload;
	cwd: string;
	logger?: BasicLogger;
	timeoutMs?: number;
	onHookRun?: HookRunObserver;
	meta?: HookRunMeta;
}): Promise<HookCommandControl | undefined> {
	let merged: HookCommandControl | undefined;
	for (const { command, path } of options.commands) {
		const commandLabel = command.join(" ");
		const finish = reportHookRun(options.onHookRun, options.logger, {
			hookName: hookFileNameForEvent(options.payload.hookName),
			source: path,
			...options.meta,
		});
		try {
			const result = await runHookCommand(options.payload, {
				command,
				cwd: options.cwd,
				env: process.env,
				detached: false,
				timeoutMs: options.timeoutMs,
			});
			if (result?.timedOut) {
				logHookError(options.logger, `hook command timed out: ${commandLabel}`);
				finish("failed", "timed out");
				continue;
			}
			if (result?.parseError) {
				logHookError(
					options.logger,
					`hook command returned invalid JSON control output: ${commandLabel} (${result.parseError})`,
				);
				finish("failed", "invalid JSON output");
				continue;
			}
			const control = parseHookControl(result?.parsedJson);
			merged = mergeHookControls(merged, control);
			finish(control?.cancel === true ? "cancelled" : "completed");
		} catch (error) {
			logHookError(
				options.logger,
				`hook command failed: ${commandLabel}`,
				error,
			);
			finish("failed", error instanceof Error ? error.message : String(error));
		}
	}
	return merged;
}

async function runAsyncHookCommands(options: {
	commands: HookCommand[];
	payload: HookEventPayload;
	cwd: string;
	logger?: BasicLogger;
	detached: boolean;
	onHookRuntime?: HookRuntimeObserver;
	onHookRun?: HookRunObserver;
}): Promise<void> {
	const hookName = options.payload.hookName;
	const startReport = (path: string) =>
		reportHookRun(options.onHookRun, options.logger, {
			hookName: hookFileNameForEvent(hookName),
			source: path,
		});
	if (options.detached) {
		const observer = options.onHookRuntime;
		for (const { command, path } of options.commands) {
			const commandLabel = command.join(" ");
			const finish = startReport(path);
			void runHookCommand(options.payload, {
				command,
				cwd: options.cwd,
				env: process.env,
				detached: true,
				onDetachedSettled: (event) => {
					// A hook still running when observation ends stays "running".
					if (event.exited) {
						finish(event.exitCode === 0 ? "completed" : "failed");
					}
					observer?.({
						hookName,
						durationMs: event.durationMs,
						exitCode: event.exitCode,
						exited: event.exited,
					});
				},
			}).catch((error) => {
				logHookError(
					options.logger,
					`hook command failed: ${commandLabel}`,
					error,
				);
				finish(
					"failed",
					error instanceof Error ? error.message : String(error),
				);
			});
		}
		return;
	}
	await Promise.all(
		options.commands.map(async ({ command, path }) => {
			const commandLabel = command.join(" ");
			const finish = startReport(path);
			try {
				const result = await runHookCommand(options.payload, {
					command,
					cwd: options.cwd,
					env: process.env,
					detached: options.detached,
				});
				finish(result?.exitCode ? "failed" : "completed");
			} catch (error) {
				logHookError(
					options.logger,
					`hook command failed: ${commandLabel}`,
					error,
				);
				finish(
					"failed",
					error instanceof Error ? error.message : String(error),
				);
			}
		}),
	);
}

function baseContextFromSnapshot(
	snapshot: AgentRunLifecycleContext["snapshot"],
): HookContextBase {
	return {
		agentId: snapshot.agentId,
		conversationId:
			snapshot.conversationId ?? snapshot.runId ?? snapshot.agentId,
		parentAgentId: snapshot.parentAgentId ?? null,
	};
}

function runStartContext(
	ctx: AgentRunLifecycleContext,
	userMessage: string,
): HookCommandRunStartContext {
	return {
		...baseContextFromSnapshot(ctx.snapshot),
		userMessage,
	};
}

function toolCallStartContext(
	ctx: AgentBeforeToolContext,
): HookCommandToolCallStartContext {
	return {
		...baseContextFromSnapshot(ctx.snapshot),
		iteration: ctx.snapshot.iteration,
		call: {
			id: ctx.toolCall.toolCallId,
			name: ctx.toolCall.toolName,
			input: ctx.input,
		},
	};
}

function toolCallEndContext(
	ctx: AgentAfterToolContext,
): HookCommandToolCallEndContext {
	return {
		...baseContextFromSnapshot(ctx.snapshot),
		iteration: ctx.snapshot.iteration,
		record: {
			id: ctx.toolCall.toolCallId,
			name: ctx.toolCall.toolName,
			input: ctx.input,
			output: ctx.result.output,
			error: ctx.result.isError ? String(ctx.result.output) : undefined,
			durationMs: ctx.durationMs,
			startedAt: ctx.startedAt,
			endedAt: ctx.endedAt,
		},
	};
}

function textFromMessageContent(
	content: readonly { type: string; text?: string }[],
): string {
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

export function createHookAuditHooks(options: {
	rootSessionId?: string;
	workspacePath: string;
	workspaceInfo?: WorkspaceInfo;
}): AgentHooks {
	const runtimeOptions: HookRuntimeOptions = {
		cwd: options.workspacePath,
		workspacePath: options.workspacePath,
		rootSessionId: options.rootSessionId,
		workspaceInfo: options.workspaceInfo,
	};

	const append = (payload: HookEventPayload): void => {
		const line = `${JSON.stringify({
			ts: new Date().toISOString(),
			...payload,
		})}\n`;
		const envPath = process.env.CLINE_HOOKS_LOG_PATH?.trim() || undefined;
		const logPath = envPath ?? join(ensureHookLogDir(), "hooks.jsonl");
		ensureHookLogDir(logPath);
		appendFileSync(logPath, line, "utf8");
	};

	return {
		beforeRun: async (ctx: AgentRunLifecycleContext) => {
			const commandCtx = runStartContext(ctx, "");
			append({
				...createPayloadBase(commandCtx, runtimeOptions),
				hookName: "agent_start",
				taskStart: { taskMetadata: {} },
			});
			return undefined;
		},
		beforeTool: async (ctx: AgentBeforeToolContext) => {
			const commandCtx = toolCallStartContext(ctx);
			append({
				...createPayloadBase(commandCtx, runtimeOptions),
				hookName: "tool_call",
				iteration: commandCtx.iteration,
				tool_call: {
					id: commandCtx.call.id,
					name: commandCtx.call.name,
					input: commandCtx.call.input,
				},
				preToolUse: {
					toolName: commandCtx.call.name,
					parameters: mapParams(commandCtx.call.input),
				},
			});
			return undefined;
		},
		afterTool: async (ctx: AgentAfterToolContext) => {
			const commandCtx = toolCallEndContext(ctx);
			append({
				...createPayloadBase(commandCtx, runtimeOptions),
				hookName: "tool_result",
				iteration: commandCtx.iteration,
				tool_result: commandCtx.record,
				postToolUse: {
					toolName: commandCtx.record.name,
					parameters: mapParams(commandCtx.record.input),
					result:
						typeof commandCtx.record.output === "string"
							? commandCtx.record.output
							: JSON.stringify(commandCtx.record.output),
					success: !commandCtx.record.error,
					executionTimeMs: commandCtx.record.durationMs,
				},
			});
			return undefined;
		},
		afterRun: async ({ snapshot, result }) => {
			const base = baseContextFromSnapshot(snapshot);
			if (result.status === "completed") {
				append({
					...createPayloadBase(base, runtimeOptions),
					hookName: "agent_end",
					iteration: result.iterations,
					turn: { outputText: result.outputText, status: result.status },
					taskComplete: { taskMetadata: {} },
				});
				return;
			}
			if (result.status === "aborted" || isAbortReason(result.error?.message)) {
				append({
					...createPayloadBase(base, runtimeOptions),
					hookName: "agent_abort",
					reason: result.error?.message,
					taskCancel: { taskMetadata: {} },
				});
				return;
			}
			if (result.error) {
				append({
					...createPayloadBase(base, runtimeOptions),
					hookName: "agent_error",
					iteration: result.iterations,
					error: {
						name: result.error.name,
						message: result.error.message,
						stack: result.error.stack,
					},
				});
			}
		},
		onEvent: async (event: AgentRuntimeEvent) => {
			if (
				event.type !== "message-added" ||
				event.message.role !== "user" ||
				// Injected hook-context blocks are user-role messages with a
				// system display role; they are not user prompts.
				event.message.metadata?.displayRole === "system"
			) {
				return;
			}
			const commandCtx = runStartContext(
				{ snapshot: event.snapshot },
				textFromMessageContent(event.message.content),
			);
			append({
				...createPayloadBase(commandCtx, runtimeOptions),
				hookName: "prompt_submit",
				userPromptSubmit: {
					prompt: commandCtx.userMessage,
					attachments: [],
				},
			});
		},
	};
}

export interface CompactionHookInput {
	mode: CoreCompactionMode;
	agentId: string;
	conversationId: string;
	parentAgentId: string | null;
	tokensBefore?: number;
	strategy?: string;
}

/**
 * Hooks around context compaction. `afterCompact` returns context to add to
 * the compacted conversation.
 */
export interface CompactionHookRunner {
	beforeCompact(input: CompactionHookInput): Promise<void>;
	afterCompact(input: CompactionHookInput): Promise<string | undefined>;
}

export interface HookConfigFileRuntime {
	hooks: AgentHooks;
	compaction: CompactionHookRunner;
}

function latestUserPrompt(
	ctx: AgentRunLifecycleContext,
): AgentMessage | undefined {
	const messages =
		ctx.input && ctx.input.length > 0 ? ctx.input : ctx.snapshot.messages;
	const last = messages.at(-1);
	if (
		!last ||
		last.role !== "user" ||
		last.metadata?.displayRole === "system"
	) {
		return undefined;
	}
	return last;
}

/**
 * File hooks are discovered again at the start of every run, so a hook added
 * mid-session runs from the next run on.
 */
export function createHookConfigFileRuntime(
	options: HookRuntimeOptions,
): HookConfigFileRuntime {
	let commandMap = createHookCommandMap(options);
	const commandsFor = (event: HookEventName) => commandMap[event] ?? [];
	const timeoutMs = options.toolCallTimeoutMs ?? 120000;
	let firstRun = true;
	const submittedPromptIds = new Set<string>();
	const claude = new ClaudeHooks({
		workspacePath: options.workspacePath,
		cwd: options.cwd,
		extraHookDirs: options.extraHookDirs,
		sessionId: options.rootSessionId ?? "",
		mode: options.mode,
		timeoutMs,
		logger: options.logger,
		onHookRun: options.onHookRun,
	});

	const runAsync = (event: HookEventName, payload: HookEventPayload) =>
		runAsyncHookCommands({
			commands: commandsFor(event),
			cwd: options.cwd,
			logger: options.logger,
			detached: options.detachAsyncHooks ?? true,
			onHookRuntime: options.onHookRuntime,
			onHookRun: options.onHookRun,
			payload,
		});
	const runBlocking = (
		event: HookEventName,
		payload: HookEventPayload,
		meta?: HookRunMeta,
	) =>
		runBlockingHookCommands({
			commands: commandsFor(event),
			cwd: options.cwd,
			logger: options.logger,
			timeoutMs,
			onHookRun: options.onHookRun,
			meta,
			payload,
		});

	// With blockingRunStartHooks, run-start hooks execute blocking so their
	// output is collected: like the tool hooks, they may cancel the run or
	// inject context, neither of which is possible from a detached spawn with
	// ignored stdio. The default stays fire-and-forget so existing
	// long-running run-start scripts don't stall every run until the timeout.
	const runAgentStart = async (
		ctx: HookContextBase,
		hookName: "agent_start" | "agent_resume",
	): Promise<HookCommandControl | undefined> => {
		if (commandsFor(hookName).length === 0) {
			return undefined;
		}
		const payload: HookEventPayload =
			hookName === "agent_resume"
				? {
						...createPayloadBase(ctx, options),
						hookName,
						taskResume: {
							taskMetadata: {},
							previousState: {},
						},
					}
				: {
						...createPayloadBase(ctx, options),
						hookName,
						taskStart: { taskMetadata: {} },
					};
		if (!options.blockingRunStartHooks) {
			await runAsync(hookName, payload);
			return undefined;
		}
		return runBlocking(hookName, payload);
	};

	const runPromptSubmit = async (
		ctx: HookCommandRunStartContext,
		blocking: boolean,
	): Promise<HookCommandControl | undefined> => {
		if (commandsFor("prompt_submit").length === 0) {
			return undefined;
		}
		const payload: HookEventPayload = {
			...createPayloadBase(ctx, options),
			hookName: "prompt_submit",
			userPromptSubmit: {
				prompt: ctx.userMessage,
				attachments: [],
			},
		};
		if (!blocking) {
			await runAsync("prompt_submit", payload);
			return undefined;
		}
		return runBlocking("prompt_submit", payload);
	};

	const hooks: AgentHooks = {
		beforeRun: async (ctx: AgentRunLifecycleContext) => {
			// A subagent's task is not a user prompt, and its run is not a
			// session start; its tool calls still run the tool hooks.
			if (ctx.snapshot.parentAgentId) {
				return undefined;
			}
			commandMap = createHookCommandMap(options);
			claude.reload();
			const base = baseContextFromSnapshot(ctx.snapshot);
			let control: HookCommandControl | undefined;
			if (firstRun) {
				firstRun = false;
				const lifecycle =
					options.lifecycle ??
					(ctx.snapshot.messages.some((message) => message.role === "assistant")
						? "resume"
						: "startup");
				if (lifecycle !== "none") {
					control = await runAgentStart(
						base,
						lifecycle === "resume" ? "agent_resume" : "agent_start",
					);
					if (control?.cancel === true) {
						return runStartResultFromControl(control);
					}
					const sessionContext = await claude.sessionStart(
						lifecycle === "resume" ? "resume" : "startup",
					);
					control = mergeHookControls(
						control,
						sessionContext ? { context: sessionContext } : undefined,
					);
				}
			}
			// The prompt is either the run's input (a directly driven runtime)
			// or already the last message (sessions seed it into the initial
			// messages and run with empty input).
			const prompt = latestUserPrompt(ctx);
			if (prompt && !submittedPromptIds.has(prompt.id)) {
				submittedPromptIds.add(prompt.id);
				const text = textFromMessageContent(prompt.content);
				control = mergeHookControls(
					control,
					await runPromptSubmit({ ...base, userMessage: text }, true),
				);
				control = mergeHookControls(
					control,
					await claude.userPromptSubmit(text),
				);
			}
			return runStartResultFromControl(control);
		},
		// Prompts added during a run, such as queued user messages. There is no
		// result channel here, so these hooks only observe.
		onEvent: async (event: AgentRuntimeEvent) => {
			if (
				event.type !== "message-added" ||
				event.message.role !== "user" ||
				// Injected hook-context blocks are user-role messages with a
				// system display role; they are not user prompts.
				event.message.metadata?.displayRole === "system" ||
				event.snapshot.parentAgentId ||
				submittedPromptIds.has(event.message.id)
			) {
				return;
			}
			submittedPromptIds.add(event.message.id);
			const text = textFromMessageContent(event.message.content);
			void claude.userPromptSubmit(text);
			await runPromptSubmit(
				runStartContext({ snapshot: event.snapshot }, text),
				false,
			);
		},
		beforeTool: async (ctx: AgentBeforeToolContext) => {
			const call = toolCallStartContext(ctx);
			const native = await runBlocking(
				"tool_call",
				{
					...createPayloadBase(call, options),
					hookName: "tool_call",
					iteration: call.iteration,
					tool_call: {
						id: call.call.id,
						name: call.call.name,
						input: call.call.input,
					},
					preToolUse: {
						toolName: call.call.name,
						parameters: mapParams(call.call.input),
					},
				},
				{ toolName: call.call.name, toolCallId: call.call.id },
			);
			if (native?.cancel === true || native?.deny === true) {
				return beforeToolResultFromControl(native);
			}
			// hooks.json hooks see the input as the native hooks left it.
			const control = mergeHookControls(
				native,
				await claude.preToolUse(
					call.call.name,
					call.call.id,
					native?.overrideInput ?? call.call.input,
				),
			);
			return beforeToolResultFromControl(control);
		},
		afterTool: async (ctx: AgentAfterToolContext) => {
			const end = toolCallEndContext(ctx);
			const native = await runBlocking(
				"tool_result",
				{
					...createPayloadBase(end, options),
					hookName: "tool_result",
					iteration: end.iteration,
					tool_result: end.record,
					postToolUse: {
						toolName: end.record.name,
						parameters: mapParams(end.record.input),
						result:
							typeof end.record.output === "string"
								? end.record.output
								: JSON.stringify(end.record.output),
						success: !end.record.error,
						executionTimeMs: end.record.durationMs,
					},
				},
				{ toolName: end.record.name, toolCallId: end.record.id },
			);
			const control = mergeHookControls(
				native,
				await claude.postToolUse(
					end.record.name,
					end.record.id,
					end.record.input,
					end.record.output,
				),
			);
			return afterToolResultFromControl(control);
		},
		afterRun: async ({ snapshot, result }) => {
			if (snapshot.parentAgentId) {
				return;
			}
			const base = baseContextFromSnapshot(snapshot);
			if (result.status === "completed") {
				await runAsync("agent_end", {
					...createPayloadBase(base, options),
					hookName: "agent_end",
					iteration: result.iterations,
					turn: {
						outputText: result.outputText,
						status: result.status,
					},
					taskComplete: { taskMetadata: {} },
				});
				return;
			}
			if (result.status === "aborted" || isAbortReason(result.error?.message)) {
				await runAsync("agent_abort", {
					...createPayloadBase(base, options),
					hookName: "agent_abort",
					reason: result.error?.message,
					taskCancel: { taskMetadata: {} },
				});
				await runAsync("session_shutdown", {
					...createPayloadBase(base, options),
					hookName: "session_shutdown",
					reason: result.error?.message,
				});
				return;
			}
			if (result.error) {
				await runAsync("agent_error", {
					...createPayloadBase(base, options),
					hookName: "agent_error",
					iteration: result.iterations,
					error: {
						name: result.error.name,
						message: result.error.message,
						stack: result.error.stack,
					},
				});
			}
		},
	};

	const compaction: CompactionHookRunner = {
		// PreCompact runs blocking so it finishes before the conversation is
		// rewritten; like Claude Code's, it cannot stop the compaction.
		beforeCompact: async (input) => {
			await claude.preCompact(input.mode === "manual" ? "manual" : "auto");
			if (commandsFor("pre_compact").length === 0) {
				return;
			}
			await runBlocking("pre_compact", {
				...createPayloadBase(input, options),
				hookName: "pre_compact",
				preCompact: {
					taskId: input.conversationId,
					ulid: "",
					contextSize: input.tokensBefore ?? 0,
					compactionStrategy: input.strategy ?? "",
					previousApiReqIndex: 0,
					tokensIn: 0,
					tokensOut: 0,
					tokensInCache: 0,
					tokensOutCache: 0,
					deletedRangeStart: 0,
					deletedRangeEnd: 0,
					contextJsonPath: "",
					contextRawPath: "",
					trigger: input.mode === "manual" ? "manual" : "auto",
				},
			});
		},
		afterCompact: () => claude.sessionStart("compact"),
	};

	return { hooks, compaction };
}

export function createHookConfigFileHooks(
	options: HookRuntimeOptions,
): AgentHooks {
	return createHookConfigFileRuntime(options).hooks;
}

export function createHookConfigFileExtension(
	options: HookRuntimeOptions,
): AgentExtension | undefined {
	return createAgentHooksExtension(
		"core.hook_config_files",
		createHookConfigFileHooks(options),
	);
}

function mergeHookFunction<K extends keyof AgentHooks>(
	layers: AgentHooks[],
	key: K,
): AgentHooks[K] | undefined {
	const handlers = layers
		.map((layer) => layer[key])
		.filter((handler) => typeof handler === "function");
	if (handlers.length === 0) {
		return undefined;
	}
	return (async (ctx: unknown) => {
		let merged: Record<string, unknown> | undefined;
		for (const handler of handlers) {
			const next = await (handler as (arg: unknown) => unknown)(ctx);
			if (!next || typeof next !== "object") {
				continue;
			}
			const record = next as Record<string, unknown>;
			const appendContexts = [merged?.appendContext, record.appendContext]
				.filter(
					(value): value is string =>
						typeof value === "string" && value.length > 0,
				)
				.join("\n\n");
			const policy =
				merged?.policy || record.policy
					? {
							...((merged?.policy as Record<string, unknown> | undefined) ??
								{}),
							...((record.policy as Record<string, unknown> | undefined) ?? {}),
						}
					: undefined;
			// A stopping or skipping layer ends the merge: later layers' hooks
			// are not run for a turn that is already cancelled or a tool call
			// that will not run (each is a blocking subprocess with its own
			// timeout budget).
			if (record.stop === true || record.skip === true) {
				return {
					...(merged ?? {}),
					...record,
					appendContext: appendContexts || undefined,
					...(policy ? { policy } : {}),
				};
			}
			merged = {
				...(merged ?? {}),
				...record,
				stop:
					merged?.stop === true || record.stop === true ? true : record.stop,
				appendContext: appendContexts || undefined,
				...(policy ? { policy } : {}),
				options:
					merged?.options || record.options
						? {
								...((merged?.options as Record<string, unknown> | undefined) ??
									{}),
								...((record.options as Record<string, unknown> | undefined) ??
									{}),
							}
						: undefined,
			};
		}
		return merged;
	}) as AgentHooks[K];
}

export function mergeAgentHooks(
	layers: Array<AgentHooks | undefined>,
): AgentHooks | undefined {
	const activeLayers = layers.filter(
		(layer): layer is AgentHooks => layer !== undefined,
	);
	if (activeLayers.length === 0) {
		return undefined;
	}

	return {
		beforeRun: mergeHookFunction(activeLayers, "beforeRun"),
		afterRun: mergeHookFunction(activeLayers, "afterRun"),
		beforeModel: mergeHookFunction(activeLayers, "beforeModel"),
		afterModel: mergeHookFunction(activeLayers, "afterModel"),
		beforeTool: mergeHookFunction(activeLayers, "beforeTool"),
		afterTool: mergeHookFunction(activeLayers, "afterTool"),
		onEvent: mergeHookFunction(activeLayers, "onEvent"),
	};
}
