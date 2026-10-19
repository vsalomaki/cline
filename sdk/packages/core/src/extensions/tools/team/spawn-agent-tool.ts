/**
 * Reusable spawn_agent tool for delegating tasks to sub-agents.
 */

import {
	type AgentConfig,
	type AgentEvent,
	type AgentHooks,
	type AgentResult,
	type AgentTool,
	type AgentToolContext,
	type BasicLogger,
	createTool,
	type HookErrorMode,
	type ITelemetryService,
	type ToolApprovalRequest,
	type ToolApprovalResult,
	type ToolPolicy,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import { resolveKnownModelsFromConfig } from "../../../services/llms/handler-factory";
import {
	type BuildDelegatedAgentConfigOptions,
	createDelegatedAgent,
	type DelegatedAgentConfigProvider,
} from "./delegated-agent";

type AgentExtension = NonNullable<AgentConfig["extensions"]>[number];
type AgentFinishReason = AgentResult["finishReason"];

export const SpawnAgentInputSchema = z.object({
	systemPrompt: z
		.string()
		.describe("System prompt defining the sub-agent's behavior"),
	task: z.string().describe("Task for the sub-agent to complete"),
});

export type SpawnAgentInput = z.infer<typeof SpawnAgentInputSchema>;

export interface SpawnAgentOutput {
	text: string;
	iterations: number;
	finishReason: AgentFinishReason;
	usage: {
		inputTokens: number;
		outputTokens: number;
	};
}

export interface SubAgentStartContext {
	subAgentId: string;
	conversationId: string;
	parentAgentId: string;
	input: SpawnAgentInput;
}

export interface SubAgentEndContext {
	subAgentId: string;
	conversationId: string;
	parentAgentId: string;
	input: SpawnAgentInput;
	result?: SpawnAgentOutput;
	agentResult?: AgentResult;
	error?: Error;
}

export interface SpawnAgentToolConfig {
	configProvider: DelegatedAgentConfigProvider;
	defaultMaxIterations?: number;
	subAgentTools?: AgentTool[];
	createSubAgentTools?: (
		input: SpawnAgentInput,
		context: AgentToolContext,
	) => AgentTool[] | Promise<AgentTool[]>;
	onSubAgentEvent?: (event: AgentEvent) => void;
	/**
	 * Lifecycle hooks forwarded to spawned sub-agent runs.
	 */
	hooks?: AgentHooks;
	/**
	 * Extension list forwarded to spawned sub-agent runs.
	 */
	extensions?: AgentExtension[];
	/**
	 * Error handling mode for forwarded lifecycle hooks.
	 */
	hookErrorMode?: HookErrorMode;
	/**
	 * Called after a sub-agent instance is created and before it starts running.
	 * Errors are ignored so lifecycle observers cannot break task execution.
	 */
	onSubAgentStart?: (context: SubAgentStartContext) => void | Promise<void>;
	/**
	 * Called once a sub-agent run finishes (success or error).
	 * Errors are ignored so lifecycle observers cannot break task execution.
	 */
	onSubAgentEnd?: (context: SubAgentEndContext) => void | Promise<void>;
	/**
	 * Optional per-tool policy for spawned sub-agents.
	 */
	toolPolicies?: Record<string, ToolPolicy>;
	/**
	 * Optional approval callback for spawned sub-agent tool calls.
	 */
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	/**
	 * Optional logger forwarded to spawned sub-agent runs.
	 */
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
	/**
	 * Compaction for each sub-agent's own context, created per run.
	 */
	createPrepareTurn?: () => BuildDelegatedAgentConfigOptions["prepareTurn"];
}

/**
 * Create a spawn_agent tool that can run a delegated task with a focused sub-agent.
 */
export function createSpawnAgentTool(
	config: SpawnAgentToolConfig,
): AgentTool<SpawnAgentInput, SpawnAgentOutput> {
	return createTool<SpawnAgentInput, SpawnAgentOutput>({
		name: "spawn_agent",
		executionMode: "parallel",
		description: `Spawn a sub-agent with custom instructions for a specialized task. Waits for the sub-agent to finish and returns its result before your next step.`,
		inputSchema: zodToJsonSchema(SpawnAgentInputSchema),
		execute: async (input, context) => {
			const tools = config.createSubAgentTools
				? await config.createSubAgentTools(input, context)
				: (config.subAgentTools ?? []);

			const progress = new SubAgentProgress(
				resolveSubAgentContextWindow(config.configProvider),
			);
			const subAgent = createDelegatedAgent({
				kind: "subagent",
				prompt: input.systemPrompt,
				configProvider: config.configProvider,
				tools,
				maxIterations: config.defaultMaxIterations,
				parentAgentId: context.agentId,
				abortSignal: context.signal,
				onEvent: (event) => {
					config.onSubAgentEvent?.(event);
					const update = progress.apply(event);
					if (update) {
						context.emitUpdate?.(update);
					}
				},
				hookErrorMode: config.hookErrorMode,
				toolPolicies: config.toolPolicies,
				requestToolApproval: config.requestToolApproval,
				prepareTurn: config.createPrepareTurn?.(),
			});
			const subAgentId = subAgent.getAgentId();
			const conversationId = subAgent.getConversationId();
			const parentAgentId = context.agentId;
			if (config.onSubAgentStart) {
				try {
					await config.onSubAgentStart({
						subAgentId,
						conversationId,
						parentAgentId,
						input,
					});
				} catch {
					// Best-effort observer callback.
				}
			}
			try {
				const result = await subAgent.run(input.task);
				const output: SpawnAgentOutput = {
					text: result.text,
					iterations: result.iterations,
					finishReason: result.finishReason,
					usage: {
						inputTokens: result.usage.inputTokens,
						outputTokens: result.usage.outputTokens,
					},
				};
				if (config.onSubAgentEnd) {
					try {
						await config.onSubAgentEnd({
							subAgentId,
							conversationId,
							parentAgentId,
							input,
							result: output,
							agentResult: result,
						});
					} catch {
						// Best-effort observer callback.
					}
				}
				return output;
			} catch (error) {
				if (config.onSubAgentEnd) {
					try {
						await config.onSubAgentEnd({
							subAgentId,
							conversationId,
							parentAgentId,
							input,
							error: error instanceof Error ? error : new Error(String(error)),
						});
					} catch {
						// Best-effort observer callback.
					}
				}
				throw error;
			}
		},
		timeoutMs: 300000,
		retryable: false,
	});
}

export interface SubAgentProgressUpdate {
	toolCalls: number;
	latestToolCall?: string;
	inputTokens: number;
	outputTokens: number;
	/** Size of the sub-agent's context at its latest model request. */
	contextTokens: number;
	contextWindow?: number;
	contextUsagePercentage?: number;
	totalCost?: number;
}

/** The context window of the model sub-agents run on, when the catalog knows it. */
export function resolveSubAgentContextWindow(
	configProvider: DelegatedAgentConfigProvider,
): number | undefined {
	const runtimeConfig = configProvider.getRuntimeConfig();
	return resolveKnownModelsFromConfig(runtimeConfig as AgentConfig)?.[
		runtimeConfig.modelId
	]?.contextWindow;
}

/** Running totals a spawn_agent call reports as tool updates while its sub-agent works. */
export class SubAgentProgress {
	private current: SubAgentProgressUpdate;

	constructor(private readonly contextWindow?: number) {
		this.current = {
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			contextTokens: 0,
			...(contextWindow ? { contextWindow, contextUsagePercentage: 0 } : {}),
		};
	}

	apply(event: AgentEvent): SubAgentProgressUpdate | undefined {
		if (event.type === "content_start" && event.contentType === "tool") {
			this.current = {
				...this.current,
				toolCalls: this.current.toolCalls + 1,
				latestToolCall: event.toolName,
			};
			return this.current;
		}
		if (event.type === "usage") {
			// inputTokens is the whole request, cached tokens included.
			const contextTokens = event.inputTokens + event.outputTokens;
			this.current = {
				...this.current,
				inputTokens: event.totalInputTokens,
				outputTokens: event.totalOutputTokens,
				contextTokens,
				...(this.contextWindow
					? {
							contextUsagePercentage: Math.round(
								(contextTokens / this.contextWindow) * 100,
							),
						}
					: {}),
				...(event.totalCost !== undefined
					? { totalCost: event.totalCost }
					: {}),
			};
			return this.current;
		}
		return undefined;
	}
}
