/**
 * User-tunable limits on how the agent reads, runs and remembers. Shared by the
 * extension, which maps them onto the SDK session config, and the settings UI.
 *
 * Values are stored sparse: only what the user changed is kept, and a missing
 * id means the SDK default applies. Timeouts are stored in milliseconds. The
 * response timeout lives in the `requestTimeoutMs` API setting; every other
 * limit lives in `agentLimitSettings`.
 */

export type AgentLimitGroup =
	| "modelApi"
	| "toolCalls"
	| "toolOutput"
	| "toolInput"
	| "providerRequest"
	| "timeouts"
	| "loop"
	| "compaction"

export type AgentLimitUnit = "chars" | "bytes" | "lines" | "milliseconds" | "count" | "tokens" | "percent" | "toggle"

export interface AgentLimitDefinition {
	id: string
	group: AgentLimitGroup
	label: string
	description: string
	unit: AgentLimitUnit
	default: number
	min: number
	max: number
	/** Env var that overrides the setting when the editor was launched with it. */
	envVar?: string
}

const MAX_CHARS = 10_000_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000

export const AGENT_LIMIT_DEFINITIONS = [
	{
		id: "api.requestTimeout",
		group: "modelApi",
		label: "Response timeout",
		description:
			"How long a request may wait for the model to start responding before it is retried. Long answers are never cut off once they start.",
		unit: "milliseconds",
		default: 300_000,
		min: 10_000,
		max: MAX_TIMEOUT_MS,
	},
	{
		id: "api.maxRetries",
		group: "modelApi",
		label: "Retries",
		description:
			"Retries for a request that fails to start, times out, comes back empty or drops before any output. 0 turns retries off.",
		unit: "count",
		default: 5,
		min: 0,
		max: 10,
	},
	{
		id: "session.maxParallelToolCalls",
		group: "toolCalls",
		label: "Parallel tool calls",
		description:
			"Read-only tools (file reads, searches, listings, web fetches, skills) run at once when the model asks for several in one response. Edits, commands and questions always run one at a time. 1 runs every call in order.",
		unit: "count",
		default: 4,
		min: 1,
		max: 16,
		envVar: "CLINE_MAX_PARALLEL_TOOL_CALLS",
	},
	{
		id: "api.parallelToolCalls",
		group: "toolCalls",
		label: "Several tool calls per response",
		description:
			"Lets the model ask for several tools in one response, which saves round trips, time and tokens. Keep it on unless a model garbles responses that hold several calls, as some small local models do. Off asks the provider for one call per response.",
		unit: "toggle",
		default: 1,
		min: 0,
		max: 1,
		envVar: "CLINE_PARALLEL_TOOL_CALLS",
	},
	{
		id: "tool.commandOutputChars",
		group: "toolOutput",
		label: "Command output",
		description: "Output kept from one run_commands call. Beyond this the middle is cut.",
		unit: "chars",
		default: 48_000,
		min: 1_000,
		max: MAX_CHARS,
		envVar: "CLINE_TOOL_MAX_COMMAND_OUTPUT_CHARS",
	},
	{
		id: "tool.readLines",
		group: "toolOutput",
		label: "Lines per file read",
		description: "Lines returned per read_files window.",
		unit: "lines",
		default: 2_000,
		min: 1,
		max: 1_000_000,
		envVar: "CLINE_TOOL_MAX_READ_LINES",
	},
	{
		id: "tool.readOutputChars",
		group: "toolOutput",
		label: "File read output",
		description: "Characters returned per read_files window.",
		unit: "chars",
		default: 48_000,
		min: 1_000,
		max: MAX_CHARS,
		envVar: "CLINE_TOOL_MAX_READ_OUTPUT_CHARS",
	},
	{
		id: "tool.lineChars",
		group: "toolOutput",
		label: "Line length",
		description: "Characters kept per line in file reads and search results.",
		unit: "chars",
		default: 2_000,
		min: 1,
		max: MAX_CHARS,
		envVar: "CLINE_TOOL_MAX_LINE_CHARS",
	},
	{
		id: "tool.searchOutputChars",
		group: "toolOutput",
		label: "Search output",
		description: "Characters returned per search_codebase query.",
		unit: "chars",
		default: 48_000,
		min: 1_000,
		max: MAX_CHARS,
		envVar: "CLINE_TOOL_MAX_SEARCH_OUTPUT_CHARS",
	},
	{
		id: "tool.webFetchContentChars",
		group: "toolOutput",
		label: "Web page content",
		description: "Page content kept per fetch_web_content request.",
		unit: "chars",
		default: 48_000,
		min: 1_000,
		max: MAX_CHARS,
		envVar: "CLINE_TOOL_MAX_WEB_FETCH_CONTENT_CHARS",
	},
	{
		id: "tool.editorDiffLines",
		group: "toolOutput",
		label: "Edit diff lines",
		description: "Diff lines included in the editor tool's result summary.",
		unit: "lines",
		default: 200,
		min: 1,
		max: 1_000_000,
		envVar: "CLINE_TOOL_MAX_EDITOR_DIFF_LINES",
	},
	{
		id: "tool.commandPreviewChars",
		group: "toolOutput",
		label: "Command echo",
		description: "Command text echoed back in the run_commands result.",
		unit: "chars",
		default: 200,
		min: 1,
		max: MAX_CHARS,
		envVar: "CLINE_TOOL_MAX_COMMAND_PREVIEW_CHARS",
	},
	{
		id: "tool.editorInputChars",
		group: "toolInput",
		label: "Edit size",
		description: "old_text / new_text accepted per editor call. Higher lets the model rewrite a whole file at once.",
		unit: "chars",
		default: 50_000,
		min: 1_000,
		max: MAX_CHARS,
		envVar: "CLINE_TOOL_MAX_EDITOR_INPUT_CHARS",
	},
	{
		id: "tool.commandInputChars",
		group: "toolInput",
		label: "Command length",
		description: "Length the model is asked to keep each shell command within.",
		unit: "chars",
		default: 12_000,
		min: 100,
		max: MAX_CHARS,
		envVar: "CLINE_TOOL_MAX_COMMAND_INPUT_CHARS",
	},
	{
		id: "message.toolResultChars",
		group: "providerRequest",
		label: "Tool result",
		description:
			"Each tool result forwarded to the model. Lowering it lowers the tool output caps with it; raising a tool output cap raises it to match.",
		unit: "chars",
		default: 50_000,
		min: 1_000,
		max: MAX_CHARS,
		envVar: "CLINE_MESSAGE_BUILDER_MAX_TOOL_RESULT_CHARS",
	},
	{
		id: "message.fileContentChars",
		group: "providerRequest",
		label: "Attached file",
		description: "Each file attached to a message.",
		unit: "chars",
		default: 50_000,
		min: 1_000,
		max: MAX_CHARS,
		envVar: "CLINE_MESSAGE_BUILDER_MAX_FILE_CONTENT_CHARS",
	},
	{
		id: "message.assistantTextChars",
		group: "providerRequest",
		label: "Assistant message",
		description: "Each earlier assistant message re-sent to the model.",
		unit: "chars",
		default: 200_000,
		min: 1_000,
		max: MAX_CHARS,
		envVar: "CLINE_MESSAGE_BUILDER_MAX_ASSISTANT_TEXT_CHARS",
	},
	{
		id: "message.assistantToolMarkupChars",
		group: "providerRequest",
		label: "Repeated tool-call markup",
		description: "Assistant text that repeats tool-call markup is cut to this length.",
		unit: "chars",
		default: 12_000,
		min: 1_000,
		max: MAX_CHARS,
		envVar: "CLINE_MESSAGE_BUILDER_MAX_ASSISTANT_TOOL_MARKUP_CHARS",
	},
	{
		id: "message.totalTextBytes",
		group: "providerRequest",
		label: "Whole request",
		description: "Text across the entire request. Trimming past this breaks the provider's prompt cache.",
		unit: "bytes",
		default: 6_000_000,
		min: 100_000,
		max: 100_000_000,
		envVar: "CLINE_MESSAGE_BUILDER_MAX_TOTAL_TEXT_BYTES",
	},
	{
		id: "message.minOutdatedRewriteBytes",
		group: "providerRequest",
		label: "Stale read cleanup",
		description:
			"Bytes of superseded file reads to collect before they are replaced with a short note. 0 replaces them right away.",
		unit: "bytes",
		default: 65_536,
		min: 0,
		max: 100_000_000,
		envVar: "CLINE_MESSAGE_BUILDER_MIN_OUTDATED_REWRITE_BYTES",
	},
	{
		id: "timeout.fileRead",
		group: "timeouts",
		label: "File read",
		description: "Per file in a read_files call.",
		unit: "milliseconds",
		default: 10_000,
		min: MIN_TIMEOUT_MS,
		max: MAX_TIMEOUT_MS,
	},
	{
		id: "timeout.search",
		group: "timeouts",
		label: "Search",
		description: "Per query in a search_codebase call.",
		unit: "milliseconds",
		default: 30_000,
		min: MIN_TIMEOUT_MS,
		max: MAX_TIMEOUT_MS,
	},
	{
		id: "timeout.ripgrep",
		group: "timeouts",
		label: "ripgrep",
		description:
			"How long search waits on ripgrep before falling back to a much slower built-in scan. Raise it for large repositories.",
		unit: "milliseconds",
		default: 5_000,
		min: MIN_TIMEOUT_MS,
		max: MAX_TIMEOUT_MS,
	},
	{
		id: "timeout.webFetch",
		group: "timeouts",
		label: "Web fetch",
		description: "Per URL in a fetch_web_content call.",
		unit: "milliseconds",
		default: 30_000,
		min: MIN_TIMEOUT_MS,
		max: MAX_TIMEOUT_MS,
	},
	{
		id: "timeout.editor",
		group: "timeouts",
		label: "File edit",
		description: "One editor tool call, including the diff view.",
		unit: "milliseconds",
		default: 30_000,
		min: MIN_TIMEOUT_MS,
		max: MAX_TIMEOUT_MS,
	},
	{
		id: "timeout.applyPatch",
		group: "timeouts",
		label: "Apply patch",
		description: "One apply_patch call.",
		unit: "milliseconds",
		default: 30_000,
		min: MIN_TIMEOUT_MS,
		max: MAX_TIMEOUT_MS,
	},
	{
		id: "timeout.hook",
		group: "timeouts",
		label: "Hook script",
		description: "A hook script still running after this long is stopped.",
		unit: "milliseconds",
		default: 30_000,
		min: MIN_TIMEOUT_MS,
		max: MAX_TIMEOUT_MS,
	},
	{
		id: "session.loopDetection",
		group: "loop",
		label: "Detect repeated tool calls",
		description: "Step in when the model keeps making the same tool call.",
		unit: "toggle",
		default: 1,
		min: 0,
		max: 1,
	},
	{
		id: "session.loopSoftThreshold",
		group: "loop",
		label: "Warn after",
		description: "Identical calls in a row before the model is told to try something else.",
		unit: "count",
		default: 3,
		min: 2,
		max: 100,
	},
	{
		id: "session.loopHardThreshold",
		group: "loop",
		label: "Stop after",
		description: "Identical calls in a row before the task pauses for you. Kept above the warning count.",
		unit: "count",
		default: 5,
		min: 3,
		max: 100,
	},
	{
		id: "session.maxConsecutiveMistakes",
		group: "loop",
		label: "Consecutive mistakes",
		description: "Failed API turns, invalid tool calls or all-failed tool rounds in a row before the task pauses for you.",
		unit: "count",
		default: 6,
		min: 1,
		max: 100,
	},
	{
		id: "compaction.triggerPercent",
		group: "compaction",
		label: "Compact at",
		description: "Share of the model's input budget at which auto-compaction runs.",
		unit: "percent",
		default: 90,
		min: 10,
		max: 100,
	},
	{
		id: "compaction.preserveRecentTokens",
		group: "compaction",
		label: "Keep recent context",
		description: "Recent conversation kept verbatim when compacting.",
		unit: "tokens",
		default: 20_000,
		min: 0,
		max: 10_000_000,
	},
] as const satisfies readonly AgentLimitDefinition[]

