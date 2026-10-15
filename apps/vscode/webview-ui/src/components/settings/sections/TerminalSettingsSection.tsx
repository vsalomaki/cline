import {
	DEFAULT_BACKGROUND_COMMAND_TIMEOUT_MS,
	DEFAULT_FOREGROUND_COMMAND_AUTO_PROCEED_MS,
	MAX_COMMAND_TIMEOUT_MS,
	MIN_COMMAND_TIMEOUT_MS,
} from "@shared/CommandTimeouts"
import { UpdateTerminalConnectionTimeoutResponse } from "@shared/proto/index.cline"
import { VSCodeCheckbox, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import React, { useEffect, useState } from "react"
import { PlatformType } from "@/config/platform.config"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { usePlatform } from "@/context/PlatformContext"
import { StateServiceClient } from "../../../services/grpc-client"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

interface TerminalSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

interface CommandTimeoutFieldProps {
	id: string
	label: string
	description: string
	setting: "backgroundCommandTimeoutMs" | "foregroundCommandAutoProceedMs"
	valueMs: number | undefined
	defaultMs: number
}

const toSecondsText = (ms: number | undefined) => (ms === undefined ? "" : (ms / 1000).toString())

const validateSecondsText = (text: string): string | null => {
	const trimmed = text.trim()
	if (trimmed === "") {
		return null
	}
	const seconds = Number(trimmed)
	if (!Number.isFinite(seconds) || seconds < MIN_COMMAND_TIMEOUT_MS / 1000 || seconds > MAX_COMMAND_TIMEOUT_MS / 1000) {
		return `Enter ${MIN_COMMAND_TIMEOUT_MS / 1000}-${MAX_COMMAND_TIMEOUT_MS / 1000} seconds, or leave empty for the default`
	}
	return null
}

/**
 * Seconds input for a run_commands timeout. Saves on blur or Enter rather than
 * per keystroke, since each change rebuilds the active session's tools. An
 * empty field resets the setting to its default.
 */
const CommandTimeoutField: React.FC<CommandTimeoutFieldProps> = ({ id, label, description, setting, valueMs, defaultMs }) => {
	const [text, setText] = useState(toSecondsText(valueMs))
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		setText(toSecondsText(valueMs))
		setError(null)
	}, [valueMs])

	const handleChange = (event: Event) => {
		const value = (event.target as HTMLInputElement).value
		setText(value)
		setError(validateSecondsText(value))
	}

	const handleBlur = () => {
		if (error) {
			setText(toSecondsText(valueMs))
			setError(null)
			return
		}
		const trimmed = text.trim()
		const nextMs = trimmed === "" ? undefined : Math.round(Number(trimmed) * 1000)
		if (nextMs !== valueMs) {
			updateSetting(setting, nextMs ?? 0)
		}
	}

	return (
		<div className="mb-4">
			<div className="mb-2">
				<label className="font-medium block mb-1" htmlFor={id}>
					{label}
				</label>
				<VSCodeTextField
					className="w-full"
					id={id}
					onBlur={handleBlur}
					onChange={(event) => handleChange(event as Event)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							;(event.target as HTMLElement).blur()
						}
					}}
					placeholder={`Default: ${defaultMs / 1000}`}
					value={text}
				/>
				{error && <div className="text-(--vscode-errorForeground) text-xs mt-1">{error}</div>}
			</div>
			<p className="text-xs text-(--vscode-descriptionForeground)">{description}</p>
		</div>
	)
}

