import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRegistry } from "./registry";

function registryWith(config: Record<string, unknown>) {
	const registry = new GatewayRegistry();
	registry.registerProvider({
		manifest: {
			id: "test",
			name: "Test",
			defaultModelId: "m",
			models: [{ id: "m", name: "M", providerId: "test" }],
		},
		createProvider: async () => ({
			stream: async () => {
				throw new Error("not used");
			},
		}),
	} as never);
	registry.configureProvider({ providerId: "test", ...config });
	return registry;
}

describe("GatewayRegistry provider config", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("carries maxRetries and bounds the configured fetch with the timeout", async () => {
		const hanging = vi.fn(
			(_input: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		);
		const { config } = await registryWith({
			timeoutMs: 1_000,
			maxRetries: 4,
			fetch: hanging as unknown as typeof fetch,
		}).createProvider("test");

		expect(config.maxRetries).toBe(4);
		const pending = config.fetch?.("https://api.example.com");
		const assertion = expect(pending).rejects.toThrow("fetch failed");
		await vi.advanceTimersByTimeAsync(1_001);
		await assertion;
		expect(hanging).toHaveBeenCalledOnce();
	});

	it("applies the default timeout when none is configured", async () => {
		const hanging = vi.fn(
			(_input: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		);
		const { config } = await registryWith({
			fetch: hanging as unknown as typeof fetch,
		}).createProvider("test");

		let settled = false;
		const pending = config.fetch?.("https://api.example.com").catch(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(299_000);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(2_000);
		await pending;
		expect(settled).toBe(true);
	});
});
