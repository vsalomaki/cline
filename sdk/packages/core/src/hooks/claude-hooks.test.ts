import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setClineDir, setHomeDir } from "@cline/shared/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ClaudeHooks } from "./claude-hooks";
import { claudeToolView } from "./claude-tool-adapters";

const PLUGIN_HOOKS = {
	hooks: {
		PreToolUse: [
			{ matcher: "Bash", hooks: [{ type: "command", command: "pre" }] },
			{
				matcher: "mcp__plugin_acme_docs__run",
				hooks: [{ type: "command", command: "pre" }],
			},
		],
		PostToolUse: [
			{
				matcher: "Bash|Read|Write|Edit|Grep|Agent|mcp__",
				hooks: [{ type: "command", command: "post" }],
			},
		],
		PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "pc" }] }],
		SessionStart: [
			{ matcher: "", hooks: [{ type: "command", command: "ss" }] },
		],
		Stop: [{ hooks: [{ type: "command", command: "stop" }] }],
	},
};

describe("ClaudeHooks", () => {
	let root = "";
	let workspace = "";
	let hooksDir = "";
	let logPath = "";

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "claude-hooks-"));
		await mkdir(join(root, "home"), { recursive: true });
		await mkdir(join(root, "cline"), { recursive: true });
		setHomeDir(join(root, "home"));
		setClineDir(join(root, "cline"));
	});

	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	beforeEach(async () => {
		workspace = await mkdtemp(join(root, "ws-"));
		hooksDir = join(workspace, ".cline", "hooks");
		await mkdir(hooksDir, { recursive: true });
		logPath = join(workspace, "stdin.jsonl");
	});

	/** A command that logs its stdin, prints `stdout` and exits with `code`. */
	async function script(name: string, stdout = "", code = 0, stderr = "") {
		const path = join(workspace, `${name}.js`);
		await writeFile(
			path,
			`let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{require('node:fs').appendFileSync(${JSON.stringify(logPath)}, d.replace(/\\n/g,' ')+'\\n');process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exit(${code});});\n`,
		);
		return `node ${JSON.stringify(path)}`;
	}

	async function config(hooks: Record<string, unknown>) {
		await writeFile(join(hooksDir, "hooks.json"), JSON.stringify({ hooks }));
	}

	function create() {
		return new ClaudeHooks({
			workspacePath: workspace,
			cwd: workspace,
			sessionId: "session-1",
			mode: "act",
			timeoutMs: 10_000,
		});
	}

	async function stdinLog(): Promise<Array<Record<string, any>>> {
		try {
			return (await readFile(logPath, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	}

	it("matches a plugin's hooks.json by tool name, prefix and event", async () => {
		await config(PLUGIN_HOOKS.hooks);
		const hooks = create() as unknown as {
			commandsFor(event: string, targets: string[]): Array<{ command: string }>;
		};
		expect(
			hooks.commandsFor("PreToolUse", ["Bash", "run_commands"]),
		).toHaveLength(1);
		expect(
			hooks.commandsFor("PreToolUse", ["Read", "read_files"]),
		).toHaveLength(0);
		expect(
			hooks.commandsFor("PostToolUse", ["mcp__docs__search"]),
		).toHaveLength(1);
		expect(hooks.commandsFor("SessionStart", ["compact"])).toHaveLength(1);
	});

	it("blocks a multi-command call when one command is denied", async () => {
		const deny = await script(
			"deny",
			JSON.stringify({
				hookSpecificOutput: {
					permissionDecision: "deny",
					permissionDecisionReason: "no curl",
				},
			}),
		);
		await config({
			PreToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: deny }] },
			],
		});
		const control = await create().preToolUse("run_commands", "call-1", {
			commands: ["ls", "curl x"],
		});
		expect(control).toMatchObject({
			deny: true,
			denyReason: "no curl\nno curl",
		});
		const inputs = (await stdinLog()).map((entry) => entry.tool_input.command);
		expect(inputs.sort()).toEqual(["curl x", "ls"]);
		expect((await stdinLog())[0]).toMatchObject({
			session_id: "session-1",
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_use_id: "call-1",
			permission_mode: "default",
		});
	});

	it("rewrites only the item a hook updated", async () => {
		const rewrite = join(workspace, "rewrite.js");
		await writeFile(
			rewrite,
			`let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const i=JSON.parse(d);if(i.tool_input.command.startsWith('curl'))process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'allow',updatedInput:{command:'echo blocked'}}}));});\n`,
		);
		await config({
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [
						{ type: "command", command: `node ${JSON.stringify(rewrite)}` },
					],
				},
			],
		});
		const control = await create().preToolUse("run_commands", "call-1", {
			commands: ["ls", "curl x", { command: "git", args: ["status"] }],
		});
		expect(control?.overrideInput).toEqual({
			commands: ["ls", "echo blocked", { command: "git", args: ["status"] }],
		});
	});

	it("treats exit code 2 as a block with stderr as the reason", async () => {
		const block = await script("block", "", 2, "use ctx_fetch_and_index");
		await config({
			PreToolUse: [{ hooks: [{ type: "command", command: block }] }],
		});
		expect(
			await create().preToolUse("fetch_web_content", "call-1", {
				url: "https://example.com",
			}),
		).toEqual({ deny: true, denyReason: "use ctx_fetch_and_index" });
		expect((await stdinLog())[0]).toMatchObject({
			tool_name: "WebFetch",
			tool_input: {
				url: "https://example.com",
				prompt: "Return the main content of the page.",
			},
		});
	});

	it("asks for approval", async () => {
		const ask = await script(
			"ask",
			JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } }),
		);
		await config({
			PreToolUse: [{ hooks: [{ type: "command", command: ask }] }],
		});
		expect(
			await create().preToolUse("read_files", "call-1", {
				files: [{ path: "/a" }],
			}),
		).toMatchObject({ ask: true });
	});

	it("uses plain stdout as context for UserPromptSubmit and SessionStart", async () => {
		const text = await script("text", "remember this");
		await config({
			UserPromptSubmit: [{ hooks: [{ type: "command", command: text }] }],
			SessionStart: [
				{ matcher: "startup", hooks: [{ type: "command", command: text }] },
			],
		});
		const hooks = create();
		expect(await hooks.userPromptSubmit("hi")).toMatchObject({
			context: "remember this",
		});
		expect(await hooks.sessionStart("startup")).toBe("remember this");
		expect(await hooks.sessionStart("compact")).toBeUndefined();
		expect((await stdinLog()).map((entry) => entry.hook_event_name)).toEqual([
			"UserPromptSubmit",
			"SessionStart",
		]);
	});

	it("sends each item's own result to PostToolUse", async () => {
		const post = await script("post");
		await config({
			PostToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: post }] },
			],
		});
		await create().postToolUse(
			"run_commands",
			"call-1",
			{ commands: ["a", "b"] },
			[
				{ query: "a", result: "out-a", success: true },
				{ query: "b", result: "", error: "boom", success: false },
			],
		);
		const byCommand = Object.fromEntries(
			(await stdinLog()).map((entry) => [
				entry.tool_input.command,
				entry.tool_response,
			]),
		);
		expect(byCommand.a).toMatchObject({ stdout: "out-a", stderr: "" });
		expect(byCommand.b).toMatchObject({ stdout: "", stderr: "boom" });
	});

	it("names a file-creating editor call Write in PostToolUse too", async () => {
		const post = await script("post");
		await config({
			PostToolUse: [
				{ matcher: "Write", hooks: [{ type: "command", command: post }] },
			],
		});
		const hooks = create();
		const path = join(workspace, "new.txt");
		await hooks.preToolUse("editor", "call-w", { path, new_text: "x" });
		await writeFile(path, "x");
		await hooks.postToolUse("editor", "call-w", { path, new_text: "x" }, "ok");
		expect((await stdinLog()).map((entry) => entry.tool_name)).toEqual([
			"Write",
		]);
	});

	it("passes the trigger to PreCompact", async () => {
		const pc = await script("pc");
		await config({
			PreCompact: [
				{ matcher: "manual", hooks: [{ type: "command", command: pc }] },
			],
		});
		const hooks = create();
		await hooks.preCompact("auto");
		await hooks.preCompact("manual");
		expect((await stdinLog()).map((entry) => entry.trigger)).toEqual([
			"manual",
		]);
	});

	it("sets CLAUDE_PROJECT_DIR", async () => {
		const env = join(workspace, "env.js");
		await writeFile(
			env,
			`process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(process.env.CLAUDE_PROJECT_DIR));\n`,
		);
		await config({
			UserPromptSubmit: [
				{
					hooks: [{ type: "command", command: `node ${JSON.stringify(env)}` }],
				},
			],
		});
		expect(await create().userPromptSubmit("hi")).toMatchObject({
			context: workspace,
		});
	});
});

