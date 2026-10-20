import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoUpdateOnStartup, checkForUpdates } from "./commands/update";
import { getClineCliMigrationNotice } from "./kanban-migration/notice";
import { buildCommandPaletteItems } from "./tui/components/dialogs/command-palette-items";
import { resolveClineWelcomeLine } from "./tui/interactive-welcome";
import { getMainMenuOptions } from "./tui/views/onboarding/model";
import { shouldZeroClineFreeModelCost } from "./utils/free-model-cost";
import type { Config } from "./utils/types";

describe("CLI with remote services disabled", () => {
	const originalNoAutoUpdate = process.env.CLINE_NO_AUTO_UPDATE;
	const originalIsDev = process.env.IS_DEV;

	beforeEach(() => {
		process.env.CLINE_REMOTE_SERVICES = "off";
	});

	afterEach(() => {
		process.env.CLINE_REMOTE_SERVICES = "on";
		if (originalNoAutoUpdate === undefined)
			delete process.env.CLINE_NO_AUTO_UPDATE;
		else process.env.CLINE_NO_AUTO_UPDATE = originalNoAutoUpdate;
		if (originalIsDev === undefined) delete process.env.IS_DEV;
		else process.env.IS_DEV = originalIsDev;
		vi.restoreAllMocks();
	});

	it("never checks for updates", async () => {
		delete process.env.CLINE_NO_AUTO_UPDATE;
		delete process.env.IS_DEV;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("should not fetch"));
		const stdout = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);

		autoUpdateOnStartup();
		const exitCode = await checkForUpdates({ includeKanban: false });

		expect(exitCode).toBe(0);
		expect(stdout).toHaveBeenCalledWith(
			"Updates are disabled in this build.\n",
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("offers no Cline sign-in during onboarding", () => {
		const values = getMainMenuOptions({ isClinePassEnabled: true }).map(
			(option) => option.value,
		);

		expect(values).not.toContain("cline");
		expect(values).not.toContain("cline-pass");
		expect(values).toContain("byo");
	});

	it("shows no ClinePass or desktop notice", () => {
		expect(
			getClineCliMigrationNotice("/nonexistent-cline-data", {
				CLINE_FORCE_CLINE_PASS_NOTICE: "1",
			}),
		).toBeUndefined();
	});

	it("hides the account action from the command palette", () => {
		const actions = buildCommandPaletteItems({ canForkSession: true }).map(
			(item) => item.id,
		);

		expect(actions).not.toContain("action:account");
	});

	it("skips the free-model lookup", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await expect(
			shouldZeroClineFreeModelCost({
				providerId: "cline",
				modelId: "some/free-model",
				baseUrl: "https://api.example.invalid",
			}),
		).resolves.toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("shows no Cline credit line", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await expect(
			resolveClineWelcomeLine({
				config: { providerId: "cline" } as Config,
				clineProviderSettings: {
					provider: "cline",
					apiKey: "token",
				} as Parameters<
					typeof resolveClineWelcomeLine
				>[0]["clineProviderSettings"],
			}),
		).resolves.toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
