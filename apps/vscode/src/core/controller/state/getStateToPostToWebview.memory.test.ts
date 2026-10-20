import { describe, expect, it, vi } from "vitest"
import { getStateToPostToWebview } from "./getStateToPostToWebview"

vi.mock("@/config", () => ({ ClineEnv: { config: () => ({ environment: "production" }) } }))
vi.mock("@/registry", () => ({ ExtensionRegistryInfo: { version: "0.0.0" } }))
vi.mock("@/services/banner/BannerService", () => ({
	BannerService: { get: () => ({ getActiveBanners: () => [], getWelcomeBanners: () => [] }) },
}))
vi.mock("@/services/feature-flags", () => ({ featureFlagsService: { getWorktreesEnabled: () => false } }))
vi.mock("@/services/logging/distinctId", () => ({ getDistinctId: () => "test" }))
vi.mock("@/services/telemetry/rollout-metadata", () => ({ getExtensionVariant: () => "sdk" }))
vi.mock("@/utils/announcements", () => ({ getLatestAnnouncementId: () => "1" }))
vi.mock("../models/getClineOnboardingModels", () => ({ getClineOnboardingModels: () => [] }))
vi.mock("@/integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: { isAuthenticated: async () => false },
}))

function makeController(settings: Record<string, unknown>) {
	return {
		stateManager: {
			getApiConfiguration: () => ({}),
			getGlobalSettingsKey: (key: string) => settings[key],
			getGlobalStateKey: () => undefined,
			getWorkspaceStateKey: () => undefined,
			getRemoteConfigSettings: () => ({}),
		},
	}
}

describe("getStateToPostToWebview — memory", () => {
	it("defaults memory off with the after-run check on", async () => {
		const state = await getStateToPostToWebview(makeController({}))

		expect(state.memoryEnabled).toBe(false)
		expect(state.memoryExtractAfterRun).toBe(true)
	})

	it("posts the stored memory settings", async () => {
		const state = await getStateToPostToWebview(makeController({ memoryEnabled: true, memoryExtractAfterRun: false }))

		expect(state.memoryEnabled).toBe(true)
		expect(state.memoryExtractAfterRun).toBe(false)
	})
})
