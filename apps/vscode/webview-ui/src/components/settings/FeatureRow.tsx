import { memo, type ReactNode } from "react"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { featureSettingControlId, featureSettingElementId } from "./settingsTargets"

export interface FeatureRowProps {
	id?: string
	checked: boolean | undefined
	onChange: (checked: boolean) => void
	label: string
	description: ReactNode
	disabled?: boolean
	isRemoteLocked?: boolean
	remoteTooltip?: string
	isVisible?: boolean
}

const FeatureRow = memo(
	({
		id,
		checked = false,
		onChange,
		label,
		description,
		disabled,
		isRemoteLocked,
		isVisible = true,
		remoteTooltip,
	}: FeatureRowProps) => {
		if (!isVisible) {
			return null
		}
		const switchId = id ? featureSettingControlId(id) : label

		const checkbox = (
			<div className="flex items-center justify-between w-full">
				<label htmlFor={switchId}>{label}</label>
				<div>
					<Switch
						checked={checked}
						className="shrink-0"
						disabled={disabled || isRemoteLocked}
						id={switchId}
						onCheckedChange={onChange}
						size="lg"
					/>
					{isRemoteLocked && <i className="codicon codicon-lock text-description text-sm" />}
				</div>
			</div>
		)

		return (
			<div
				className="flex flex-col items-start justify-between gap-4 py-3 px-1 w-full rounded-xs border border-transparent"
				id={id ? featureSettingElementId(id) : undefined}>
				<div className="space-y-0.5 flex-1 w-full">
					{isRemoteLocked ? (
						<Tooltip>
							<TooltipTrigger asChild>{checkbox}</TooltipTrigger>
							<TooltipContent className="max-w-xs" side="top">
								{remoteTooltip}
							</TooltipContent>
						</Tooltip>
					) : (
						checkbox
					)}
				</div>
				<div className="text-xs text-description">{description}</div>
			</div>
		)
	},
)

export default FeatureRow
