/**
 * Models often call tools by the names other agents (or older Cline
 * versions) use. These helpers map those names onto the tools a session
 * actually has.
 */

/**
 * Other agents' names for tools whose input shapes ours accept. A call under
 * one of these runs as the canonical tool when the session has it.
 */
const TOOL_NAME_ALIASES = {
	read_files: [
		"read_file",
		"read",
		"view_file",
		"open_file",
		"cat",
		"view",
		"read_many_files",
	],
	list_files: ["list_directory", "list_dir", "ls", "glob", "list"],
	search_codebase: [
		"grep",
		"search_files",
		"grep_search",
		"search_file_content",
		"ripgrep",
		"rg",
		"search",
	],
	run_commands: [
		"bash",
		"shell",
		"execute_command",
		"run_terminal_cmd",
		"run_command",
		"run_shell_command",
		"terminal",
	],
	fetch_web_content: ["web_fetch", "webfetch", "fetch", "fetch_url"],
	editor: ["edit"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Argument renames for aliases whose fields our tool names differently. Applied
 * when the call is renamed, so approval previews and the UI see our fields.
 */
const ALIAS_INPUT_KEYS: Readonly<
	Record<string, Readonly<Record<string, string>>>
> = {
	editor: { file_path: "path", old_string: "old_text", new_string: "new_text" },
};

const CANONICAL_BY_ALIAS: ReadonlyMap<string, string> = new Map(
	Object.entries(TOOL_NAME_ALIASES).flatMap(([canonical, aliases]) =>
		aliases.map((alias) => [alias, canonical] as const),
	),
);

/**
 * The tool an alias such as `Read`, `Bash` or `grep` stands for
 * (case-insensitive), or undefined when `toolName` is not an alias.
 */
export function canonicalToolForAlias(toolName: string): string | undefined {
	return CANONICAL_BY_ALIAS.get(toolName.trim().toLowerCase());
}

/**
 * The session's MCP tool (`<server>__<tool>`) for a name written the Claude
 * Code way: `mcp__<server>__<tool>`, or `mcp__plugin_<plugin>_<server>__<tool>`
 * for a plugin's server. Undefined when no single tool matches.
 */
export function mcpToolForClaudeName(
	toolName: string,
	available: readonly string[],
): string | undefined {
	if (!toolName.startsWith("mcp__")) {
		return undefined;
	}
	const rest = toolName.slice("mcp__".length);
	const split = rest.lastIndexOf("__");
	if (split <= 0) {
		return undefined;
	}
	const server = rest.slice(0, split);
	const tool = rest.slice(split + 2);
	const exact = `${server}__${tool}`;
	if (available.includes(exact)) {
		return exact;
	}
	const matches = available.filter((name) => {
		if (!name.endsWith(`__${tool}`)) return false;
		const candidateServer = name.slice(0, -(tool.length + 2));
		return candidateServer.length > 0 && server.endsWith(`_${candidateServer}`);
	});
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The JSON arguments of an aliased call with their fields renamed to
 * `canonical`'s, or `input` unchanged when nothing needs renaming.
 */
export function canonicalInputForAlias(
	canonical: string,
	input: string,
): string {
	const keys = ALIAS_INPUT_KEYS[canonical];
	if (keys === undefined) {
		return input;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch {
		return input;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return input;
	}
	const record: Record<string, unknown> = { ...parsed };
	for (const [alias, target] of Object.entries(keys)) {
		if (alias in record) {
			record[target] ??= record[alias];
			delete record[alias];
		}
	}
	return JSON.stringify(record);
}

const EDIT_TOOLS = ["editor", "apply_patch"];

const NAME_GROUPS: ReadonlyArray<{
	names: readonly string[];
	use: string[];
}> = [
	{ names: TOOL_NAME_ALIASES.read_files, use: ["read_files"] },
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
	{ names: TOOL_NAME_ALIASES.run_commands, use: ["run_commands"] },
	{
		names: [
			...TOOL_NAME_ALIASES.search_codebase,
			"codebase_search",
			"file_search",
			"find_files",
		],
		use: ["search_codebase"],
	},
	{ names: ["glob"], use: ["list_files", "search_codebase"] },
	{
		names: ["list_files", ...TOOL_NAME_ALIASES.list_files],
		use: ["list_files", "run_commands"],
	},
	{ names: TOOL_NAME_ALIASES.fetch_web_content, use: ["fetch_web_content"] },
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
