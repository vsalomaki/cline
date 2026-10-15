import {
	AGENT_LIMIT_DEFINITIONS,
	AGENT_LIMIT_GROUPS,
	type AgentLimitDefinition,
	type AgentLimitId,
	type AgentLimitsState,
	type AgentLimitUnit,
} from "@shared/AgentLimits"
import { VSCodeButton, VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import React, { useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

interface AgentLimitsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const UNIT_LABELS: Record<AgentLimitUnit, string> = {
	chars: "characters",
	bytes: "bytes",
	lines: "lines",
	milliseconds: "seconds",
	count: "times",
	tokens: "tokens",
	percent: "%",
	toggle: "",
}

/** Timeouts are stored in ms but edited in seconds; everything else is edited as stored. */
const toDisplay = (definition: AgentLimitDefinition, stored: number) =>
	definition.unit === "milliseconds" ? stored / 1000 : stored

const fromDisplay = (definition: AgentLimitDefinition, shown: number) =>
	definition.unit === "milliseconds" ? Math.round(shown * 1000) : Math.round(shown)

const formatNumber = (value: number) => value.toLocaleString("en-US")

const textFor = (definition: AgentLimitDefinition, value: number | undefined) =>
	value === undefined ? "" : String(toDisplay(definition, value))

const saveLimit = (id: AgentLimitId, value: number | undefined) => {
	updateSetting("agentLimitUpdates", { [id]: value ?? -1 })
}

interface LimitFieldProps {
	definition: AgentLimitDefinition
	limits: AgentLimitsState
	disabled?: boolean
}

/**
 * Number input for one limit. Saves on blur or Enter rather than per keystroke,
 * since each change rebuilds the active session. An empty field resets the
 * limit to its default.
 */
const LimitField: React.FC<LimitFieldProps> = ({ definition, limits, disabled }) => {
	const id = definition.id as AgentLimitId
	const stored = limits.values[id]
	const envVar = limits.envOverrides[id]
	const effective = limits.effective[id]
	const unit = UNIT_LABELS[definition.unit]
	const min = toDisplay(definition, definition.min)
	const max = toDisplay(definition, definition.max)

	const [text, setText] = useState(textFor(definition, stored))
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		setText(textFor(definition, stored))
		setError(null)
	}, [definition, stored])

	const validate = (value: string): string | null => {
		const trimmed = value.trim()
		if (trimmed === "") {
			return null
		}
		const parsed = Number(trimmed)
		if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
			return `Enter ${formatNumber(min)}–${formatNumber(max)}, or leave empty for the default`
		}
		return null
	}

	const handleBlur = () => {
		if (error) {
			setText(textFor(definition, stored))
			setError(null)
			return
		}
		const trimmed = text.trim()
		const next = trimmed === "" ? undefined : fromDisplay(definition, Number(trimmed))
		if (next !== stored) {
			saveLimit(id, next)
		}
	}

	const inputId = `agent-limit-${id.replace(".", "-")}`
	const shownEffective = effective === undefined ? undefined : toDisplay(definition, effective)
	const configured = toDisplay(definition, stored ?? definition.default)

	return (
		<div className="mb-4">
			<label className="font-medium block mb-1" htmlFor={inputId}>
				{definition.label}
				{unit && <span className="font-normal text-(--vscode-descriptionForeground)"> ({unit})</span>}
			</label>
			<VSCodeTextField
				className="w-full"
				disabled={disabled || envVar !== undefined}
				id={inputId}
				onBlur={handleBlur}
				onChange={(event) => {
					const value = (event.target as HTMLInputElement).value
					setText(value)
					setError(validate(value))
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						;(event.target as HTMLElement).blur()
					}
				}}
				placeholder={`Default: ${formatNumber(toDisplay(definition, definition.default))}`}
				value={text}
			/>
			{error && <div className="text-(--vscode-errorForeground) text-xs mt-1">{error}</div>}
			{envVar && (
				<div className="text-(--vscode-editorWarning-foreground) text-xs mt-1">
					Set by <code>{envVar}</code> in the editor's environment
					{shownEffective === undefined ? " (off)" : `: ${formatNumber(shownEffective)}`}. Unset it to edit here.
				</div>
			)}
			{!envVar && shownEffective !== undefined && shownEffective !== configured && (
				<div className="text-(--vscode-descriptionForeground) text-xs mt-1">
					In effect: {formatNumber(shownEffective)}, adjusted so tool output fits the tool result cap.
				</div>
			)}
			<p className="text-xs text-(--vscode-descriptionForeground) mt-1">{definition.description}</p>
		</div>
	)
}

const LimitToggle: React.FC<{ definition: AgentLimitDefinition; limits: AgentLimitsState }> = ({ definition, limits }) => {
	const id = definition.id as AgentLimitId
	const checked = (limits.values[id] ?? definition.default) === 1
	return (
		<div className="mb-4">
			<VSCodeCheckbox
				checked={checked}
				onChange={(event) => {
					const next = (event.target as HTMLInputElement).checked ? 1 : 0
					saveLimit(id, next === definition.default ? undefined : next)
				}}>
				{definition.label}
			</VSCodeCheckbox>
			<p className="text-xs text-(--vscode-descriptionForeground) mt-1">{definition.description}</p>
		</div>
	)
}

const AgentLimitsSection = ({ renderSectionHeader }: AgentLimitsSectionProps) => {
	const { agentLimits } = useExtensionState()

	if (!agentLimits) {
		return <div>{renderSectionHeader("agent-limits")}</div>
	}

	const loopDetectionOn = (agentLimits.values["session.loopDetection"] ?? 1) === 1
	const hasChanges = Object.keys(agentLimits.values).length > 0

	const resetAll = () => {
		updateSetting("agentLimitUpdates", Object.fromEntries(Object.keys(agentLimits.values).map((id) => [id, -1])))
	}

	return (
		<div>
			{renderSectionHeader("agent-limits")}
			<Section>
				<p className="text-xs text-(--vscode-descriptionForeground)">
					Changes apply to the current task once it is idle. Leave a field empty to use the default. Env vars the editor
					was launched with take precedence.
				</p>
				{AGENT_LIMIT_GROUPS.map((group) => (
					<div className="mb-2" id={`agent-limits-${group.id}`} key={group.id}>
						<h4 className="text-sm font-semibold mt-2 mb-1">{group.title}</h4>
						<p className="text-xs text-(--vscode-descriptionForeground) mb-3">{group.description}</p>
						{AGENT_LIMIT_DEFINITIONS.filter((definition) => definition.group === group.id).map((definition) =>
							definition.unit === "toggle" ? (
								<LimitToggle definition={definition} key={definition.id} limits={agentLimits} />
							) : (
								<LimitField
									definition={definition}
									disabled={definition.id.startsWith("session.loop") && !loopDetectionOn}
									key={definition.id}
									limits={agentLimits}
								/>
							),
						)}
					</div>
				))}
				<div>
					<VSCodeButton appearance="secondary" disabled={!hasChanges} onClick={resetAll}>
						Reset all to defaults
					</VSCodeButton>
				</div>
			</Section>
		</div>
	)
}

export default AgentLimitsSection
