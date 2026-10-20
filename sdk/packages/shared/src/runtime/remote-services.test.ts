import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteConfigBundle } from "../remote-config/bundle";
import { DefaultRemoteConfigTelemetryAdapter } from "../remote-config/telemetry";
import { createClineTelemetryServiceConfig } from "../services/telemetry-config";
import { isRemoteServicesDisabled } from "./remote-services";

const bundle = {
	telemetry: { enabled: true, otlpEndpoint: "https://otel.example" },
} as unknown as RemoteConfigBundle;
const context = {} as Parameters<
	DefaultRemoteConfigTelemetryAdapter["resolveTelemetry"]
>[1];

describe("remote services flag", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each([
		[undefined, true],
		["", true],
		["off", true],
		["ON", true],
		["on", false],
	])("CLINE_REMOTE_SERVICES=%s disables: %s", (value, disabled) => {
		vi.stubEnv("CLINE_REMOTE_SERVICES", value);
		expect(isRemoteServicesDisabled()).toBe(disabled);
	});

	it("drops build-time OTEL config when disabled", () => {
		vi.stubEnv("OTEL_TELEMETRY_ENABLED", "1");
		vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://otel.example");
		expect(createClineTelemetryServiceConfig().enabled).toBe(true);

		vi.stubEnv("CLINE_REMOTE_SERVICES", "off");
		const config = createClineTelemetryServiceConfig({ enabled: true });
		expect(config.enabled).toBe(false);
		expect(config.otlpEndpoint).toBeUndefined();
	});

	it("drops remote-config OTEL settings when disabled", () => {
		const adapter = new DefaultRemoteConfigTelemetryAdapter();
		expect(adapter.resolveTelemetry(bundle, context)).toMatchObject({
			enabled: true,
		});

		vi.stubEnv("CLINE_REMOTE_SERVICES", "off");
		expect(adapter.resolveTelemetry(bundle, context)).toBeUndefined();
	});
});
