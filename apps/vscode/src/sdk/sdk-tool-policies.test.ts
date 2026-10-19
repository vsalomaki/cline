import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { describe, expect, it } from "vitest"
import { buildToolPolicies, isToolAutoApproved } from "./sdk-tool-policies"

describe("isToolAutoApproved", () => {
	it("does not auto-approve command tools by default", () => {
		expect(isToolAutoApproved("run_commands", DEFAULT_AUTO_APPROVAL_SETTINGS)).toBe(false)
	})

	it("uses executeSafeCommands as the single command approval flag", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: {
				...DEFAULT_AUTO_APPROVAL_SETTINGS.actions,
				executeSafeCommands: false,
				executeAllCommands: true,
			},
		}

		expect(isToolAutoApproved("run_commands", settings)).toBe(false)
	})

	it("treats code_intelligence as a read tool", () => {
		const actions = DEFAULT_AUTO_APPROVAL_SETTINGS.actions
		expect(
			isToolAutoApproved("code_intelligence", {
				...DEFAULT_AUTO_APPROVAL_SETTINGS,
				actions: { ...actions, readFiles: true },
			}),
		).toBe(true)
		expect(
			isToolAutoApproved("code_intelligence", {
				...DEFAULT_AUTO_APPROVAL_SETTINGS,
				actions: { ...actions, readFiles: false },
			}),
		).toBe(false)
	})

	it("auto-approves all MCP tools when the Use MCP servers toggle is on", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: true },
		}

		expect(isToolAutoApproved("firecrawl__scrape", settings)).toBe(true)
	})

	it("prompts for MCP tools when the Use MCP servers toggle is off", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: false },
		}

		expect(isToolAutoApproved("firecrawl__scrape", settings)).toBe(false)
	})

	it("asks before spawn_agent unless everything a subagent can do is auto-approved", () => {
		const actions = { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, readFiles: true, editFiles: true, useBrowser: true }
		const settings = { ...DEFAULT_AUTO_APPROVAL_SETTINGS, actions }

		expect(buildToolPolicies(settings).spawn_agent).toEqual({ autoApprove: false })
		expect(isToolAutoApproved("spawn_agent", settings)).toBe(true)
		expect(isToolAutoApproved("subagent_code_reviewer", settings)).toBe(true)
		for (const off of ["readFiles", "editFiles", "useBrowser"] as const) {
			const offSettings = { ...settings, actions: { ...actions, [off]: false } }
			expect(isToolAutoApproved("spawn_agent", offSettings)).toBe(false)
			expect(isToolAutoApproved("subagent_code_reviewer", offSettings)).toBe(false)
		}
	})

	it("asks before a team tool starts a teammate or a task, and lets the others run", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, readFiles: false },
		}
		const policies = buildToolPolicies(settings)

		for (const tool of ["team_spawn_teammate", "team_run_task"]) {
			expect(policies[tool]).toEqual({ autoApprove: false })
			expect(isToolAutoApproved(tool, settings)).toBe(false)
		}
		expect(policies.team_status).toBeUndefined()
		expect(policies.team_send_message).toBeUndefined()
	})
})
