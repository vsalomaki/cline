import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import {
	HOOKS_CONFIG_DIRECTORY_NAME,
	resolveHooksConfigSearchPaths as resolveHooksConfigSearchPathsFromShared,
} from "@cline/shared/storage";
import type { HookEventName } from "./subprocess";

export { HOOKS_CONFIG_DIRECTORY_NAME };

export function resolveHooksConfigSearchPaths(
	workspacePath?: string,
): string[] {
	return resolveHooksConfigSearchPathsFromShared(workspacePath);
}

export enum HookConfigFileName {
	TaskStart = "TaskStart",
	TaskResume = "TaskResume",
	TaskCancel = "TaskCancel",
	TaskComplete = "TaskComplete",
	TaskError = "TaskError",
	PreToolUse = "PreToolUse",
	PostToolUse = "PostToolUse",
	UserPromptSubmit = "UserPromptSubmit",
	PreCompact = "PreCompact",
	SessionShutdown = "SessionShutdown",
}

export const HOOK_CONFIG_FILE_EVENT_MAP: Readonly<
	Record<HookConfigFileName, HookEventName | undefined>
> = {
	[HookConfigFileName.TaskStart]: "agent_start",
	[HookConfigFileName.TaskResume]: "agent_resume",
	[HookConfigFileName.TaskCancel]: "agent_abort",
	[HookConfigFileName.TaskComplete]: "agent_end",
	[HookConfigFileName.TaskError]: "agent_error",
	[HookConfigFileName.PreToolUse]: "tool_call",
	[HookConfigFileName.PostToolUse]: "tool_result",
	[HookConfigFileName.UserPromptSubmit]: "prompt_submit",
	[HookConfigFileName.PreCompact]: "pre_compact",
	[HookConfigFileName.SessionShutdown]: "session_shutdown",
};

const HOOK_CONFIG_FILE_LOOKUP = new Map<string, HookConfigFileName>(
	Object.values(HookConfigFileName).map((name) => [name.toLowerCase(), name]),
);

const SUPPORTED_HOOK_FILE_EXTENSIONS = new Set([
	"",
	".sh",
	".bash",
	".zsh",
	".js",
	".mjs",
	".cjs",
	".ts",
	".mts",
	".cts",
	".py",
	".ps1",
]);

export function toHookConfigFileName(
	fileName: string,
): HookConfigFileName | undefined {
	const extension = extname(fileName).toLowerCase();
	if (!SUPPORTED_HOOK_FILE_EXTENSIONS.has(extension)) {
		return undefined;
	}
	const key = basename(fileName, extension).trim().toLowerCase();
	return HOOK_CONFIG_FILE_LOOKUP.get(key);
}

export interface HookConfigFileEntry {
	fileName: HookConfigFileName;
	hookEventName?: HookEventName;
	path: string;
}

export interface ListHookConfigFilesOptions {
	/** Searched after the standard directories, such as other workspace roots. */
	extraDirectories?: readonly string[];
	/**
	 * Skip files without the executable bit (not on Windows). Lets a host
	 * disable a hook by clearing that bit.
	 */
	requireExecutable?: boolean;
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Claude Code–style hook configuration, one per hook directory. */
export const CLAUDE_HOOKS_CONFIG_FILE_NAME = "hooks.json";

function hookDirectories(
	workspacePath: string | undefined,
	extraDirectories: readonly string[] | undefined,
): string[] {
	// Resolved before de-duplication: the same directory spelled two ways
	// would otherwise run its hooks twice.
	return [
		...new Set(
			[
				...resolveHooksConfigSearchPaths(workspacePath),
				...(extraDirectories ?? []),
			].map((directory) => resolve(directory)),
		),
	].filter((directory) => existsSync(directory));
}

export function listClaudeHookConfigFiles(
	workspacePath?: string,
	extraDirectories?: readonly string[],
): string[] {
	return hookDirectories(workspacePath, extraDirectories)
		.map((directory) => join(directory, CLAUDE_HOOKS_CONFIG_FILE_NAME))
		.filter((path) => existsSync(path));
}

export function listHookConfigFiles(
	workspacePath?: string,
	options: ListHookConfigFilesOptions = {},
): HookConfigFileEntry[] {
	const entries: HookConfigFileEntry[] = [];
	const seen = new Set<string>();
	const directories = hookDirectories(workspacePath, options.extraDirectories);
	const requireExecutable =
		options.requireExecutable === true && process.platform !== "win32";

	for (const directory of directories) {
		try {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (!entry.isFile()) {
					continue;
				}
				const fileName = toHookConfigFileName(entry.name);
				if (!fileName) {
					continue;
				}
				const path = join(directory, entry.name);
				if (seen.has(path) || (requireExecutable && !isExecutable(path))) {
					continue;
				}
				seen.add(path);
				entries.push({
					fileName,
					hookEventName: HOOK_CONFIG_FILE_EVENT_MAP[fileName],
					path,
				});
			}
		} catch {
			// Best-effort listing across config roots.
		}
	}

	return entries.sort((a, b) => a.path.localeCompare(b.path));
}
