import { type DelegationMode, resolveDelegationMode } from "@shared/Delegation"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { memo, type ReactNode } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useExtensionState } from "@/context/ExtensionStateContext"
import FeatureRow from "../FeatureRow"
import Section from "../Section"
import { featureSettingControlId, featureSettingElementId } from "../settingsTargets"
import { updateSetting, updateSettings } from "../utils/settingsHandlers"
import MemoryManager from "./MemoryManager"

// Interface for feature toggle configuration
interface FeatureToggle {
	id: string
	label: string
	description: ReactNode
	settingKey: keyof UpdateSettingsRequest
	stateKey: string
}

const DELEGATION_DESCRIPTIONS: Record<DelegationMode, string> = {
	off: "Cline does all the work itself.",
	subagents:
		"Cline can hand focused tasks to subagents that run in parallel while it waits for them. You approve each handoff; the subagent then reads and edits files without asking.",
	teams: "Cline can also start teammates that work in the background while it continues and you keep talking to it. Teammates keep their role across tasks, and Cline can message, wait for or cancel them. You approve each teammate and each task; teammates then read and edit files without asking.",
}

const agentFeatures: FeatureToggle[] = [
	{
		id: "auto-compact",
		label: "Auto Compact",
		description: "Automatically compress conversation history.",
		stateKey: "useAutoCondense",
		settingKey: "useAutoCondense",
	},
]

const workspaceFeatures: FeatureToggle[] = [
	{
		id: "checkpoints",
		label: "Checkpoints",
		description: "Save progress at key points for easy rollback",
		stateKey: "enableCheckpointsSetting",
		settingKey: "enableCheckpointsSetting",
	},
	{
		id: "worktrees",
		label: "Worktrees",
		description: "Enables git worktree management for running parallel Cline tasks.",
		stateKey: "worktreesEnabled",
		settingKey: "worktreesEnabled",
	},
]

const advancedFeatures: FeatureToggle[] = [
	{
		id: "hooks",
		label: "Hooks",
		description: "Enable lifecycle and tool hooks during task execution.",
		stateKey: "hooksEnabled",
		settingKey: "hooksEnabled",
	},
]

function updateDelegation(mode: DelegationMode) {
	updateSettings({ subagentsEnabled: mode !== "off", agentTeamsEnabled: mode === "teams" })
}

interface FeatureSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const FeatureSettingsSection = ({ renderSectionHeader }: FeatureSettingsSectionProps) => {
	const {
		enableCheckpointsSetting,
		hooksEnabled,
		useAutoCondense,
		compactionStrategy,
		webSearchEnabled,
		subagentsEnabled,
		agentTeamsEnabled,
		memoryEnabled,
		memoryExtractAfterRun,
		worktreesEnabled,
		cloudSessionsAvailable,
		cloudSessionsEnabled,
	} = useExtensionState()

	// State lookup for mapped features
	const featureState: Record<string, boolean | undefined> = {
		enableCheckpointsSetting,
		hooksEnabled,
		useAutoCondense,
		worktreesEnabled: worktreesEnabled?.user,
	}

	const delegation = resolveDelegationMode({ subagentsEnabled, agentTeamsEnabled })

	// Visibility lookup for features with feature flags
	const featureVisibility: Record<string, boolean | undefined> = {
		worktreesEnabled: worktreesEnabled?.featureFlag,
	}

	return (
		<div className="mb-2">
			{renderSectionHeader("features")}
			<Section>
				<div className="mb-5 flex flex-col gap-3">
					{/* Core features */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Agent</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="agent-features">
							<div className="space-y-2 py-3" id={featureSettingElementId("delegation")}>
								<Label
									className="text-sm font-medium text-foreground"
									htmlFor={featureSettingControlId("delegation")}>
									Delegation
								</Label>
								<p className="text-xs text-muted-foreground">{DELEGATION_DESCRIPTIONS[delegation]}</p>
								<Select onValueChange={(value) => updateDelegation(value as DelegationMode)} value={delegation}>
									<SelectTrigger className="w-full" id={featureSettingControlId("delegation")}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="off">Off</SelectItem>
										<SelectItem value="subagents">Subagents</SelectItem>
										<SelectItem value="teams">Agent teams</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<FeatureRow
								checked={memoryEnabled}
								description="Cline saves what a later task would otherwise have to find out again: project memory per git repository, user memory for your preferences. Both are stored outside the repository."
								id="memory"
								label="Memory"
								onChange={(checked) => updateSetting("memoryEnabled", checked)}
							/>
							<div className="pl-4 pb-3 space-y-3">
								<FeatureRow
									checked={memoryExtractAfterRun}
									description="Check a finished request for memories once the task is idle."
									disabled={!memoryEnabled}
									id="memory-extract"
									label="Save memories automatically"
									onChange={(checked) => updateSetting("memoryExtractAfterRun", checked)}
								/>
								<MemoryManager />
							</div>
							{agentFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									id={feature.id}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}
							<div className="space-y-2 py-3">
								<Label className="text-sm font-medium text-foreground">Auto Compact Strategy</Label>
								<p className="text-xs text-muted-foreground">Controls how auto compaction rewrites context.</p>
								<Select
									disabled={!useAutoCondense}
									onValueChange={(value) => updateSetting("compactionStrategy", value)}
									value={compactionStrategy ?? "agentic"}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="basic">Basic</SelectItem>
										<SelectItem value="agentic">Agentic</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<FeatureRow
								checked={webSearchEnabled}
								description="Let the model search the web when the selected provider and model support it. Applies to new tasks."
								label="Web Search"
								onChange={(checked) => updateSetting("webSearchEnabled", checked)}
							/>
							<FeatureRow
								checked={cloudSessionsEnabled}
								description="Run Cline on your GitHub repositories in secure cloud sandboxes. Adds a Cloud option to the new task composer. Requires a Cline account with GitHub connected."
								id="cloud-sessions"
								isVisible={!!cloudSessionsAvailable}
								label="Cloud"
								onChange={(checked) => updateSetting("cloudSessionsEnabled", checked)}
							/>
						</div>
					</div>

					{/* Workspace features */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Workspace</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="optional-features">
							{workspaceFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									id={feature.id}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}
						</div>
					</div>
				</div>

				{/* Advanced */}
				<div>
					<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Advanced</div>
					<div className="relative p-3 my-3 rounded-md border border-editor-widget-border/50" id="advanced-features">
						<div className="space-y-3">
							{advancedFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									id={feature.id}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}
						</div>
					</div>
				</div>
			</Section>
		</div>
	)
}
export default memo(FeatureSettingsSection)
