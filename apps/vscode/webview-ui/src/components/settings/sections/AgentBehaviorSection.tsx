import Section from "../Section"
import { AgentLimitsPanel } from "./AgentLimitsSection"

interface AgentBehaviorSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const AgentBehaviorSection = ({ renderSectionHeader }: AgentBehaviorSectionProps) => (
	<div className="mb-2">
		{renderSectionHeader("agent-behavior")}
		<Section>
			<AgentLimitsPanel tab="agent-behavior" />
		</Section>
	</div>
)

export default AgentBehaviorSection
