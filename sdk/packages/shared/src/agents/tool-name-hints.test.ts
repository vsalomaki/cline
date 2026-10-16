import { describe, expect, it } from "vitest";
import {
	canonicalToolForAlias,
	suggestToolForUnknownName,
} from "./tool-name-hints";

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

	it("points glob at search_codebase when list_files is absent", () => {
		expect(
			suggestToolForUnknownName("glob", ["read_files", "search_codebase"]),
		).toBe("Use search_codebase instead.");
	});

	it("returns undefined for names it does not know", () => {
		expect(suggestToolForUnknownName("frobnicate", ACT_TOOLS)).toBeUndefined();
	});
});

describe("canonicalToolForAlias", () => {
	it("maps other agents' names case-insensitively", () => {
		expect(canonicalToolForAlias("Read")).toBe("read_files");
		expect(canonicalToolForAlias("read_many_files")).toBe("read_files");
		expect(canonicalToolForAlias("Glob")).toBe("list_files");
		expect(canonicalToolForAlias("LS")).toBe("list_files");
		expect(canonicalToolForAlias("Grep")).toBe("search_codebase");
		expect(canonicalToolForAlias("search_file_content")).toBe(
			"search_codebase",
		);
		expect(canonicalToolForAlias("Bash")).toBe("run_commands");
		expect(canonicalToolForAlias("run_shell_command")).toBe("run_commands");
		expect(canonicalToolForAlias("WebFetch")).toBe("fetch_web_content");
	});

	it("leaves edit tools and unknown names unmapped", () => {
		for (const name of [
			"Edit",
			"Write",
			"MultiEdit",
			"str_replace_editor",
			"replace_in_file",
			"codebase_search",
			"frobnicate",
		]) {
			expect(canonicalToolForAlias(name)).toBeUndefined();
		}
	});
});
