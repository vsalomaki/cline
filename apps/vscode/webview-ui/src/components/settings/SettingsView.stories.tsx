import type { Meta, StoryObj } from "@storybook/react-vite"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import SettingsView from "./SettingsView"
import type { SettingsNavigationTarget } from "./settingsTargets"

const meta: Meta<typeof SettingsView> = {
	title: "Views/Settings",
	component: SettingsView,
	parameters: { layout: "fullscreen" },
	decorators: [
		createStorybookDecorator(
			{ agentLimits: { values: {}, effective: {}, envOverrides: {} } },
			"max-w-none h-screen flex flex-col",
		),
	],
	args: { onDone: () => {} },
}

export default meta
type Story = StoryObj<typeof SettingsView>

const openTab = (target: SettingsNavigationTarget): Story => ({
	args: { navigationRequest: { target, requestId: 1 } },
})

export const ApiConfiguration = openTab("api-config")
export const Features = openTab("features")
export const AgentBehavior = openTab("agent-behavior")
export const Terminal = openTab("terminal")
export const ContextAndLimits = openTab("agent-limits")
export const General = openTab("general")
