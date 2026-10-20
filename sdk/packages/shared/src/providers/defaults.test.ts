import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultProviderId } from "./defaults";

describe("getDefaultProviderId", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("defaults to cline when remote services are on", () => {
		expect(getDefaultProviderId()).toBe("cline");
	});

	it("defaults to openai-compatible when remote services are disabled", () => {
		vi.stubEnv("CLINE_REMOTE_SERVICES", "off");
		expect(getDefaultProviderId()).toBe("openai-compatible");
	});
});