describe("claudeToolView", () => {
	it("shows read_files ranges as offset and limit, and back", () => {
		const view = claudeToolView(
			"read_files",
			{ files: [{ path: "/a", start_line: 10, end_line: 19 }, { path: "/b" }] },
			"/ws",
		);
		expect(view.name).toBe("Read");
		expect(view.inputs).toEqual([
			{ file_path: "/a", offset: 10, limit: 10 },
			{ file_path: "/b" },
		]);
		expect(
			view.withUpdates(
				new Map([[1, { file_path: "/c", offset: 5, limit: 2 }]]),
			),
		).toEqual({
			files: [
				{ path: "/a", start_line: 10, end_line: 19 },
				{ path: "/c", start_line: 5, end_line: 6 },
			],
		});
	});

	it("accepts the other input forms each tool accepts", () => {
		expect(claudeToolView("read_files", "/a", "/ws").inputs).toEqual([
			{ file_path: "/a" },
		]);
		expect(
			claudeToolView("run_commands", { command: "ls" }, "/ws").inputs,
		).toEqual([{ command: "ls" }]);
		expect(
			claudeToolView("search_codebase", { pattern: "foo" }, "/ws").inputs,
		).toEqual([{ pattern: "foo", path: "/ws" }]);
	});

	it("shows editor calls as Edit, or Write for a new file", () => {
		const edit = claudeToolView(
			"editor",
			{ path: "/ws/a.ts", old_text: "a", new_text: "b" },
			"/ws",
		);
		expect(edit.name).toBe("Edit");
		expect(edit.withUpdates(new Map([[0, { new_string: "c" }]]))).toEqual({
			path: "/ws/a.ts",
			old_text: "a",
			new_text: "c",
		});
		const write = claudeToolView(
			"editor",
			{ path: "/does/not/exist.ts", new_text: "x" },
			"/ws",
		);
		expect(write).toMatchObject({
			name: "Write",
			inputs: [{ file_path: "/does/not/exist.ts", content: "x" }],
		});
		expect(
			claudeToolView(
				"editor",
				{ path: "/a", new_text: "x", insert_line: 3 },
				"/ws",
			).name,
		).toBe("editor");
	});

	it("names MCP tools mcp__<server>__<tool> and keeps other tools as they are", () => {
		expect(claudeToolView("docs__search", {}, "/ws").name).toBe(
			"mcp__docs__search",
		);
		expect(claudeToolView("skills", { skill: "x" }, "/ws")).toMatchObject({
			name: "skills",
			inputs: [{ skill: "x" }],
		});
		expect(claudeToolView("read_files", { nonsense: true }, "/ws").name).toBe(
			"read_files",
		);
	});

	it("shows spawn_agent as Agent and maps the prompt back to the task", () => {
		const view = claudeToolView(
			"spawn_agent",
			{ systemPrompt: "s", task: "do it" },
			"/ws",
		);
		expect(view.inputs[0]).toMatchObject({ prompt: "do it" });
		expect(
			view.withUpdates(new Map([[0, { prompt: "do it, routed" }]])),
		).toEqual({
			systemPrompt: "s",
			task: "do it, routed",
		});
	});
});
