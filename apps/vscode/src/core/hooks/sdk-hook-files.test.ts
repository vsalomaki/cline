import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { listSdkHooks, resolveRequestedHookFile } from "./sdk-hook-files"

describe("SDK hook files", () => {
	let root: string
	let globalDir: string
	let workspace: string

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-hook-files-"))
		globalDir = path.join(root, "global")
		workspace = path.join(root, "project")
		await fs.mkdir(globalDir, { recursive: true })
		await fs.mkdir(path.join(workspace, ".clinerules", "hooks"), { recursive: true })
		await fs.mkdir(path.join(workspace, ".cline", "hooks"), { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("lists every hook file the SDK runs, including hooks.json", async () => {
		await fs.writeFile(path.join(globalDir, "TaskStart"), "", { mode: 0o755 })
		await fs.writeFile(path.join(globalDir, "notes.txt"), "")
		await fs.writeFile(path.join(workspace, ".clinerules", "hooks", "PreToolUse.py"), "", { mode: 0o644 })
		await fs.writeFile(path.join(workspace, ".cline", "hooks", "hooks.json"), "{}")

		const { globalHooks, workspaceHooks } = await listSdkHooks([workspace], globalDir)

		expect(globalHooks.map((hook) => hook.name)).toEqual(["TaskStart"])
		expect(workspaceHooks).toHaveLength(1)
		const byName = Object.fromEntries(workspaceHooks[0].hooks.map((hook) => [hook.name, hook]))
		expect(Object.keys(byName).sort()).toEqual(["PreToolUse.py", "hooks.json"])
		expect(byName["hooks.json"].enabled).toBe(true)
		if (process.platform !== "win32") {
			expect(byName["PreToolUse.py"].enabled).toBe(false)
		}
	})

	it("accepts only hook files directly inside a hook directory", async () => {
		const hook = path.join(workspace, ".cline", "hooks", "PreToolUse.sh")
		await expect(resolveRequestedHookFile(hook, [workspace], globalDir)).resolves.toBe(hook)
		const legacy = path.join(globalDir, "Notification")
		await expect(resolveRequestedHookFile(legacy, [workspace], globalDir)).resolves.toBe(legacy)
		await expect(
			resolveRequestedHookFile(path.join(workspace, ".cline", "hooks", "..", "secret.sh"), [workspace], globalDir),
		).rejects.toThrow("is not a hook file")
		await expect(resolveRequestedHookFile(path.join(workspace, "PreToolUse.sh"), [workspace], globalDir)).rejects.toThrow(
			"is not a hook file",
		)
		await expect(
			resolveRequestedHookFile(path.join(workspace, ".cline", "hooks", "notes.txt"), [workspace], globalDir),
		).rejects.toThrow("is not a hook file")
	})
})