export type AgentLimitId = (typeof AGENT_LIMIT_DEFINITIONS)[number]["id"]

export type AgentLimitValues = Partial<Record<AgentLimitId, number>>

/** What the settings UI renders for each limit. */
export interface AgentLimitsState {
	/** Values the user set. */
	values: AgentLimitValues
	/**
	 * The value each limit resolves to after env vars and limit coupling.
	 * Missing when an env var switches the limit off.
	 */
	effective: Partial<Record<AgentLimitId, number>>
	/** Env var currently setting a limit, when one is. */
	envOverrides: Partial<Record<AgentLimitId, string>>
}

export const AGENT_LIMIT_GROUPS: ReadonlyArray<{ id: AgentLimitGroup; title: string; description: string }> = [
	{ id: "modelApi", title: "Model API", description: "Applies to every provider." },
	{ id: "toolCalls", title: "Tool calls", description: "How Cline runs the tool calls in one model response." },
	{
		id: "toolOutput",
		title: "Tool output",
		description: "How much each tool returns. A tool result is re-sent on every later turn, so larger values cost tokens.",
	},
	{ id: "toolInput", title: "Tool input", description: "How much the model may send in one tool call." },
	{ id: "providerRequest", title: "Provider request", description: "Caps applied while assembling each request to the model." },
	{ id: "timeouts", title: "Tool timeouts", description: "Command timeouts live under Terminal settings." },
	{ id: "loop", title: "Loops and mistakes", description: "When Cline stops a task that is going nowhere." },
	{ id: "compaction", title: "Compaction", description: "Applies when auto-compaction is on under Features." },
]

