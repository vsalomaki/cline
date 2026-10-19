import { describe, expect, it } from "vitest";
import {
	buildClineSubAgentSystemPrompt,
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

	it("asks for no leftovers and restrained comments", () => {
		expect(prompt).toContain("Leave no leftovers in what you changed");
		expect(prompt).toContain(
			"Comment only where the reason is not obvious from the code itself",
		);
	});

	it("asks to inspect what a git restore would discard before running it", () => {
		expect(prompt).toContain(
			"look at exactly what it would throw away (git status, and git diff for the affected paths)",
		);
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

describe("buildClineSubAgentSystemPrompt", () => {
	const options = {
		role: "You review TypeScript changes.",
		ide: "VS Code",
		platform: "linux",
		workspaceRoot: "/workspace/project",
	};

	it("wraps the main agent's role in Cline's rules and environment", () => {
		const prompt = buildClineSubAgentSystemPrompt(options);

		expect(prompt).toContain("<role>\nYou review TypeScript changes.\n</role>");
		expect(prompt).toContain("Working Directory: /workspace/project");
		expect(prompt).toContain("Platform: linux");
		expect(prompt).toContain("IDE: VS Code");
		expect(prompt).toContain("Your final answer goes to the main agent");
		expect(prompt).not.toContain("{{");
		expect(prompt).not.toContain("plan mode");
	});

	it("keeps replacement sequences in the role literal", () => {
		const role = "Explain what $& and $' do in String.replace.";
		expect(buildClineSubAgentSystemPrompt({ ...options, role })).toContain(
			`<role>\n${role}\n</role>`,
		);
	});

	it("keeps a plan-mode subagent to investigation", () => {
		expect(
			buildClineSubAgentSystemPrompt({ ...options, mode: "plan" }),
		).toContain("The session is in plan mode: investigate only.");
	});

	it("adds workspace metadata only for the Cline provider", () => {
		const metadata = "# Workspace Configuration\n{}";
		expect(
			buildClineSubAgentSystemPrompt({
				...options,
				metadata,
				providerId: "cline",
			}),
		).toContain("# Workspace Configuration");
		expect(
			buildClineSubAgentSystemPrompt({
				...options,
				metadata,
				providerId: "anthropic",
			}),
		).not.toContain("# Workspace Configuration");
	});
});
