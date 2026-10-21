// Wire-contract tests for user messages typed while the agent works. They
// reach the model right after the tool results of the previous step, as one
// or more user messages, so the request carries a tool result followed by
// user turns. Each case streams one turn through the real AI SDK adapter
// with a stubbed fetch and asserts on the request body.
import type { AgentMessage } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createGateway } from "../gateway";

const MESSAGES: AgentMessage[] = [
	{
		id: "m1",
		role: "user",
		content: [{ type: "text", text: "Run the tests" }],
		createdAt: 0,
	},
	{
		id: "m2",
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolCallId: "call_1",
				toolName: "run_commands",
				input: { commands: ["bun test"] },
			},
		],
		createdAt: 1,
	},
	{
		id: "m3",
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "call_1",
				toolName: "run_commands",
				output: "3 passed",
			},
		],
		createdAt: 2,
	},
	{
		id: "m4",
		role: "user",
		content: [{ type: "text", text: "Skip the slow suite" }],
		createdAt: 3,
		metadata: { userRunSpan: 0, typedInput: true },
	},
	{
		id: "m5",
		role: "user",
		content: [{ type: "text", text: "And use bun" }],
		createdAt: 4,
		metadata: { userRunSpan: 0, typedInput: true },
	},
];

async function wireBody(input: {
	providerId: string;
	modelId: string;
	baseUrl?: string;
}): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetchStub = (async (_input, init) => {
		body = JSON.parse((init?.body as string) ?? "{}");
		return new Response(JSON.stringify({ error: { message: "stub" } }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	const gateway = createGateway({
		providerConfigs: [
			{
				providerId: input.providerId,
				apiKey: "test-key",
				baseUrl: input.baseUrl,
				fetch: fetchStub,
			},
		],
	});
	for await (const _event of await gateway.stream({
		providerId: input.providerId,
		modelId: input.modelId,
		maxTokens: 16,
		messages: MESSAGES,
	})) {
		// drain
	}
	if (!body) {
		throw new Error("the stubbed fetch was never called");
	}
	return body;
}

describe("user messages after tool results, wire contract", () => {
	it("Anthropic: the tool result and the typed messages share the user turn after the tool call", async () => {
		const body = await wireBody({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-5",
		});
		const messages = body.messages as Array<{
			role: string;
			content: Array<Record<string, unknown>>;
		}>;
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		expect(messages[2]?.content).toMatchObject([
			{ type: "tool_result", tool_use_id: "call_1" },
			{ type: "text", text: "Skip the slow suite" },
			{ type: "text", text: "And use bun" },
		]);
	});

	it("OpenAI-compatible: the tool message is followed by the typed user messages", async () => {
		const body = await wireBody({
			providerId: "openai-compatible",
			modelId: "local-model",
			baseUrl: "http://127.0.0.1:9/v1",
		});
		const messages = body.messages as Array<Record<string, unknown>>;
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"user",
			"user",
		]);
		expect(messages[2]).toMatchObject({
			role: "tool",
			tool_call_id: "call_1",
		});
		expect(messages.slice(3).map((message) => message.content)).toEqual([
			"Skip the slow suite",
			"And use bun",
		]);
	});
});
