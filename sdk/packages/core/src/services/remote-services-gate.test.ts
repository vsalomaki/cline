import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClineAccountService } from "../account/cline-account-service";
import { loginClineOAuth, refreshClineToken } from "../auth/cline";
import { loadCloudModels } from "../cloud/models";
import { createComposioToolsExtension } from "../extensions/composio/composio-tools-extension";
import {
	FALLBACK_CLINE_RECOMMENDED_MODELS,
	fetchClineRecommendedModels,
} from "./llms/cline-recommended-models";
import { installPlugin } from "./plugin-install";
import { listLocalProviders } from "./providers/local-provider-service";
import { ProviderSettingsManager } from "./storage/provider-settings-manager";

describe("Cline services with remote services disabled", () => {
	let dir: string;

	beforeEach(() => {
		vi.stubEnv("CLINE_REMOTE_SERVICES", "off");
		dir = mkdtempSync(join(tmpdir(), "remote-services-gate-"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists no Cline or ClinePass provider", async () => {
		const manager = new ProviderSettingsManager({
			filePath: join(dir, "providers.json"),
		});
		const { providers } = await listLocalProviders(manager, {
			isClinePassEnabled: true,
		});
		const ids = providers.map((provider) => provider.id);

		expect(ids).not.toContain("cline");
		expect(ids).not.toContain("cline-pass");
		expect(ids).toContain("openai-compatible");
	});

	it("returns the bundled recommended models without a request", async () => {
		const fetchImpl = vi.fn();

		await expect(
			fetchClineRecommendedModels({
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).resolves.toEqual(FALLBACK_CLINE_RECOMMENDED_MODELS);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("loads no cloud models without a request", async () => {
		const fetchImpl = vi.fn();

		await expect(
			loadCloudModels("https://api.example.invalid", {
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).resolves.toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("refuses Cline sign-in and token refresh", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await expect(
			loginClineOAuth({
				apiBaseUrl: "https://api.example.invalid",
				callbacks: {} as Parameters<typeof loginClineOAuth>[0]["callbacks"],
			}),
		).rejects.toThrow("Cline sign-in is not available in this build");
		await expect(
			refreshClineToken(
				{ access: "a", refresh: "r", expires: 0 } as Parameters<
					typeof refreshClineToken
				>[0],
				{ apiBaseUrl: "https://api.example.invalid" },
			),
		).rejects.toThrow("Cline sign-in is not available in this build");
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("makes no Cline account requests", async () => {
		const fetchImpl = vi.fn();
		const service = new ClineAccountService({
			apiBaseUrl: "https://api.example.invalid",
			getAuthToken: async () => "token",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		await expect(service.fetchMe()).rejects.toThrow(
			"Cline account services are not available in this build",
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("registers no Composio tools", async () => {
		const request = vi.fn();

		await expect(
			createComposioToolsExtension({
				request: request as unknown as NonNullable<
					Parameters<typeof createComposioToolsExtension>[0]
				>["request"],
			}),
		).resolves.toBeUndefined();
		expect(request).not.toHaveBeenCalled();
	});

	it("refuses official plugin slugs", async () => {
		await expect(
			installPlugin({ source: "some-plugin", cwd: dir }),
		).rejects.toThrow("Official Cline plugins are not available in this build");
	});
});