const DEFINITIONS_BY_ID = new Map<string, AgentLimitDefinition>(AGENT_LIMIT_DEFINITIONS.map((d) => [d.id, d]))

export function getAgentLimitDefinition(id: string): AgentLimitDefinition | undefined {
	return DEFINITIONS_BY_ID.get(id)
}

/**
 * Normalizes one requested value. Returns undefined (reset to the default) for
 * an unknown id or a negative or non-finite value; otherwise rounds and clamps
 * it into the limit's range.
 */
export function normalizeAgentLimitValue(id: string, value: number | undefined): number | undefined {
	const definition = getAgentLimitDefinition(id)
	if (!definition || value === undefined || !Number.isFinite(value) || value < 0) {
		return undefined
	}
	if (definition.unit === "toggle") {
		return value > 0 ? 1 : 0
	}
	return Math.min(definition.max, Math.max(definition.min, Math.round(value)))
}

/** Applies a batch of updates; a negative value resets that limit. */
export function applyAgentLimitUpdates(current: AgentLimitValues | undefined, updates: Record<string, number>): AgentLimitValues {
	const next: Record<string, number> = { ...current }
	for (const [id, value] of Object.entries(updates)) {
		const normalized = normalizeAgentLimitValue(id, value)
		if (normalized === undefined) {
			delete next[id]
		} else {
			next[id] = normalized
		}
	}
	return next as AgentLimitValues
}

export function getAgentLimitValue(values: AgentLimitValues | undefined, id: AgentLimitId): number {
	return values?.[id] ?? (DEFINITIONS_BY_ID.get(id) as AgentLimitDefinition).default
}
