import { readFileSync } from "node:fs";
import type { BasicLogger } from "@cline/shared";
import { type ClaudeToolView, claudeToolView } from "./claude-tool-adapters";
import {
	type HookCommandControl,
	type HookRunMeta,
	type HookRunObserver,
	logHookError,
	mergeHookControls,
	parseHookControl,
	reportHookRun,
} from "./hook-control";
import { listClaudeHookConfigFiles } from "./hook-file-config";
import { truncateHookContext } from "./subprocess";
import { runSubprocessEvent } from "./subprocess-runner";

const SUPPORTED_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"SessionStart",
	"PreCompact",
] as const;
type ClaudeHookEvent = (typeof SUPPORTED_EVENTS)[number];

interface ClaudeHookCommand {
	command: string;
	timeoutMs?: number;
}

interface ClaudeHookMatcher {
	/** Undefined matches everything. */
	pattern?: RegExp;
	commands: ClaudeHookCommand[];
}

type ClaudeHookSet = Partial<Record<ClaudeHookEvent, ClaudeHookMatcher[]>>;

type JsonRecord = Record<string, unknown>;

const warned = new Set<string>();

function warnOnce(
	logger: BasicLogger | undefined,
	key: string,
	message: string,
): void {
	if (warned.has(key)) return;
	warned.add(key);
	logHookError(logger, message);
}

function isRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function compileMatcher(
	matcher: unknown,
	file: string,
	logger: BasicLogger | undefined,
): RegExp | undefined | null {
	if (matcher === undefined || matcher === "" || matcher === "*") {
		return undefined;
	}
	if (typeof matcher !== "string") {
		warnOnce(
			logger,
			`${file}:${String(matcher)}`,
			`${file}: matcher must be a string`,
		);
		return null;
	}
	try {
		return new RegExp(matcher);
	} catch {
		warnOnce(
			logger,
			`${file}:${matcher}`,
			`${file}: invalid matcher ${matcher}`,
		);
		return null;
	}
}

function parseCommands(hooks: unknown): ClaudeHookCommand[] {
	if (!Array.isArray(hooks)) return [];
	return hooks.flatMap((hook) =>
		isRecord(hook) &&
		hook.type === "command" &&
		typeof hook.command === "string"
			? [
					{
						command: hook.command,
						...(typeof hook.timeout === "number" && hook.timeout > 0
							? { timeoutMs: hook.timeout * 1000 }
							: {}),
					},
				]
			: [],
	);
}

/** Reads every hooks.json; a broken file is reported once and skipped. */
function loadClaudeHooks(
	files: readonly string[],
	logger: BasicLogger | undefined,
): ClaudeHookSet {
	const set: ClaudeHookSet = {};
	for (const file of files) {
		let config: unknown;
		try {
			config = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			warnOnce(logger, file, `${file}: not valid JSON (${String(error)})`);
			continue;
		}
		const hooks = isRecord(config) ? config.hooks : undefined;
		if (!isRecord(hooks)) continue;
		for (const [event, entries] of Object.entries(hooks)) {
			if (!(SUPPORTED_EVENTS as readonly string[]).includes(event)) {
				warnOnce(
					logger,
					`${file}:${event}`,
					`${file}: hook event ${event} is not supported and is ignored`,
				);
				continue;
			}
			if (!Array.isArray(entries)) continue;
			for (const entry of entries) {
				if (!isRecord(entry)) continue;
				const pattern = compileMatcher(entry.matcher, file, logger);
				const commands = parseCommands(entry.hooks);
				if (pattern === null || commands.length === 0) continue;
				const list = set[event as ClaudeHookEvent] ?? [];
				list.push({ pattern, commands });
				set[event as ClaudeHookEvent] = list;
			}
		}
	}
	return set;
}

function shellCommand(command: string): string[] {
	return process.platform === "win32"
		? ["cmd.exe", "/d", "/s", "/c", command]
		: ["/bin/sh", "-c", command];
}

