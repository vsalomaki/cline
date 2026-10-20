import { relative, sep } from "node:path";
import {
	resolveClineDataDir,
	resolveClineDir,
	setHomeDir,
} from "@cline/shared/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_DEFAULT_MAX_CONSECUTIVE_MISTAKES } from "../runtime/defaults";
import { commanderToParsedArgs, createProgram } from "./program";

/** Render an absolute path under `home` the way help text does: `~/...`. */
function tildePath(absolutePath: string, home: string): string {
	return `~/${relative(home, absolutePath).split(sep).join("/")}`;
}

describe("root option help text", () => {
	const FAKE_HOME = "/home/cline-help-test";
	const savedEnv: Record<string, string | undefined> = {};

	beforeAll(() => {
		// Pin the resolver inputs so the defaults below are the true defaults
		// (no CLINE_DIR/CLINE_DATA_DIR overrides, known home directory).
		for (const key of ["CLINE_DIR", "CLINE_DATA_DIR"]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		setHomeDir(FAKE_HOME);
	});

	afterAll(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("reports the actual resolver defaults for --config and --data-dir", () => {
		// A wide help width keeps each option description on one line so the
		// full default text can be matched.
		const help = createProgram()
			.configureHelp({ helpWidth: 500 })
			.helpInformation();

		const configDefault = tildePath(resolveClineDir(), FAKE_HOME);
		const dataDirDefault = tildePath(resolveClineDataDir(), FAKE_HOME);

		// Sanity-check the resolvers themselves so the assertions below can't
		// silently drift along with a resolver regression.
		expect(configDefault).toBe("~/.cline");
		expect(dataDirDefault).toBe("~/.cline/data");

		expect(help).toContain(
			`Configuration directory (default: ${configDefault})`,
		);
		expect(help).toContain(
			`Use isolated local state at this directory path (default: ${dataDirDefault})`,
		);
	});

	it("reports the --retries default that runs use", () => {
		const help = createProgram()
			.configureHelp({ helpWidth: 500 })
			.helpInformation();

		expect(help).toContain(
			`before exiting (default: ${CLI_DEFAULT_MAX_CONSECUTIVE_MISTAKES})`,
		);
	});

	it("rejects --retries without a count", () => {
		const program = createProgram().configureOutput({ writeErr: () => {} });

		expect(() => program.parse(["--retries"], { from: "user" })).toThrow(
			/argument missing/,
		);
	});
});

describe("tool-call options", () => {
	function parse(argv: string[]) {
		const program = createProgram().configureOutput({ writeErr: () => {} });
		program.parse(argv, { from: "user" });
		return commanderToParsedArgs(program);
	}

	it("leaves both settings undefined when no flag is given", () => {
		const args = parse([]);
		expect(args.maxParallelToolCalls).toBeUndefined();
		expect(args.parallelToolCalls).toBeUndefined();
		expect(args.invalidMaxParallelToolCalls).toBeUndefined();
	});

	it("parses --max-parallel-tool-calls", () => {
		expect(parse(["--max-parallel-tool-calls", "8"]).maxParallelToolCalls).toBe(
			8,
		);
	});

	it("flags an invalid --max-parallel-tool-calls value", () => {
		for (const raw of ["0", "-2", "abc", "1.5"]) {
			const args = parse(["--max-parallel-tool-calls", raw]);
			expect(args.maxParallelToolCalls).toBeUndefined();
			expect(args.invalidMaxParallelToolCalls).toBe(raw);
		}
	});

	it("parses --no-parallel-tool-calls and --parallel-tool-calls", () => {
		expect(parse(["--no-parallel-tool-calls"]).parallelToolCalls).toBe(false);
		expect(parse(["--parallel-tool-calls"]).parallelToolCalls).toBe(true);
	});

	it("parses --no-read-before-write and --read-before-write", () => {
		expect(parse([]).readBeforeWrite).toBeUndefined();
		expect(parse(["--no-read-before-write"]).readBeforeWrite).toBe(false);
		expect(parse(["--read-before-write"]).readBeforeWrite).toBe(true);
	});

	it("parses --no-revert-detection and --revert-detection", () => {
		expect(parse([]).revertDetection).toBeUndefined();
		expect(parse(["--no-revert-detection"]).revertDetection).toBe(false);
		expect(parse(["--revert-detection"]).revertDetection).toBe(true);
	});

	it("parses --no-review-before-finish and --review-before-finish", () => {
		expect(parse([]).reviewBeforeFinish).toBeUndefined();
		expect(parse(["--no-review-before-finish"]).reviewBeforeFinish).toBe(false);
		expect(parse(["--review-before-finish"]).reviewBeforeFinish).toBe(true);
	});

	it("parses --nested-subagents and --no-nested-subagents", () => {
		expect(parse([]).nestedSubagents).toBeUndefined();
		expect(parse(["--nested-subagents"]).nestedSubagents).toBe(true);
		expect(parse(["--no-nested-subagents"]).nestedSubagents).toBe(false);
	});

	it("parses --memory and --no-memory", () => {
		expect(parse([]).memory).toBeUndefined();
		expect(parse(["--memory"]).memory).toBe(true);
		expect(parse(["--no-memory"]).memory).toBe(false);
	});
});

describe("language-server options", () => {
	function parse(argv: string[]) {
		const program = createProgram().configureOutput({ writeErr: () => {} });
		program.parse(argv, { from: "user" });
		return commanderToParsedArgs(program);
	}

	it("leaves every option unset by default", () => {
		const args = parse([]);
		expect(args.languageServers).toBeUndefined();
		expect(args.codeIntelligenceTool).toBeUndefined();
		expect(args.problemsAfterEdit).toBeUndefined();
		expect(args.problemsTimeoutMs).toBeUndefined();
	});

	it("parses --no-language-servers and --language-servers", () => {
		expect(parse(["--no-language-servers"]).languageServers).toBe(false);
		expect(parse(["--language-servers"]).languageServers).toBe(true);
	});

	it("parses --no-code-intelligence-tool and --code-intelligence-tool", () => {
		expect(parse(["--no-code-intelligence-tool"]).codeIntelligenceTool).toBe(
			false,
		);
		expect(parse(["--code-intelligence-tool"]).codeIntelligenceTool).toBe(true);
	});

	it("parses --problems-after-edit and flags an unknown level", () => {
		expect(parse(["--problems-after-edit", "warnings"]).problemsAfterEdit).toBe(
			"warnings",
		);
		expect(parse(["--problems-after-edit", "OFF"]).problemsAfterEdit).toBe(
			"off",
		);
		const invalid = parse(["--problems-after-edit", "all"]);
		expect(invalid.problemsAfterEdit).toBeUndefined();
		expect(invalid.invalidProblemsAfterEdit).toBe("all");
	});

	it("parses --problems-timeout-ms and flags a non-integer", () => {
		expect(parse(["--problems-timeout-ms", "0"]).problemsTimeoutMs).toBe(0);
		expect(parse(["--problems-timeout-ms", "5000"]).problemsTimeoutMs).toBe(
			5000,
		);
		for (const raw of ["-1", "1.5", "soon"]) {
			const args = parse(["--problems-timeout-ms", raw]);
			expect(args.problemsTimeoutMs).toBeUndefined();
			expect(args.invalidProblemsTimeoutMs).toBe(raw);
		}
	});
});
