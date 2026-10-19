import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { McpHub } from "@/services/mcp/McpHub"

/**
 * Build SDK `toolPolicies` for tools governed by Cline's auto-approval UI.
 *
 * The SDK defaults unlisted tools to auto-approved. For tools controlled by
 * the AutoApproveBar toggles (including all MCP tools), force the SDK to call
 * `requestToolApproval`; the approval callback then evaluates the latest
 * settings and either silently approves or shows the approval UI. This keeps
 * active sessions in sync when the user toggles auto-approval mid-task.
 */
export function buildToolPolicies(
	_settings: AutoApprovalSettings,
	mcpHub?: McpHub,
): Record<string, { enabled?: boolean; autoApprove?: boolean }> {
	const policies: Record<string, { enabled?: boolean; autoApprove?: boolean }> = {}

	const set = (tools: string[]) => {
		for (const tool of tools) {
			policies[tool] = { autoApprove: false }
		}
	}

	set([
		"read_files",
		"read_file",
		"list_files",
		"list_code_definition_names",
		"search_codebase",
		"search_files",
		"code_intelligence",
	])
	set(["editor", "replace_in_file", "write_to_file", "apply_patch", "delete_file"])
	set(["run_commands", "execute_command"])
	set(["fetch_web_content", "web_fetch", "web_search"])
	set(["spawn_agent", ...TEAM_DELEGATION_TOOLS])

	if (mcpHub) {
		for (const server of mcpHub.getServers()) {
			for (const tool of server.tools ?? []) {
				const sdkName = `${server.name}__${tool.name}`
				policies[sdkName] = { autoApprove: false }
			}
		}
	}

	return policies
}

/**
 * Evaluate the current UI auto-approval settings for a single SDK tool name.
 * Used both when building initial SDK policies and as a live guard in the
 * approval callback, so changes from the AutoApproveBar are respected even if
 * an SDK session was created before the toggle changed.
 */
export function isToolAutoApproved(toolName: string, settings: AutoApprovalSettings): boolean {
	if (isReadTool(toolName)) {
		return !!settings.actions.readFiles
	}
	if (isEditTool(toolName)) {
		return !!settings.actions.editFiles
	}
	if (isCommandTool(toolName)) {
		return !!settings.actions.executeSafeCommands
	}
	if (isBrowserTool(toolName)) {
		return !!settings.actions.useBrowser
	}

	if (isMcpToolName(toolName)) {
		// One global toggle governs all MCP tools; there is no per-tool opt-in.
		return !!settings.actions.useMcp
	}

	if (isSubagentTool(toolName) || TEAM_DELEGATION_TOOLS.includes(toolName)) {
		// A subagent or teammate runs its own tools without asking, so approving it approves everything it can do:
		// read, edit and fetch. It has no run_commands, because the host's terminal tool replaces the SDK shell.
		return !!settings.actions.readFiles && !!settings.actions.editFiles && !!settings.actions.useBrowser
	}

	return false
}

function isReadTool(toolName: string): boolean {
	return [
		"read_files",
		"read_file",
		"list_files",
		"list_code_definition_names",
		"search_codebase",
		"search_files",
		"code_intelligence",
	].includes(toolName)
}

export function isEditTool(toolName: string): boolean {
	return ["editor", "replace_in_file", "write_to_file", "apply_patch", "delete_file"].includes(toolName)
}

function isCommandTool(toolName: string): boolean {
	return toolName === "run_commands" || toolName === "execute_command"
}

function isBrowserTool(toolName: string): boolean {
	return toolName === "fetch_web_content" || toolName === "web_fetch" || toolName === "web_search"
}

/** Team tools that create a teammate or start one working; the other team tools only read or message. */
const TEAM_DELEGATION_TOOLS = ["team_spawn_teammate", "team_run_task"]

/** `spawn_agent`, or a configured agent's `subagent_<name>` tool, which takes spawn_agent's policy. */
export function isSubagentTool(toolName: string): boolean {
	return toolName === "spawn_agent" || toolName.startsWith("subagent_")
}

/** MCP tools are registered by `createMcpTools` under `serverName__toolName`. */
function isMcpToolName(toolName: string): boolean {
	const separatorIndex = toolName.indexOf("__")
	return separatorIndex > 0 && separatorIndex + 2 < toolName.length
}
