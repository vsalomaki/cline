import { describe, expect, it } from "vitest";
import {
	buildClineSystemPrompt,
	MODE_TAG_INSTRUCTIONS,
	PLAN_MODE_INSTRUCTIONS,
	PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH,
	processWorkspaceInfo,
} from "./cline";

const BASE_OPTIONS = {
	ide: "VS Code",
	workspaceRoot: "/workspace/project",
	workspaceName: "project",
	platform: "linux",
};

describe("processWorkspaceInfo", () => {
	it("redacts URL credentials while preserving SCP-style SSH remotes", () => {
		const metadata = JSON.parse(
			processWorkspaceInfo({
				rootPath: "/workspace/project",
				associatedRemoteUrls: [
					"origin: https://user:token@github.com/cline/cline.git",
					"backup: ssh://git:secret@example.com/cline/cline.git",
					"mirror: git@github.com:cline/cline.git",
				],
			}),
		);

		expect(
			metadata.workspaces["/workspace/project"].associatedRemoteUrls,
		).toEqual([
			"origin: https://github.com/cline/cline.git",
			"backup: ssh://example.com/cline/cline.git",
			"mirror: git@github.com:cline/cline.git",
		]);
	});
});

describe("buildClineSystemPrompt task discipline", () => {
	const prompt = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "act" });

	it("asks for a full review of the changes before the final answer", () => {
		expect(prompt).toContain("review every file you changed as a whole");
		expect(prompt).toContain("Remove leftovers");
		expect(prompt).toContain("do the final review above before sending it");
	});

	it("ties success claims to verification", () => {
		expect(prompt).toContain("Verify by execution, not assumption");
		expect(prompt).toContain("if you could not verify it, say so");
	});

	it("asks for a report that covers what was skipped, failed or unverified", () => {
		expect(prompt).toContain("what you did not do or skipped");
		expect(prompt).toContain(
			"anything that failed, is unverified, or only partly works",
		);
		expect(prompt).toContain("Do not leave out problems");
	});

	it("checks a correction against the codebase before acting on it", () => {
		expect(prompt).toContain("do not simply agree and start editing");
		expect(prompt).toContain("establish the actual state of the codebase");
		expect(prompt).toContain("not on memory of earlier turns");
	});

	it("points directory listing at list_files", () => {
		expect(prompt).toContain("Call only the tools you are given");
		expect(prompt).toContain(
			"List directories with list_files when it is available, otherwise with run_commands",
		);
	});

	it("asks for the files and verification in a plan", () => {
		expect(PLAN_MODE_INSTRUCTIONS).toContain(
			"the files you expect to change, and how you will verify the result",
		);
	});
});

describe("buildClineSystemPrompt mode instructions", () => {
	it("explains the user_input mode attribute in act mode", () => {
		const prompt = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "act" });
		expect(prompt).toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).toContain('<user_input mode="...">');
		expect(prompt).toContain("<mode_notice>");
		expect(prompt).not.toContain(PLAN_MODE_INSTRUCTIONS);
	});

	it("appends the plan-mode contract only in plan mode", () => {
		const prompt = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "plan" });
		expect(prompt).toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).toContain(PLAN_MODE_INSTRUCTIONS);
		// The mode-tag explanation precedes the plan contract, matching the
		// order the CLI historically composed by hand.
		expect(prompt.indexOf(MODE_TAG_INSTRUCTIONS)).toBeLessThan(
			prompt.indexOf(PLAN_MODE_INSTRUCTIONS),
		);
	});

	it("keeps run_commands available-but-read-only in the plan contract", () => {
		// Explicit product decision: run_commands is NOT removed in plan mode
		// (it is essential for read-only investigation); the mitigation for
		// plan-mode mutations is prompting, so the contract must spell out the
		// inspection-only usage.
		expect(PLAN_MODE_INSTRUCTIONS).toContain("run_commands");
		expect(PLAN_MODE_INSTRUCTIONS).toContain("read-only");
		expect(PLAN_MODE_INSTRUCTIONS).toContain("switch_to_act_mode");
	});

	it("swaps in the manual-switch plan contract when the host has no switch tool", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			planModeSwitchTool: false,
		});
		expect(prompt).toContain(PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH);
		expect(prompt).not.toContain("switch_to_act_mode");
		// The read-only run_commands contract is shared by both variants.
		expect(PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH).toContain("run_commands");
		expect(PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH).toContain("Plan/Act toggle");
	});

	it("explains mode tags when the mode defaults to act", () => {
		expect(buildClineSystemPrompt({ ...BASE_OPTIONS })).toContain(
			MODE_TAG_INSTRUCTIONS,
		);
	});

	it("omits plan/act instructions in YOLO while preserving caller rules", () => {
		const rules = "# Custom Rules\n\nAlways speak like a pirate.";
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "yolo",
			rules,
		});
		expect(prompt).toContain(rules);
		expect(prompt).not.toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).not.toContain(PLAN_MODE_INSTRUCTIONS);
		expect(prompt).not.toContain(PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH);
		expect(prompt).not.toContain("# Plan / Act Modes");
		expect(prompt).not.toContain("switch_to_act_mode");
	});

	it("places caller rules before the mode instructions", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			rules: "# Custom Rules\n\nAlways speak like a pirate.",
		});
		const rulesIndex = prompt.indexOf("Always speak like a pirate.");
		expect(rulesIndex).toBeGreaterThan(-1);
		expect(rulesIndex).toBeLessThan(prompt.indexOf(MODE_TAG_INSTRUCTIONS));
	});

	it("includes rich workspace metadata for the Cline backend parser", () => {
		const metadata = JSON.stringify({
			workspaces: {
				"/workspace/project": {
					hint: "project",
					associatedRemoteUrls: ["origin: https://github.com/cline/cline.git"],
					latestGitCommitHash: "abc123",
				},
			},
		});
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			providerId: "cline",
			metadata,
		});

		expect(prompt).toContain(`# Workspace Configuration\n${metadata}`);
	});

	it("respects an explicit override prompt without injecting mode sections", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			overridePrompt: "You are a custom agent.",
		});
		expect(prompt).toBe("You are a custom agent.");
	});
});
