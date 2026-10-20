import { getDefaultProviderId } from "@cline/shared";
import { Command, CommanderError, Option } from "commander";
import { version } from "../../package.json";
import { CLI_DEFAULT_MAX_CONSECUTIVE_MISTAKES } from "../runtime/defaults";
import {
	CLI_COMPACTION_MODE_OPTION_DESCRIPTION,
	parseCliCompactionMode,
} from "../utils/compaction-mode";
import type { ParsedArgs } from "../utils/types";

export { CommanderError };

function normalizeAutoApproveValue(
	value: string | boolean | undefined,
): string {
	if (value === undefined || value === true) {
		return "true";
	}
	return String(value);
}

/**
 * Add the shared root-level options to any command.
 */
export function addRootOptions(cmd: Command): Command {
	return (
		cmd
			.option("-p, --plan", "Run in plan mode")
			.option(
				"-y, --yolo",
				"Auto-approve a limited tool set for unsupervised runs (benchmarks, CI). DANGEROUS: use only in sandboxed environments.",
			)
			.option("--json", "Output messages as JSON instead of styled text")
			.option(
				"--auto-approve <boolean>",
				"Set tool auto-approval for all tools (default: true)",
				normalizeAutoApproveValue,
			)
			.option("-c, --cwd <path>", "Working directory")
			.option(
				"--thinking <level>",
				"Set reasoning effort: none|low|medium|high|xhigh. Bare --thinking uses medium; omitted uses the level last chosen with /model, or the provider default.",
			)
			.option("--compaction <mode>", CLI_COMPACTION_MODE_OPTION_DESCRIPTION)
			.option(
				"-i, --tui",
				"Open the terminal user interface (TUI) for interactive sessions",
			)
			.option("--id <session-id>", "Resume an existing session by ID")
			.option(
				"-P, --provider <id>",
				`Provider id (default: ${getDefaultProviderId()})`,
			)
			.option(
				"-k, --key <api-key>",
				"API key for this run, also saved as the provider's key",
			)
			.option(
				"-m, --model <model-id>",
				"Model to use for the session with the selected provider",
			)
			.option(
				"-s, --system <system-prompt>",
				"Override the default system prompt",
			)
			.option("-z, --zen", "Start a session that runs in the background hub")
			.option(
				"--retries <count>",
				`Number of maximum consecutive mistakes (retries) before exiting (default: ${CLI_DEFAULT_MAX_CONSECUTIVE_MISTAKES})`,
			)
			.option(
				"--max-parallel-tool-calls <count>",
				"Maximum number of read-only tool calls run concurrently (default: 4; 1 runs every call in order)",
			)
			.option(
				"--parallel-tool-calls",
				"Let the model request several tool calls per response (default)",
			)
			.option(
				"--no-parallel-tool-calls",
				"Ask the model for one tool call per response",
			)
			.option(
				"--read-before-write",
				"Refuse edits to existing files the agent has not read, or that changed since (default)",
			)
			.option(
				"--no-read-before-write",
				"Allow edits to files the agent has not read",
			)
			.option(
				"--revert-detection",
				"Note in an edit's result when it restores a file to an earlier state from this session (default)",
			)
			.option(
				"--no-revert-detection",
				"Do not point out edits that restore a file to an earlier state",
			)
			.option(
				"--review-before-finish",
				"Send the agent back once to review a request that changed files before its final report (default)",
			)
			.option(
				"--no-review-before-finish",
				"Let the agent report without the review",
			)
			.option(
				"--nested-subagents",
				"Let subagents start subagents of their own, one level deeper",
			)
			.option(
				"--no-nested-subagents",
				"Only the main agent starts subagents (default)",
			)
			.option(
				"--language-servers",
				"Start language servers for the code_intelligence tool and problems after edits (default)",
			)
			.option("--no-language-servers", "Do not start language servers")
			.option(
				"--code-intelligence-tool",
				"Offer the code_intelligence tool (default)",
			)
			.option(
				"--no-code-intelligence-tool",
				"Do not offer the code_intelligence tool; problems after edits still work",
			)
			.option(
				"--problems-after-edit <level>",
				"Problems reported after an edit: off, errors (default) or warnings (errors and warnings)",
			)
			.option(
				"--problems-timeout-ms <ms>",
				"How long an edit waits for language-server problems (default: 3000)",
			)
			.option(
				"-t, --timeout <seconds>",
				"Optional timeout in seconds (default: 0 for no timeout)",
			)
			.option(
				"--acp",
				"Run in Agent Client Protocol (ACP) mode for editor integration",
			)
			.option("--config <path>", "Configuration directory (default: ~/.cline)")
			.option(
				"--data-dir <path>",
				"Use isolated local state at this directory path (default: ~/.cline/data)",
			)
			.option(
				"--hooks-dir <path>",
				"Directory path to additional hooks for runtime hook injection (default: ~/.cline/hooks)",
			)
			.option(
				"--worktree",
				"Auto-create a detached git worktree under ~/.cline/worktrees/ and run the task there",
			)
			.option("--update", "Check for updates and install if available")
			.option("--kanban", "Run the kanban app")
			.option("-v, --verbose", "Show verbose output")
			// HIDDEN/LEGACY OPTIONS BELOW
			.addOption(
				// Act mode is the default. Keep the legacy flags accepted for users who
				// still pass them, but do not advertise them in help output.
				new Option("-a, --act", "Run in act mode").hideHelp(),
			)
			.addOption(
				// TODO: Refactor teams to resume session without team name
				new Option(
					"--team-name <name>",
					"Override the runtime team state name",
				).hideHelp(),
			)
	);
}

