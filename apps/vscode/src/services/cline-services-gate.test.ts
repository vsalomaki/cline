import { afterEach, beforeEach, describe, it } from "bun:test"
import { expect } from "chai"
import * as sinon from "sinon"
import { WebviewProvider } from "@/core/webview/WebviewProvider"
import { HostProvider } from "@/hosts/host-provider"
import { isCloudSessionsFeatureAvailable, isCloudSessionsFeatureEnabled } from "@/services/cloud/cloudSessionsFeature"

function renderCsp(): string {
	const provider = Object.assign(Object.create(WebviewProvider.prototype), {
		getWebviewUrl: (path: string) => path,
		getCspSource: () => "vscode-resource:",
	}) as WebviewProvider
	const html = provider.getHtmlContent()
	return html.match(/connect-src ([^;]*);/)?.[1] ?? ""
}

describe("Cline services gate", () => {
	let sandbox: sinon.SinonSandbox
	const originalCloudSessions = process.env.CLINE_CLOUD_SESSIONS

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		sandbox.stub(HostProvider, "get").returns({ extensionFsPath: "/ext" } as unknown as ReturnType<typeof HostProvider.get>)
	})

	afterEach(() => {
		sandbox.restore()
		process.env.CLINE_REMOTE_SERVICES = "on"
		if (originalCloudSessions === undefined) delete process.env.CLINE_CLOUD_SESSIONS
		else process.env.CLINE_CLOUD_SESSIONS = originalCloudSessions
	})

	it("allows PostHog and Cline in the webview CSP when remote services are on", () => {
		expect(renderCsp()).to.equal("https://*.posthog.com https://*.cline.bot")
	})

	it("allows no connections from the webview when remote services are disabled", () => {
		process.env.CLINE_REMOTE_SERVICES = "off"

		expect(renderCsp()).to.equal("'none'")
	})

	it("turns cloud sessions off even when forced on for development", () => {
		process.env.CLINE_REMOTE_SERVICES = "off"
		process.env.CLINE_CLOUD_SESSIONS = "1"

		expect(isCloudSessionsFeatureAvailable()).to.equal(false)
		expect(isCloudSessionsFeatureEnabled()).to.equal(false)
	})
})
