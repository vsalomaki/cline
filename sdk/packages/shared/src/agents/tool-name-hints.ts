/**
 * Models often call tools by the names other agents (or older Cline
 * versions) use. These helpers map those names onto the tools a session
 * actually has.
 */

/**
 * Directory-listing names from other agents. A call under one of these runs
 * as `list_files`, which accepts their input shapes.
 */
export const LIST_FILES_ALIASES: ReadonlySet<string> = new Set([
	"list_directory",
	"list_dir",
	"ls",
]);

const EDIT_TOOLS = ["editor", "apply_patch"];

const NAME_GROUPS: ReadonlyArray<{ names: readonly string[]; use: string[] }> =
	[
		{
			names: ["read_file", "view_file", "open_file", "cat", "view", "read"],
			use: ["read_files"],
		},
		{
			names: [
				"write_file",
				"write_to_file",
				"create_file",
				"replace_in_file",
				"str_replace_editor",
				"str_replace_based_edit_tool",
				"edit_file",
				"apply_diff",
				"edit",
				"write",
				"multiedit",
				"editor",
				"apply_patch",
			],
			use: EDIT_TOOLS,
		},
		{
			names: [
				"execute_command",
				"bash",
				"shell",
				"run_terminal_cmd",
				"run_command",
				"terminal",
			],
			use: ["run_commands"],
		},
		{
			names: [
				"search_files",
				"grep",
				"grep_search",
				"codebase_search",
				"file_search",
				"find_files",
				"search",
			],
			use: ["search_codebase"],
		},
		{ names: ["glob"], use: ["list_files", "search_codebase"] },
		{
			names: ["list_files", ...LIST_FILES_ALIASES],
			use: ["list_files", "run_commands"],
		},
		{
			names: ["web_fetch", "fetch", "fetch_url", "webfetch"],
			use: ["fetch_web_content"],
		},
	];

/**
 * A sentence telling the model which available tool to call instead of
 * `toolName`, or undefined when there is no good match.
 */
export function suggestToolForUnknownName(
	toolName: string,
	availableToolNames: Iterable<string>,
): string | undefined {
	const available = new Set(availableToolNames);
	const normalized = toolName.trim().toLowerCase();
	const group = NAME_GROUPS.find((candidate) =>
		candidate.names.includes(normalized),
	);
	if (!group) {
		return undefined;
	}
	const replacement = group.use.find((name) => available.has(name));
	if (replacement === "run_commands" && group.use[0] === "list_files") {
		return "There is no list_files tool here; list directories with run_commands (for example ls or dir).";
	}
	if (replacement) {
		return `Use ${replacement} instead.`;
	}
	if (group.use === EDIT_TOOLS) {
		return "File edits are not available in this mode. If you are in plan mode, put the change in your plan and ask the user to toggle to Act mode.";
	}
	return undefined;
}
