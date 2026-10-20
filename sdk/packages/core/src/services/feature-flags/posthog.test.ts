import type { PostHog } from "posthog-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostHogFeatureFlagsProvider } from "./posthog";

describe("PostHogFeatureFlagsProvider", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	function createProvider() {
		const getAllFlagsAndPayloads = vi.fn(async () => ({
			featureFlags: { beta: true },
		}));
		const provider = new PostHogFeatureFlagsProvider({
			client: { getAllFlagsAndPayloads } as unknown as PostHog,
			config: {},
		});
		return { provider, getAllFlagsAndPayloads };
	}

	it("fetches flags when remote services are on", async () => {
		const { provider, getAllFlagsAndPayloads } = createProvider();

		await expect(
			provider.getAllFlagsAndPayloads({ context: { distinctId: "d-1" } }),
		).resolves.toEqual({ featureFlags: { beta: true } });
		expect(getAllFlagsAndPayloads).toHaveBeenCalledOnce();
	});

	it("returns no flags without a request when remote services are disabled", async () => {
		vi.stubEnv("CLINE_REMOTE_SERVICES", "off");
		const { provider, getAllFlagsAndPayloads } = createProvider();

		expect(provider.enabled).toBe(false);
		await expect(
			provider.getAllFlagsAndPayloads({ context: { distinctId: "d-1" } }),
		).resolves.toBeUndefined();
		expect(getAllFlagsAndPayloads).not.toHaveBeenCalled();
	});
});