export interface ClaudeHooksOptions {
	workspacePath: string;
	cwd: string;
	extraHookDirs?: readonly string[];
	sessionId: string;
	/** Cline mode, shown to hooks as Claude Code's `permission_mode`. */
	mode?: string;
	timeoutMs: number;
	logger?: BasicLogger;
	onHookRun?: HookRunObserver;
}

/**
 * Runs the hooks in `hooks.json` files, which use Claude Code's settings
 * format, input and output. Only the events in `SUPPORTED_EVENTS` run.
 */
export class ClaudeHooks {
	private hooks: ClaudeHookSet = {};
	/**
	 * Each call's view as it was about to run, so PostToolUse names it the
	 * same way even when running it changed the answer (a file `Write`
	 * created now exists, which would make it an `editor` call).
	 */
	private readonly callViews = new Map<string, ClaudeToolView>();

	constructor(private readonly options: ClaudeHooksOptions) {
		this.reload();
	}

	reload(): void {
		this.callViews.clear();
		this.hooks = loadClaudeHooks(
			listClaudeHookConfigFiles(
				this.options.workspacePath,
				this.options.extraHookDirs,
			),
			this.options.logger,
		);
	}

	private commandsFor(
		event: ClaudeHookEvent,
		targets: readonly string[],
	): ClaudeHookCommand[] {
		return (this.hooks[event] ?? [])
			.filter(
				(matcher) =>
					!matcher.pattern ||
					targets.some((target) => matcher.pattern?.test(target)),
			)
			.flatMap((matcher) => matcher.commands);
	}

	private baseInput(event: ClaudeHookEvent): JsonRecord {
		const mode = this.options.mode;
		return {
			session_id: this.options.sessionId,
			cwd: this.options.cwd,
			hook_event_name: event,
			permission_mode:
				mode === "plan"
					? "plan"
					: mode === "yolo"
						? "bypassPermissions"
						: "default",
		};
	}

	private async runOne(
		event: ClaudeHookEvent,
		hook: ClaudeHookCommand,
		input: JsonRecord,
		textIsContext: boolean,
		meta?: HookRunMeta,
	): Promise<HookCommandControl | undefined> {
		const { logger } = this.options;
		const finish = reportHookRun(this.options.onHookRun, logger, {
			hookName: event,
			source: hook.command,
			...meta,
		});
		try {
			const result = await runSubprocessEvent(input, {
				command: shellCommand(hook.command),
				cwd: this.options.cwd,
				env: { ...process.env, CLAUDE_PROJECT_DIR: this.options.workspacePath },
				timeoutMs: hook.timeoutMs ?? this.options.timeoutMs,
			});
			if (!result || result.timedOut) {
				logHookError(logger, `${event} hook timed out: ${hook.command}`);
				finish("failed", "timed out");
				return undefined;
			}
			// Exit code 2 is Claude Code's "block": stderr is the reason.
			if (result.exitCode === 2) {
				finish("cancelled");
				return {
					deny: true,
					denyReason: result.stderr.trim() || `Blocked by a ${event} hook`,
				};
			}
			if (result.exitCode !== 0) {
				logHookError(
					logger,
					`${event} hook exited with ${result.exitCode}: ${hook.command}${result.stderr.trim() ? ` (${result.stderr.trim()})` : ""}`,
				);
				finish("failed", `exit code ${result.exitCode}`);
				return undefined;
			}
			finish("completed");
			if (result.parsedJson !== undefined) {
				return parseHookControl(result.parsedJson);
			}
			const stdout = result.stdout.trim();
			return textIsContext && stdout
				? { context: truncateHookContext(stdout) }
				: undefined;
		} catch (error) {
			logHookError(logger, `${event} hook failed: ${hook.command}`, error);
			finish("failed", error instanceof Error ? error.message : String(error));
			return undefined;
		}
	}

	private async runAll(
		event: ClaudeHookEvent,
		commands: readonly ClaudeHookCommand[],
		input: JsonRecord,
		textIsContext: boolean,
		meta?: HookRunMeta,
	): Promise<HookCommandControl | undefined> {
		const controls = await Promise.all(
			commands.map((hook) =>
				this.runOne(event, hook, input, textIsContext, meta),
			),
		);
		return controls.reduce<HookCommandControl | undefined>(
			(merged, control) => mergeHookControls(merged, control),
			undefined,
		);
	}

