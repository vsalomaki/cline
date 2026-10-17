import { resolveHooksConfigSearchPaths, toHookConfigFileName } from "@cline/core"
import { HookInfo, WorkspaceHooks } from "@shared/proto/cline/file"
import fs from "fs/promises"
import path from "path"
import { getDocumentsPath } from "@/core/storage/documents-path"
import { VALID_HOOK_TYPES } from "./utils"

/** Claude Code–style hook configuration file; listed, but not toggled. */
export const CLAUDE_HOOKS_FILE = "hooks.json"

async function isExecutable(filePath: string): Promise<boolean> {
	if (process.platform === "win32") {
		return true
	}
	try {
		await fs.access(filePath, fs.constants.X_OK)
		return true
	} catch {
		return false
	}
}

async function listDirectory(directory: string): Promise<HookInfo[]> {
	let entries: import("fs").Dirent[]
	try {
		entries = await fs.readdir(directory, { withFileTypes: true })
	} catch {
		return []
	}
	const hooks: HookInfo[] = []
	for (const entry of entries) {
		if (!entry.isFile() || (entry.name !== CLAUDE_HOOKS_FILE && !toHookConfigFileName(entry.name))) {
			continue
		}
		const absolutePath = path.join(directory, entry.name)
		hooks.push(
			HookInfo.create({
				name: entry.name,
				enabled: entry.name === CLAUDE_HOOKS_FILE || (await isExecutable(absolutePath)),
				absolutePath,
			}),
		)
	}
	return hooks.sort((a, b) => a.name.localeCompare(b.name))
}

let documentsHooksDir: Promise<string> | undefined

/**
 * `~/Documents/Cline/Hooks` with Documents as the OS reports it, which can
 * differ from `~/Documents`. Looking it up starts a process, so it is cached.
 */
export function documentsHooksDirectory(): Promise<string> {
	documentsHooksDir ??= getDocumentsPath().then((documents) => path.join(documents, "Cline", "Hooks"))
	return documentsHooksDir
}

/** The SDK's global hook directories, plus Documents as the OS reports it. */
async function globalHookDirectories(): Promise<string[]> {
	const sdkGlobal = resolveHooksConfigSearchPaths()
	return [...new Set([...sdkGlobal, await documentsHooksDirectory()].map((directory) => path.resolve(directory)))]
}

function workspaceHookDirectories(workspacePath: string): string[] {
	return [path.join(workspacePath, ".clinerules", "hooks"), path.join(workspacePath, ".cline", "hooks")]
}

async function listDirectories(directories: readonly string[]): Promise<HookInfo[]> {
	return (await Promise.all(directories.map(listDirectory))).flat()
}

/** The hook files the SDK engine runs, grouped the way the hooks tab shows them. */
export async function listSdkHooks(
	workspacePaths: readonly string[],
	globalHooksDirOverride?: string,
): Promise<{ globalHooks: HookInfo[]; workspaceHooks: WorkspaceHooks[] }> {
	const globalHooks = await listDirectories(globalHooksDirOverride ? [globalHooksDirOverride] : await globalHookDirectories())
	const workspaceHooks = await Promise.all(
		workspacePaths.map(async (workspacePath) =>
			WorkspaceHooks.create({
				workspaceName: path.basename(workspacePath),
				hooks: await listDirectories(workspaceHookDirectories(workspacePath)),
			}),
		),
	)
	return { globalHooks, workspaceHooks }
}

/** A name either engine runs: the SDK's, or a legacy one such as `Notification`. */
function isHookFileName(name: string): boolean {
	return (
		name === CLAUDE_HOOKS_FILE ||
		toHookConfigFileName(name) !== undefined ||
		(VALID_HOOK_TYPES as readonly string[]).includes(name.replace(/\.ps1$/i, ""))
	)
}

/**
 * The hook file a toggle or delete request names, checked to be a file
 * directly inside one of the hook directories.
 */
export async function resolveRequestedHookFile(
	absolutePath: string,
	workspacePaths: readonly string[],
	globalHooksDirOverride?: string,
): Promise<string> {
	const resolved = path.resolve(absolutePath)
	const directories = new Set(
		[
			...(globalHooksDirOverride ? [globalHooksDirOverride] : await globalHookDirectories()),
			...workspacePaths.flatMap(workspaceHookDirectories),
		].map((directory) => path.resolve(directory)),
	)
	const name = path.basename(resolved)
	if (!directories.has(path.dirname(resolved)) || !isHookFileName(name)) {
		throw new Error(`${absolutePath} is not a hook file`)
	}
	return resolved
}