export function createProgram(): Command {
	const program = new Command("cline")
		.description("Cline CLI - AI coding assistant in your terminal")
		.version(version, "-V, --version", "Output the version number")
		.exitOverride() // don't call process.exit
		.configureOutput({
			writeOut: () => {}, // suppress by default; main.ts re-enables for routing
			writeErr: () => {},
		})
		.allowExcessArguments()
		.enablePositionalOptions()
		.argument(
			"[prompt]",
			"Your prompt. Default to start in act mode with auto-approve enabled.",
		);

	addRootOptions(program);

	return program;
}

export function commanderToParsedArgs(program: Command): ParsedArgs {
	const opts = program.opts();

	const result: ParsedArgs = {
		verbose: !!opts.verbose,
		interactive: !!opts.tui,
		outputMode: opts.json ? "json" : "text",
		mode: opts.plan ? "plan" : opts.yolo ? "yolo" : opts.zen ? "zen" : "act",
		modeExplicitlySet: !!(opts.plan || opts.act || opts.yolo || opts.zen),
		sandbox: !!opts.dataDir,
		acpMode: !!opts.acp,
		thinking: false,
		reasoningEffort: undefined,
		defaultToolAutoApprove: true,
		id: opts.id,
	};

	// Approval: last-wins semantics
	if (opts.autoApprove !== undefined) {
		const raw = String(opts.autoApprove).trim().toLowerCase();
		if (raw === "true") {
			result.defaultToolAutoApprove = true;
			result.autoApproveOverride = true;
		} else if (raw === "false") {
			result.defaultToolAutoApprove = false;
			result.autoApproveOverride = false;
		} else if (raw) {
			result.invalidAutoApprove = raw;
		}
	}
	if (opts.yolo) {
		result.defaultToolAutoApprove = true;
		result.autoApproveOverride = true;
	}

	// Timeout validation
	if (opts.timeout !== undefined) {
		const raw = opts.timeout.trim();
		const parsed = Number.parseInt(raw, 10);
		if (raw && Number.isInteger(parsed) && parsed >= 1) {
			result.timeoutSeconds = parsed;
		} else if (raw) {
			result.invalidTimeoutSeconds = raw;
		}
	}

	if (opts.thinking !== undefined) {
		const effort = String(opts.thinking).trim().toLowerCase();
		if (
			effort === "none" ||
			effort === "low" ||
			effort === "medium" ||
			effort === "high" ||
			effort === "xhigh"
		) {
			result.thinkingExplicitlySet = true;
			if (effort === "none") {
				result.thinking = false;
				result.reasoningEffort = undefined;
			} else {
				result.thinking = true;
				result.reasoningEffort = effort;
			}
		} else if (effort) {
			result.invalidThinkingLevel = effort;
		}
	}

	if (opts.compaction !== undefined) {
		const mode = String(opts.compaction).trim().toLowerCase();
		const compactionMode = parseCliCompactionMode(mode);
		if (compactionMode) {
			result.compactionMode = compactionMode;
		} else if (mode) {
			result.invalidCompactionMode = mode;
		}
	}

	// Retries (max consecutive mistakes) validation
	if (opts.retries !== undefined) {
		const raw = opts.retries.trim();
		const parsed = Number.parseInt(raw, 10);
		if (raw && Number.isInteger(parsed) && parsed >= 1) {
			result.retries = parsed;
		} else if (raw) {
			result.invalidRetries = raw;
		}
	}

	if (opts.maxParallelToolCalls !== undefined) {
		const raw = String(opts.maxParallelToolCalls).trim();
		const parsed = Number.parseInt(raw, 10);
		if (/^\d+$/.test(raw) && Number.isSafeInteger(parsed) && parsed >= 1) {
			result.maxParallelToolCalls = parsed;
		} else if (raw) {
			result.invalidMaxParallelToolCalls = raw;
		}
	}
	if (typeof opts.parallelToolCalls === "boolean") {
		result.parallelToolCalls = opts.parallelToolCalls;
	}
	if (typeof opts.readBeforeWrite === "boolean") {
		result.readBeforeWrite = opts.readBeforeWrite;
	}
	if (typeof opts.revertDetection === "boolean") {
		result.revertDetection = opts.revertDetection;
	}
	if (typeof opts.reviewBeforeFinish === "boolean") {
		result.reviewBeforeFinish = opts.reviewBeforeFinish;
	}
	if (typeof opts.nestedSubagents === "boolean") {
		result.nestedSubagents = opts.nestedSubagents;
	}
	if (typeof opts.languageServers === "boolean") {
		result.languageServers = opts.languageServers;
	}
	if (typeof opts.codeIntelligenceTool === "boolean") {
		result.codeIntelligenceTool = opts.codeIntelligenceTool;
	}
	if (opts.problemsAfterEdit !== undefined) {
		const raw = String(opts.problemsAfterEdit).trim().toLowerCase();
		if (raw === "off" || raw === "errors" || raw === "warnings") {
			result.problemsAfterEdit = raw;
		} else {
			result.invalidProblemsAfterEdit = String(opts.problemsAfterEdit);
		}
	}
	if (opts.problemsTimeoutMs !== undefined) {
		const raw = String(opts.problemsTimeoutMs).trim();
		const parsed = Number.parseInt(raw, 10);
		if (/^\d+$/.test(raw) && Number.isSafeInteger(parsed)) {
			result.problemsTimeoutMs = parsed;
		} else {
			result.invalidProblemsTimeoutMs = raw;
		}
	}

	// Simple string/number options
	if (opts.dataDir !== undefined) result.dataDir = opts.dataDir;
	if (opts.config !== undefined) result.configDir = opts.config;
	if (opts.hooksDir !== undefined) result.hooksDir = opts.hooksDir;
	if (opts.worktree !== undefined) result.worktree = !!opts.worktree;
	if (opts.cwd !== undefined) result.cwd = opts.cwd;
	if (opts.teamName !== undefined) result.teamName = opts.teamName;
	if (opts.system !== undefined) result.systemPrompt = opts.system;
	if (opts.model !== undefined) result.model = opts.model;
	if (opts.provider !== undefined) result.provider = opts.provider;
	if (opts.key !== undefined) result.key = opts.key;
	else if (opts.apiKey !== undefined) result.key = opts.apiKey;
	if (opts.id !== undefined) result.id = opts.id;

	// Positional args → prompt
	const positional = program.args;
	if (positional.length > 0) {
		result.prompt = positional.join(" ");
	}

	return result;
}
