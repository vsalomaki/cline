import { afterEach, beforeEach, describe, it, mock } from "bun:test"
import { expect } from "chai"
import * as sinon from "sinon"
import * as actualPosthogConfig from "@/shared/services/config/posthog-config"

mock.module("@/shared/services/config/posthog-config", () => ({
	...actualPosthogConfig,
	isPostHogConfigValid: () => true,
}))

import { ClineEndpoint } from "@/config"
import { ErrorProviderFactory } from "@/services/error/ErrorProviderFactory"
import { FeatureFlagsProviderFactory } from "@/services/feature-flags/FeatureFlagsProviderFactory"
import { Logger } from "@/shared/services/Logger"
import { NoOpTelemetryProvider, TelemetryProviderFactory } from "./TelemetryProviderFactory"

describe("remote services gate", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		sandbox.stub(ClineEndpoint, "isSelfHosted").returns(false)
	})

	afterEach(() => {
		sandbox.restore()
		process.env.CLINE_REMOTE_SERVICES = "on"
	})

	it("uses PostHog providers when remote services are on", () => {
		expect(TelemetryProviderFactory.getDefaultConfigs().map((c) => c.type)).to.include("posthog")
		expect(ErrorProviderFactory.getDefaultConfig().type).to.equal("posthog")
		expect(FeatureFlagsProviderFactory.getDefaultConfig().type).to.equal("posthog")
	})

	it("uses no-op providers when remote services are disabled", () => {
		process.env.CLINE_REMOTE_SERVICES = "off"

		expect(TelemetryProviderFactory.getDefaultConfigs()).to.deep.equal([{ type: "no-op" }])
		expect(ErrorProviderFactory.getDefaultConfig().type).to.equal("no-op")
		expect(FeatureFlagsProviderFactory.getDefaultConfig().type).to.equal("no-op")
	})

	it("keeps the no-op telemetry provider out of the log when remote services are disabled", () => {
		process.env.CLINE_REMOTE_SERVICES = "off"
		const log = sandbox.stub(Logger, "log")
		const info = sandbox.stub(Logger, "info")
		const provider = new NoOpTelemetryProvider()

		provider.log("task.created", { taskId: "t-1" })
		provider.logRequired("task.created", { taskId: "t-1" })
		provider.identifyUser({ id: "u-1" })

		expect(log.called).to.equal(false)
		expect(info.called).to.equal(false)
	})
})
