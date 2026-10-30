import { isRemoteServicesDisabled } from "@shared/services/config/remote-services"
import { VSCodeCheckbox, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import FeatureRow from "../FeatureRow"
import PreferredLanguageSetting from "../PreferredLanguageSetting"
import Section from "../Section"
import { featureSettingControlId, featureSettingElementId } from "../settingsTargets"
import { updateSetting } from "../utils/settingsHandlers"

interface GeneralSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const GeneralSettingsSection = ({ renderSectionHeader }: GeneralSettingsSectionProps) => {
	const {
		telemetrySetting,
		remoteConfigSettings,
		diagnosticsLogEnabled,
		mcpDisplayMode,
		showFeatureTips,
		backgroundEditEnabled,
	} = useExtensionState()

	return (
		<div>
			{renderSectionHeader("general")}
			<Section>
				<PreferredLanguageSetting />

				<div className="my-5" id={featureSettingElementId("mcp-display-mode")}>
					<label className="block mb-1 text-base font-medium" htmlFor={featureSettingControlId("mcp-display-mode")}>
						MCP Display Mode
					</label>
					<Select onValueChange={(v) => updateSetting("mcpDisplayMode", v)} value={mcpDisplayMode}>
						<SelectTrigger className="w-full" id={featureSettingControlId("mcp-display-mode")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="plain">Plain Text</SelectItem>
							<SelectItem value="rich">Rich Display</SelectItem>
							<SelectItem value="markdown">Markdown</SelectItem>
						</SelectContent>
					</Select>
					<p className="text-sm text-description mt-1">Controls how MCP responses are displayed</p>
				</div>

				<div className="mb-3 -mx-1">
					<FeatureRow
						checked={showFeatureTips}
						description="Show rotating tips during the thinking phase to help you discover Cline features."
						id="show-feature-tips"
						label="Feature Tips"
						onChange={(checked) => updateSetting("showFeatureTips", checked)}
					/>
					<FeatureRow
						checked={backgroundEditEnabled}
						description="Allow edits without stealing editor focus"
						id="background-edit"
						label="Background Edit"
						onChange={(checked) => updateSetting("backgroundEditEnabled", checked)}
					/>
					<FeatureRow
						checked={diagnosticsLogEnabled}
						description="Writes memory use and activity counters to the Cline output once a second, for troubleshooting crashes. The log holds no conversation content."
						id="diagnostics-log"
						label="Log memory diagnostics"
						onChange={(checked) => updateSetting("diagnosticsLogEnabled", checked)}
					/>
				</div>

				<div className="mb-[5px]" hidden={isRemoteServicesDisabled()}>
					<Tooltip>
						<TooltipContent hidden={remoteConfigSettings?.telemetrySetting === undefined}>
							This setting is managed by your organization's remote configuration
						</TooltipContent>
						<TooltipTrigger asChild>
							<div className="flex items-center gap-2 mb-[5px]">
								<VSCodeCheckbox
									checked={telemetrySetting !== "disabled"}
									disabled={remoteConfigSettings?.telemetrySetting === "disabled"}
									onChange={(e: any) => {
										const checked = e.target.checked === true
										updateSetting("telemetrySetting", checked ? "enabled" : "disabled")
									}}>
									Allow error and usage reporting
								</VSCodeCheckbox>
								{!!remoteConfigSettings?.telemetrySetting && (
									<i className="codicon codicon-lock text-description text-sm" />
								)}
							</div>
						</TooltipTrigger>
					</Tooltip>

					<p className="text-sm mt-[5px] text-description">
						Help improve Cline by sending usage data and error reports. Reports don't include your code or prompts,
						except for requests to the Cline and ClinePass providers. See our{" "}
						<VSCodeLink
							className="text-inherit"
							href="https://docs.cline.bot/more-info/telemetry"
							style={{ fontSize: "inherit", textDecoration: "underline" }}>
							telemetry overview
						</VSCodeLink>{" "}
						and{" "}
						<VSCodeLink
							className="text-inherit"
							href="https://cline.bot/privacy"
							style={{ fontSize: "inherit", textDecoration: "underline" }}>
							privacy policy
						</VSCodeLink>{" "}
						for more details.
					</p>
				</div>
			</Section>
		</div>
	)
}

export default GeneralSettingsSection
