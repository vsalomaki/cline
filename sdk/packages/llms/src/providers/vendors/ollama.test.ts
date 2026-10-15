import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOllamaProviderModule, normalizeOllamaBaseUrl } from "./ollama";

const createOllamaMock = vi.hoisted(() => vi.fn());
const ollamaModelMock = vi.hoisted(() =>
	vi.fn((modelId: string) => ({
		specificationVersion: "v4",
		provider: "ollama",
		modelId,
	})),
);

vi.mock("ollama-ai-provider-v2", () => ({
	createOllama: createOllamaMock,
}));

describe("normalizeOllamaBaseUrl", () => {
	it("appends the native API root to a bare origin", () => {
		expect(normalizeOllamaBaseUrl("http://localhost:11434")).toBe(
			"http://localhost:11434/api",
		);
		expect(normalizeOllamaBaseUrl("https://ollama.com")).toBe(
			"https://ollama.com/api",
		);
	});

	it("strips a legacy OpenAI-compat /v1 suffix", () => {
		expect(normalizeOllamaBaseUrl("http://localhost:11434/v1")).toBe(
			"http://localhost:11434/api",
		);
	});

	it("strips a native-API /api suffix", () => {
		expect(normalizeOllamaBaseUrl("http://localhost:11434/api")).toBe(
			"http://localhost:11434/api",
		);
	});

	it("strips trailing slashes", () => {
		expect(normalizeOllamaBaseUrl("http://localhost:11434/")).toBe(
			"http://localhost:11434/api",
		);
	});

	it("returns undefined for empty input", () => {
		expect(normalizeOllamaBaseUrl(undefined)).toBeUndefined();
		expect(normalizeOllamaBaseUrl("  ")).toBeUndefined();
	});
});

describe("createOllamaProviderModule", () => {
	beforeEach(() => {
		createOllamaMock.mockReset();
		createOllamaMock.mockReturnValue({ chat: ollamaModelMock });
		ollamaModelMock.mockClear();
	});

	it("normalizes the base URL and passes the API key through", async () => {
		const provider = await createOllamaProviderModule(
			config({ baseUrl: "https://ollama.com/v1", apiKey: "ollama-key" }),
			context({}),
		);
		provider.operations.language("minimax-m3:cloud");

		expect(createOllamaMock).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://ollama.com/api",
				headers: { Authorization: "Bearer ollama-key" },
				compatibility: "strict",
			}),
		);
		expect(ollamaModelMock).toHaveBeenCalledWith("minimax-m3:cloud");
	});

	it("constructs a native chat model without request-scoped settings", async () => {
		const provider = await createOllamaProviderModule(
			config({}),
			context({ contextWindow: 65536 }),
		);
		provider.operations.language("qwen3-coder:30b");

		expect(ollamaModelMock).toHaveBeenCalledWith("qwen3-coder:30b");
	});

	it("omits baseURL and authorization headers for a default local server", async () => {
		await createOllamaProviderModule(config({}), context({}));

		const call = createOllamaMock.mock.calls[0][0];
		expect(call.baseURL).toBeUndefined();
		expect(call.headers).toBeUndefined();
	});
});

function config(
	overrides: Partial<GatewayResolvedProviderConfig>,
): GatewayResolvedProviderConfig {
	return {
		providerId: "ollama",
		...overrides,
	};
}

function context(model: Record<string, unknown> = {}): GatewayProviderContext {
	return {
		provider: {
			id: "ollama",
			name: "Ollama",
			defaultModelId: "",
			models: [],
		},
		model: {
			id: "minimax-m3:cloud",
			name: "minimax-m3:cloud",
			providerId: "ollama",
			...model,
		},
	} as unknown as GatewayProviderContext;
}
