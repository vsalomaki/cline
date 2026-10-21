import type { WorkspaceContext } from "../extensions/context";
import { isClineProvider } from "../providers/utils";
import type { WorkspaceInfo } from "../session/workspace";
import { DEFAULT_CLINE_SYSTEM_PROMPTS } from "./system";
import {
	CLINE_SYSTEM_PROMPT_SUBAGENT,
	SUBAGENT_PLAN_MODE_INSTRUCTIONS,
} from "./system/subagent";

const WORKSPACE_CONFIGURATION_MARKER = "# Workspace Configuration";

const PLATFORM_NAMES: Record<string, string> = {
	win32: "Windows",
	darwin: "macOS",
	linux: "Linux",
};

function platformName(platform: string): string {
	return PLATFORM_NAMES[platform] ?? platform;
}

/** Today's local date as YYYY-MM-DD; locale formats like 10/20/2026 are ambiguous. */
function currentDate(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Explains the <user_input mode="..."> wrapper and <mode_notice> elements the
 * runtime stamps on user messages (prepareTurnInput / formatUserInputBlock).
 * Included in plan and act prompts so the model can interpret mode switches
 * and earlier messages tagged with the other mode. YOLO prompts omit these
 * instructions because they do not use the plan/act workflow.
 */
export const MODE_TAG_INSTRUCTIONS = `# Plan / Act Modes

User messages arrive wrapped in a <user_input mode="..."> tag. The mode attribute is the interaction mode the user was in when they sent that message: "plan" means plan-mode constraints applied (explore, analyze, and align on a plan -- no edits or state-changing commands), while "act" (or "yolo") means implementation was allowed. If the mode attribute changes between messages, the user switched modes -- the newest message's mode is what governs right now, regardless of what earlier messages allowed. A <mode_notice> block inside a message marks exactly when such a switch happened.`;

/**
 * Plan-mode behavioral contract, appended when the session mode is "plan".
 * run_commands intentionally stays available in plan mode -- it is essential
 * for read-only investigation -- so the contract must spell out that it is
 * inspection-only there. Prompting is the first line of defense; the
 * plan-mode command-guard hook (registered by the core runtime builder for
 * plan-mode sessions) is the hard backstop that rejects file-editing
 * run_commands calls with a tool error before approval or execution.
 */
const PLAN_MODE_INSTRUCTIONS_BASE = `# Plan Mode

You are in Plan mode: explore, analyze and plan together with the user. Do not change anything yet; the work is done only after the user switches to Act mode. The sections above on writing code, scope and finishing describe how that work will be done: build them into the plan instead of carrying them out now.

## Exploring

- Gather the context the plan needs with your tools: the relevant code, the conventions and libraries already in use, and how the code is built and tested. Batch independent reads and searches in one response. Base every statement in the plan on what you have read or run, not on guesses.
- The run_commands tool remains available in plan mode strictly for read-only inspection: listing and searching files, reading configs, git history, status and diffs, tool versions. Never use it to change anything: no creating, modifying or deleting files, no scripts that make changes, no installs, migrations, database, schema or container commands that change state. File-changing commands (rm, mv, cp, in-place edits like sed -i, output redirection to files outside /tmp, git commands that change the working tree, package installs) are blocked in plan mode and return a tool error, so do not attempt them. If the task needs a change, put it in the plan.
- Ask the user only what your tools cannot answer, such as preferences, priorities and trade-offs.

## The plan

- Present the plan as a structured outline: the steps in order, the files you expect to change and how, and how the result will be verified (tests, build, running the code).
- Name the risks, open questions and assumptions. Where there are real alternatives, recommend one and say why in a line; do not list options you would not pick.
- Keep it as short as the task allows and within the request. Things you noticed outside the request go in a separate note, as a question.

## Revising the plan

- The user's feedback continues the same plan. Revise it rather than starting over: keep what was agreed, change what the feedback asks for, and say briefly what changed. Do not bring back an approach the user rejected unless you have new evidence, and say what that evidence is.
- When the user corrects you, check the code before agreeing. If the claim holds, say what was wrong; if it does not, explain what you found.

Presenting a plan or asking a question is your final answer for the turn.`;

export const PLAN_MODE_INSTRUCTIONS = `${PLAN_MODE_INSTRUCTIONS_BASE}

Once the user has reviewed your plan and explicitly approved it in a follow-up message, use the switch_to_act_mode tool to switch to act mode and begin implementation. Calling switch_to_act_mode immediately starts execution, so never call it in the same turn you present a plan and never treat the original task request as approval -- end your turn after presenting the plan and wait for the user's response.`;

/**
 * Plan-mode contract for hosts that do NOT expose the switch_to_act_mode tool
 * (the VS Code extension, matching the legacy extension's behavior). The model
 * must direct the user to flip the Plan/Act toggle instead of calling a tool
 * that does not exist in its toolset.
 */
export const PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH = `${PLAN_MODE_INSTRUCTIONS_BASE}

Once you have presented your plan, end your turn and wait for the user's response. You do NOT have the ability to switch to act mode yourself -- the user must do it manually with the Plan/Act toggle once they are satisfied with the plan. If the task requires tools that are only available in act mode, ask the user to "toggle to Act mode" (use those words).`;

function redactRemoteUrlCredentials(remote: string): string {
	const schemeEnd = remote.indexOf("://");
	if (schemeEnd < 1) return remote;

	const authorityStart = schemeEnd + 3;
	let authorityEnd = authorityStart;
	while (authorityEnd < remote.length) {
		const char = remote[authorityEnd];
		if (
			char === "/" ||
			char === "?" ||
			char === "#" ||
			char.charCodeAt(0) <= 32
		) {
			break;
		}
		authorityEnd++;
	}

	const userInfoEnd = remote.lastIndexOf("@", authorityEnd - 1);
	if (userInfoEnd < authorityStart) return remote;
	return remote.slice(0, authorityStart) + remote.slice(userInfoEnd + 1);
}

export function processWorkspaceInfo(info: WorkspaceInfo): string {
	return JSON.stringify(
		{
			workspaces: {
				[info.rootPath]: {
					hint: info.hint,
					associatedRemoteUrls: info.associatedRemoteUrls?.map(
						redactRemoteUrlCredentials,
					),
					latestGitCommitHash: info.latestGitCommitHash,
					latestGitBranchName: info.latestGitBranchName,
				},
			},
		},
		null,
		2,
	);
}

function buildWorkspaceMetadata(
	rootPath: string,
	workspaceName?: string,
	metadata?: string,
): string {
	if (metadata?.trim()?.includes(WORKSPACE_CONFIGURATION_MARKER)) {
		return metadata.trim();
	}
	const body =
		metadata ||
		JSON.stringify(
			{
				workspaces: {
					[rootPath]: {
						hint: workspaceName || rootPath.split("/").at(-1) || rootPath,
					},
				},
			},
			null,
			2,
		);
	return `\n${WORKSPACE_CONFIGURATION_MARKER}\n${body}`;
}

/**
 * Options for building the Cline system prompt.
 *
 * Extends WorkspaceContext so callers can spread an ExtensionContext.workspace
 * directly. `workspaceRoot` is accepted as an alias for `rootPath` to support
 * existing call sites that set it explicitly.
 */
export interface ClineSystemPromptOptions
	extends Omit<WorkspaceContext, "rootPath"> {
	/**
	 * Workspace root path. Accepts either `rootPath` (from WorkspaceContext/WorkspaceInfo)
	 * or `workspaceRoot` (legacy alias) — whichever is provided will be used.
	 */
	rootPath?: string;
	/** Alias for rootPath — kept for backwards compatibility with existing call sites */
	workspaceRoot?: string;
	/** Per-request system prompt override */
	overridePrompt?: string;
	/** Provider ID — used to gate Cline-specific metadata injection */
	providerId?: string;
	/**
	 * Whether the host exposes the switch_to_act_mode tool in plan mode.
	 * Defaults to true (CLI behavior). Hosts that require the user to flip the
	 * Plan/Act toggle themselves (the VS Code extension) set this to false so
	 * the plan-mode contract directs the model to ask the user instead of
	 * calling a tool that is not in its toolset.
	 */
	planModeSwitchTool?: boolean;
}

export function buildClineSystemPrompt(
	options: ClineSystemPromptOptions,
): string {
	const {
		ide = "Terminal Shell",
		mode,
		platform = "unknown",
		workspaceName,
		metadata,
		rules,
		overridePrompt,
		providerId,
		planModeSwitchTool = true,
	} = options;
	const workspaceRoot = options.workspaceRoot ?? options.rootPath ?? "";
	const isCline = isClineProvider(providerId || "");

	if (overridePrompt?.trim()) {
		const trimmed = overridePrompt.trim();
		if (
			isCline &&
			metadata?.trim() &&
			!trimmed.includes(WORKSPACE_CONFIGURATION_MARKER)
		) {
			return `${trimmed}\n\n${buildWorkspaceMetadata(workspaceRoot, workspaceName, metadata)}`.trim();
		}
		return trimmed;
	}

	const basePrompt =
		mode === "yolo"
			? DEFAULT_CLINE_SYSTEM_PROMPTS.YOLO
			: DEFAULT_CLINE_SYSTEM_PROMPTS.ACT;

	// Keep mode semantics shared across hosts, but omit the plan/act workflow
	// instructions in YOLO mode. Caller rules apply in every mode.
	const effectiveRules = [
		rules,
		mode === "yolo" ? undefined : MODE_TAG_INSTRUCTIONS,
		mode === "plan"
			? planModeSwitchTool
				? PLAN_MODE_INSTRUCTIONS
				: PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH
			: undefined,
	]
		.filter(Boolean)
		.join("\n\n");

	return basePrompt
		.replace("{{PLATFORM_NAME}}", platformName(platform))
		.replace("{{CWD}}", workspaceRoot)
		.replace("{{CURRENT_DATE}}", currentDate())
		.replace("{{IDE_NAME}}", ide)
		.replace(
			"{{CLINE_METADATA}}",
			isCline
				? buildWorkspaceMetadata(workspaceRoot, workspaceName, metadata)
				: "",
		)
		.replace("{{CLINE_RULES}}", effectiveRules)
		.trim();
}

export interface ClineSubAgentSystemPromptOptions {
	/** The role the main agent wrote when it delegated the task. */
	role: string;
	ide?: string;
	platform?: string;
	workspaceRoot?: string;
	workspaceName?: string;
	metadata?: string;
	/** The session's mode; only "plan" changes the prompt. */
	mode?: string;
	providerId?: string;
}

/**
 * System prompt for a subagent: Cline's working rules and environment around
 * the role the main agent wrote. Rules files reach subagents through the
 * runtime's rule extensions, not through this prompt.
 */
export function buildClineSubAgentSystemPrompt(
	options: ClineSubAgentSystemPromptOptions,
): string {
	const workspaceRoot = options.workspaceRoot?.trim() || "/";
	const role = options.role.trim();
	const isCline = isClineProvider(options.providerId || "");
	// A function replacement keeps "$&" and similar sequences in the role literal.
	return CLINE_SYSTEM_PROMPT_SUBAGENT.replace(
		"{{ROLE}}",
		() => role || "Complete the task you were given.",
	)
		.replace("{{PLATFORM_NAME}}", platformName(options.platform || "unknown"))
		.replace("{{CURRENT_DATE}}", currentDate())
		.replace("{{IDE_NAME}}", options.ide || "Terminal Shell")
		.replace("{{CWD}}", workspaceRoot)
		.replace(
			"{{MODE_INSTRUCTIONS}}",
			options.mode === "plan" ? SUBAGENT_PLAN_MODE_INSTRUCTIONS : "",
		)
		.replace("{{CLINE_RULES}}", "")
		.replace(
			"{{CLINE_METADATA}}",
			isCline && !role.includes(WORKSPACE_CONFIGURATION_MARKER)
				? buildWorkspaceMetadata(
						workspaceRoot,
						options.workspaceName,
						options.metadata,
					)
				: "",
		)
		.trim();
}
