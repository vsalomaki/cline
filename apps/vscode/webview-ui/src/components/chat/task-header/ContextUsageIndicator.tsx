import { buildContextUsageView, formatWindowShare } from "@shared/contextUsageView"
import type { LastContextUsage } from "@shared/getApiMetrics"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatLargeNumber as formatTokenNumber } from "@/utils/format"
import { ContextUsageCard } from "./ContextUsageCard"

interface ContextUsageIndicatorProps {
	usage?: LastContextUsage
	/** The context size for tasks without a breakdown. */
	lastApiReqTotalTokens?: number
	/** The selected model's window, for tasks whose requests carry no breakdown. */
	contextWindow?: number
}

const HOVER_OPEN_DELAY_MS = 300
const HOVER_CLOSE_DELAY_MS = 150

type OpenedBy = "hover" | "pointer" | "keyboard"

const RING_RADIUS = 5
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

const Ring = ({ fraction }: { fraction: number }) => (
	<svg aria-hidden="true" className="size-3 shrink-0 -rotate-90" viewBox="0 0 14 14">
		<circle cx="7" cy="7" fill="none" opacity="0.25" r={RING_RADIUS} stroke="currentColor" strokeWidth="2" />
		<circle
			cx="7"
			cy="7"
			fill="none"
			r={RING_RADIUS}
			stroke="currentColor"
			strokeDasharray={`${Math.min(1, fraction) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
			strokeWidth="2"
		/>
	</svg>
)

/** Share of the context window in the task header's corner; hover or click opens the breakdown. */
export const ContextUsageIndicator: React.FC<ContextUsageIndicatorProps> = ({ usage, lastApiReqTotalTokens, contextWindow }) => {
	const [open, setOpen] = useState(false)
	const openedBy = useRef<OpenedBy>("hover")
	const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
	const view = useMemo(() => (usage ? buildContextUsageView(usage) : undefined), [usage])
	const windowTokens = view?.windowTokens ?? contextWindow ?? 0
	// With a breakdown this is the same number the context bar gets, rescaled after a compaction.
	const usedTokens = view?.usedTokens ?? lastApiReqTotalTokens ?? 0

	const clearHoverTimer = useCallback(() => clearTimeout(hoverTimer.current), [])
	useEffect(() => clearHoverTimer, [clearHoverTimer])

	// A tap fires pointerenter and pointerleave around its click, which would close the card it just opened.
	const scheduleOpen = useCallback(
		(event: React.PointerEvent) => {
			clearHoverTimer()
			if (open || event.pointerType === "touch") {
				return
			}
			hoverTimer.current = setTimeout(() => {
				openedBy.current = "hover"
				setOpen(true)
			}, HOVER_OPEN_DELAY_MS)
		},
		[clearHoverTimer, open],
	)
	const scheduleClose = useCallback(
		(event: React.PointerEvent) => {
			clearHoverTimer()
			if (event.pointerType !== "touch") {
				hoverTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
			}
		},
		[clearHoverTimer],
	)

	// The header row toggles itself on click and Enter, so neither may reach it.
	const stopPropagation = useCallback((event: React.SyntheticEvent) => event.stopPropagation(), [])
	const onTriggerClick = useCallback(
		(event: React.MouseEvent) => {
			event.stopPropagation()
			// Radix would toggle on its own; a click on a hover-opened card must keep it open.
			event.preventDefault()
			clearHoverTimer()
			if (open && openedBy.current !== "hover") {
				setOpen(false)
				return
			}
			// A keyboard-activated click has no pointer position.
			openedBy.current = event.detail === 0 ? "keyboard" : "pointer"
			setOpen(true)
		},
		[clearHoverTimer, open],
	)

	if (!windowTokens || !usedTokens) {
		return null
	}
	const share = formatWindowShare(usedTokens, windowTokens)

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={`Context usage ${share}`}
					className="mx-1 inline-flex shrink-0 items-center gap-1 rounded-full border-0 bg-transparent px-1 py-0.25 text-xs text-foreground opacity-80 hover:opacity-100 cursor-pointer"
					onClick={onTriggerClick}
					onKeyDown={stopPropagation}
					onPointerEnter={scheduleOpen}
					onPointerLeave={scheduleClose}
					type="button">
					<Ring fraction={usedTokens / windowTokens} />
					<span>{share}</span>
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="w-72 max-w-(--radix-popover-content-available-width)"
				collisionPadding={8}
				data-testid="context-usage-card"
				onClick={stopPropagation}
				onCloseAutoFocus={(event) => {
					// A hover card never took focus, so closing it must not steal any.
					if (openedBy.current === "hover") {
						event.preventDefault()
					}
				}}
				onKeyDown={stopPropagation}
				onOpenAutoFocus={(event) => {
					if (openedBy.current !== "keyboard") {
						event.preventDefault()
					}
				}}
				onPointerEnter={clearHoverTimer}
				onPointerLeave={scheduleClose}>
				{view ? (
					<ContextUsageCard view={view} />
				) : (
					<div className="flex justify-between gap-2 text-xs">
						<span className="font-semibold">Context window</span>
						<span className="font-mono">
							{formatTokenNumber(usedTokens)} / {formatTokenNumber(windowTokens)} ({share})
						</span>
					</div>
				)}
			</PopoverContent>
		</Popover>
	)
}