const TerminalSettingsSection: React.FC<TerminalSettingsSectionProps> = ({ renderSectionHeader }) => {
	const {
		shellIntegrationTimeout,
		terminalReuseEnabled,
		defaultTerminalProfile,
		availableTerminalProfiles,
		vscodeTerminalExecutionMode,
		backgroundCommandTimeoutMs,
		foregroundCommandAutoProceedMs,
	} = useExtensionState()
	const platformConfig = usePlatform()
	const isVsCodePlatform = platformConfig.type === PlatformType.VSCODE
	const executionMode = vscodeTerminalExecutionMode ?? "vscodeTerminal"
	const isBackgroundExec = executionMode === "backgroundExec"

	const [inputValue, setInputValue] = useState((shellIntegrationTimeout / 1000).toString())
	const [inputError, setInputError] = useState<string | null>(null)

	const handleTimeoutChange = (event: Event) => {
		const target = event.target as HTMLInputElement
		const value = target.value

		setInputValue(value)

		const seconds = Number.parseFloat(value)
		if (Number.isNaN(seconds) || seconds <= 0) {
			setInputError("Please enter a positive number")
			return
		}

		setInputError(null)
		const timeoutMs = Math.round(seconds * 1000)

		StateServiceClient.updateTerminalConnectionTimeout({ timeoutMs })
			.then((response: UpdateTerminalConnectionTimeoutResponse) => {
				const timeoutMs = response.timeoutMs
				// Backend calls postStateToWebview(), so state will update via subscription
				// Just sync the input value with the confirmed backend value
				if (timeoutMs !== undefined) {
					setInputValue((timeoutMs / 1000).toString())
				}
			})
			.catch((error) => {
				console.error("Failed to update terminal connection timeout:", error)
			})
	}

	const handleInputBlur = () => {
		if (inputError) {
			setInputValue((shellIntegrationTimeout / 1000).toString())
			setInputError(null)
		}
	}

	const handleTerminalReuseChange = (event: Event) => {
		const target = event.target as HTMLInputElement
		const checked = target.checked
		updateSetting("terminalReuseEnabled", checked)
	}

	const handleExecutionModeChange = (event: Event) => {
		const target = event.target as HTMLSelectElement
		const value = target.value === "backgroundExec" ? "backgroundExec" : "vscodeTerminal"
		updateSetting("vscodeTerminalExecutionMode", value)
	}

	// Use any to avoid type conflicts between Event and FormEvent
	const handleDefaultTerminalProfileChange = (event: any) => {
		const target = event.target as HTMLSelectElement
		const profileId = target.value

		// Save immediately using the consolidated updateSettings approach
		updateSetting("defaultTerminalProfile", profileId || "default")
	}

	const profilesToShow = availableTerminalProfiles

	return (
		<div>
			{renderSectionHeader("terminal")}
			<Section>
				<div className="mb-5" id="terminal-settings-section">
					{isVsCodePlatform && (
						<div className="mb-4">
							<label className="font-medium block mb-1" htmlFor="terminal-execution-mode">
								Terminal Execution Mode
							</label>
							<VSCodeDropdown
								className="w-full"
								id="terminal-execution-mode"
								onChange={(event) => handleExecutionModeChange(event as Event)}
								value={executionMode}>
								<VSCodeOption value="vscodeTerminal">VS Code Terminal</VSCodeOption>
								<VSCodeOption value="backgroundExec">Background Exec</VSCodeOption>
							</VSCodeDropdown>
							<p className="text-xs text-[var(--vscode-descriptionForeground)] mt-1">
								Choose whether Cline runs commands in the VS Code terminal or a background process.
							</p>
						</div>
					)}

					{(!isVsCodePlatform || isBackgroundExec) && (
						<CommandTimeoutField
							defaultMs={DEFAULT_BACKGROUND_COMMAND_TIMEOUT_MS}
							description={`Commands still running after this long are stopped. Leave empty for the default (${DEFAULT_BACKGROUND_COMMAND_TIMEOUT_MS / 1000} seconds).`}
							id="background-command-timeout"
							label="Command timeout (seconds)"
							setting="backgroundCommandTimeoutMs"
							valueMs={backgroundCommandTimeoutMs}
						/>
					)}

					{isVsCodePlatform && !isBackgroundExec && (
						<>
							<CommandTimeoutField
								defaultMs={DEFAULT_FOREGROUND_COMMAND_AUTO_PROCEED_MS}
								description={`If a command is still running after this long, Cline continues the task and leaves the command running in the terminal. Leave empty for the default (${DEFAULT_FOREGROUND_COMMAND_AUTO_PROCEED_MS / 1000} seconds).`}
								id="foreground-command-auto-proceed"
								label="Proceed while running after (seconds)"
								setting="foregroundCommandAutoProceedMs"
								valueMs={foregroundCommandAutoProceedMs}
							/>

							<div className="mb-4">
								<div className="mb-2">
									<label className="font-medium block mb-1">Shell integration timeout (seconds)</label>
									<div className="flex items-center">
										<VSCodeTextField
											className="w-full"
											onBlur={handleInputBlur}
											onChange={(event) => handleTimeoutChange(event as Event)}
											placeholder="Enter timeout in seconds"
											value={inputValue}
										/>
									</div>
									{inputError && (
										<div className="text-(--vscode-errorForeground) text-xs mt-1">{inputError}</div>
									)}
								</div>
								<p className="text-xs text-(--vscode-descriptionForeground)">
									Set how long Cline waits for shell integration to activate before executing commands. Increase
									this value if you experience terminal connection timeouts.
								</p>
							</div>

							<div className="mb-4">
								<div className="flex items-center mb-2">
									<VSCodeCheckbox
										checked={terminalReuseEnabled ?? true}
										onChange={(event) => handleTerminalReuseChange(event as Event)}>
										Enable aggressive terminal reuse
									</VSCodeCheckbox>
								</div>
								<p className="text-xs text-(--vscode-descriptionForeground)">
									When enabled, Cline will reuse existing terminal windows that aren't in the current working
									directory. Disable this if you experience issues with task lockout after a terminal command.
								</p>
							</div>
						</>
					)}

					{/* Terminal choice affects both foreground and background execution mode. */}
					<div className="mb-4">
						<label className="font-medium block mb-1" htmlFor="default-terminal-profile">
							Default Terminal Profile
						</label>
						<VSCodeDropdown
							className="w-full"
							id="default-terminal-profile"
							onChange={handleDefaultTerminalProfileChange}
							value={defaultTerminalProfile || "default"}>
							{profilesToShow.map((profile) => (
								<VSCodeOption key={profile.id} title={profile.description} value={profile.id}>
									{profile.name}
								</VSCodeOption>
							))}
						</VSCodeDropdown>
						<p className="text-xs text-(--vscode-descriptionForeground) mt-1">
							Select the default terminal Cline will use. 'Default' uses your VSCode global setting.
						</p>
					</div>
					<div className="mt-5 p-3 bg-(--vscode-textBlockQuote-background) rounded border border-(--vscode-textBlockQuote-border)">
						<p className="text-[13px] m-0">
							<strong>Having terminal issues?</strong> Check our{" "}
							<a
								className="text-(--vscode-textLink-foreground) underline hover:no-underline"
								href="https://docs.cline.bot/troubleshooting/terminal-quick-fixes"
								rel="noopener noreferrer"
								target="_blank">
								Terminal Quick Fixes
							</a>{" "}
							or the{" "}
							<a
								className="text-(--vscode-textLink-foreground) underline hover:no-underline"
								href="https://docs.cline.bot/troubleshooting/terminal-integration-guide"
								rel="noopener noreferrer"
								target="_blank">
								Complete Troubleshooting Guide
							</a>
							.
						</p>
					</div>
				</div>
			</Section>
		</div>
	)
}

export default TerminalSettingsSection
