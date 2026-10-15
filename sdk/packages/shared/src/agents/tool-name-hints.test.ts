import { describe, expect, it } from "vitest";
import { suggestToolForUnknownName } from "./tool-name-hints";

const ACT_TOOLS = [
	"read_files",
	"search_codebase",
	"list_files",
	"run_commands",
	"editor",
	"fetch_web_content",
];
const PLAN_TOOLS = ACT_TOOLS.filter((name) => name !== "editor");

describe("suggestToolForUnknownName", () => {
	it("maps common names from other agents to the available tool", () => {
		expect(suggestToolForUnknownName("read_file", ACT_TOOLS)).toBe(
			"Use read_files instead.",
		);
		expect(suggestToolForUnknownName("Bash", ACT_TOOLS)).toBe(
			"Use run_commands instead.",
		);
		expect(suggestToolForUnknownName("grep", ACT_TOOLS)).toBe(
			"Use search_codebase instead.",
		);
		expect(suggestToolForUnknownName("glob", ACT_TOOLS)).toBe(
			"Use list_files instead.",
		);
		expect(suggestToolForUnknownName("replace_in_file", ACT_TOOLS)).toBe(
			"Use editor instead.",
		);
	});

	it("prefers apply_patch when that is the session's edit tool", () => {
		expect(
			suggestToolForUnknownName("write_to_file", ["read_files", "apply_patch"]),
		).toBe("Use apply_patch instead.");
	});

	it("explains that edits are unavailable when no edit tool exists", () => {
		expect(suggestToolForUnknownName("editor", PLAN_TOOLS)).toContain(
			"File edits are not available in this mode",
		);
	});

	it("falls back to run_commands for listing when list_files is absent", () => {
		expect(
			suggestToolForUnknownName("list_directory", [
				"read_files",
				"run_commands",
			]),
		).toContain("list directories with run_commands");
	});

	it("returns undefined for names it does not know", () => {
		expect(suggestToolForUnknownName("frobnicate", ACT_TOOLS)).toBeUndefined();
	});
});
