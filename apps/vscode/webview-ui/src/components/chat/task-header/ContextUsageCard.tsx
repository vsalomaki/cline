import type { ContextUsageCategory, ContextUsageCategoryId, ContextUsageView } from "@shared/contextUsageView"
import { formatWindowShare } from "@shared/contextUsageView"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import React, { memo, useCallback, useState } from "react"
import { formatLargeNumber as formatTokenNumber } from "@/utils/format"

const CATEGORY_COLORS: Record<ContextUsageCategoryId, string> = {
	system: "var(--vscode-charts-blue)",
	rules: "var(--vscode-charts-purple)",
	memory: "var(--vscode-charts-yellow)",
	tools: "var(--vscode-charts-orange)",
	messages: "var(--vscode-charts-green)",
	files: "var(--vscode-terminal-ansiCyan)",
}

const Swatch = ({ color }: { color?: string }) => (
	<span
		aria-hidden="true"
		className="inline-block size-2 shrink-0 rounded-[2px] bg-code-foreground/20"
		style={color ? { backgroundColor: color } : undefined}
	/>
)

const UsageRow = memo<{ label: string; tokens: number; windowTokens: number; color?: string; muted?: boolean }>(
	({ label, tokens, windowTokens, color, muted }) => (
		<span className={muted ? "flex justify-between gap-2 text-muted-foreground" : "flex justify-between gap-2"}>
			<span className="flex items-center gap-1.5 min-w-0">
				{!muted && <Swatch color={color} />}
				<span className="truncate">{label}</span>
			</span>
			<span className="font-mono shrink-0">
				{formatTokenNumber(tokens)}{" "}
				<span className="text-muted-foreground">{formatWindowShare(tokens, windowTokens)}</span>
			</span>
		</span>
	),
)
UsageRow.displayName = "UsageRow"

const CategoryRow = memo<{ category: ContextUsageCategory; windowTokens: number }>(({ category, windowTokens }) => {
	const [expanded, setExpanded] = useState(false)
	const toggle = useCallback((event: React.MouseEvent) => {
		event.preventDefault()
		event.stopPropagation()
		setExpanded((value) => !value)
	}, [])
	const row = (
		<UsageRow
			color={CATEGORY_COLORS[category.id]}
			label={category.label}
			tokens={category.tokens}
			windowTokens={windowTokens}
		/>
	)
	if (category.items.length === 0) {
		return <div className="pl-4">{row}</div>
	}
	return (
		<div>
			<button
				aria-expanded={expanded}
				className="flex w-full items-center gap-1 p-0 border-0 bg-transparent text-inherit text-left cursor-pointer hover:bg-foreground/5 rounded"
				onClick={toggle}
				type="button">
				{expanded ? (
					<ChevronDownIcon className="shrink-0" size={12} />
				) : (
					<ChevronRightIcon className="shrink-0" size={12} />
				)}
				<span className="block flex-1 min-w-0">{row}</span>
			</button>
			{expanded && (
				<div className="ml-7 my-0.5 space-y-0.5">
					{category.items.map((item) => (
						<UsageRow key={item.id} label={item.label} muted tokens={item.tokens} windowTokens={windowTokens} />
					))}
				</div>
			)}
		</div>
	)
})
CategoryRow.displayName = "CategoryRow"

const StackedBar = ({ view }: { view: ContextUsageView }) => {
	const { windowTokens, compactAtTokens } = view
	const percent = (tokens: number) => `${Math.min(100, (tokens / windowTokens) * 100)}%`
	return (
		<div className="relative" data-testid="context-usage-bar">
			<div className="flex h-2 w-full overflow-hidden rounded-full bg-code-foreground/20">
				{view.categories.map((category) => (
					<div
						key={category.id}
						style={{ width: percent(category.tokens), backgroundColor: CATEGORY_COLORS[category.id] }}
						title={category.label}
					/>
				))}
			</div>
			{compactAtTokens !== undefined && compactAtTokens < windowTokens && (
				<div
					className="absolute -top-0.5 -bottom-0.5 w-0.5 rounded-full bg-foreground"
					data-testid="context-usage-compaction-marker"
					style={{ left: percent(compactAtTokens) }}
					title="Auto-compaction starts here"
				/>
			)}
		</div>
	)
}

/** What filled the context window at the latest request, by category. */
export const ContextUsageCard: React.FC<{ view: ContextUsageView }> = ({ view }) => {
	const { usedTokens, windowTokens, compactAtTokens } = view
	return (
		<div className="flex flex-col gap-2 text-xs">
			<div className="flex justify-between gap-2">
				<span className="font-semibold">Context window</span>
				<span className="font-mono">
					{formatTokenNumber(usedTokens)} / {formatTokenNumber(windowTokens)} (
					{formatWindowShare(usedTokens, windowTokens)})
				</span>
			</div>
			{view.compactedAfter && (
				<span className="text-muted-foreground">
					The context was compacted after the last request. The rows below describe that request; the next request
					updates them.
				</span>
			)}
			<StackedBar view={view} />
			<div className="flex flex-col gap-0.5">
				{view.categories.map((category) => (
					<CategoryRow category={category} key={category.id} windowTokens={windowTokens} />
				))}
				<div className="pl-4">
					<UsageRow label="Free space" tokens={view.freeTokens} windowTokens={windowTokens} />
				</div>
			</div>
			<span className="text-muted-foreground">
				{compactAtTokens === undefined
					? "Auto-compaction is off"
					: `Compacts at ${formatTokenNumber(compactAtTokens)} tokens (${formatWindowShare(compactAtTokens, windowTokens)})`}
			</span>
		</div>
	)
}