	/** SessionStart only adds context, as in Claude Code. */
	async sessionStart(
		source: "startup" | "resume" | "compact",
	): Promise<string | undefined> {
		const commands = this.commandsFor("SessionStart", [source]);
		if (commands.length === 0) return undefined;
		const control = await this.runAll(
			"SessionStart",
			commands,
			{ ...this.baseInput("SessionStart"), source },
			true,
		);
		return control?.context;
	}

	async userPromptSubmit(
		prompt: string,
	): Promise<HookCommandControl | undefined> {
		const commands = this.commandsFor("UserPromptSubmit", []);
		if (commands.length === 0) return undefined;
		return this.runAll(
			"UserPromptSubmit",
			commands,
			{ ...this.baseInput("UserPromptSubmit"), prompt },
			true,
		);
	}

	/** PreCompact cannot stop the compaction; its output is ignored. */
	async preCompact(trigger: "manual" | "auto"): Promise<void> {
		const commands = this.commandsFor("PreCompact", [trigger]);
		if (commands.length === 0) return;
		await this.runAll(
			"PreCompact",
			commands,
			{ ...this.baseInput("PreCompact"), trigger, custom_instructions: "" },
			false,
		);
	}

	/**
	 * Runs PreToolUse once per item of the call. Any deny blocks the whole
	 * call; each `updatedInput` replaces only its own item, and the result's
	 * `overrideInput` is the rebuilt Cline input.
	 */
	async preToolUse(
		toolName: string,
		toolCallId: string,
		input: unknown,
	): Promise<HookCommandControl | undefined> {
		const view = claudeToolView(toolName, input, this.options.cwd);
		this.callViews.set(toolCallId, view);
		const commands = this.commandsFor("PreToolUse", [view.name, toolName]);
		if (commands.length === 0) return undefined;
		const controls = await Promise.all(
			view.inputs.map((toolInput, index) =>
				this.runAll(
					"PreToolUse",
					commands,
					{
						...this.baseInput("PreToolUse"),
						tool_name: view.name,
						tool_input: toolInput,
						tool_use_id: toolCallId,
					},
					false,
					{
						toolName,
						toolCallId,
						...(view.inputs.length > 1 ? { itemIndex: index } : {}),
					},
				),
			),
		);
		const updates = new Map<number, JsonRecord>();
		let merged: HookCommandControl | undefined;
		controls.forEach((control, index) => {
			if (!control) return;
			const { overrideInput, ...rest } = control;
			if (isRecord(overrideInput)) updates.set(index, overrideInput);
			merged = mergeHookControls(merged, rest);
		});
		if (updates.size > 0 && merged?.deny !== true) {
			const overrideInput = view.withUpdates(updates);
			this.callViews.set(
				toolCallId,
				claudeToolView(toolName, overrideInput, this.options.cwd),
			);
			merged = { ...merged, overrideInput };
		}
		return merged;
	}

	async postToolUse(
		toolName: string,
		toolCallId: string,
		input: unknown,
		output: unknown,
	): Promise<HookCommandControl | undefined> {
		const view =
			this.callViews.get(toolCallId) ??
			claudeToolView(toolName, input, this.options.cwd);
		this.callViews.delete(toolCallId);
		const commands = this.commandsFor("PostToolUse", [view.name, toolName]);
		if (commands.length === 0) return undefined;
		const controls = await Promise.all(
			view.inputs.map((toolInput, index) =>
				this.runAll(
					"PostToolUse",
					commands,
					{
						...this.baseInput("PostToolUse"),
						tool_name: view.name,
						tool_input: toolInput,
						tool_response: view.response(output, index),
						tool_use_id: toolCallId,
					},
					false,
					{
						toolName,
						toolCallId,
						...(view.inputs.length > 1 ? { itemIndex: index } : {}),
					},
				),
			),
		);
		return controls.reduce<HookCommandControl | undefined>(
			(merged, control) => mergeHookControls(merged, control),
			undefined,
		);
	}
}
