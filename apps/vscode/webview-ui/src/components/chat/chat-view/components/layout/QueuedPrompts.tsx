import type { QueuedPrompt } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/cline/common"
import { UpdateQueuedPromptRequest } from "@shared/proto/cline/task"
import { useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"

function truncatePrompt(prompt: string): string {
	const trimmed = prompt.trim()
	return trimmed.length > 96 ? `${trimmed.slice(0, 96)}...` : trimmed
}

function attachmentLabel(count: number): string | undefined {
	if (count <= 0) {
		return undefined
	}
	return count === 1 ? "1 attachment" : `${count} attachments`
}

function queueSummary(items: QueuedPrompt[]): string {
	const steerCount = items.filter((item) => item.delivery === "steer").length
	const queueCount = items.length - steerCount
	if (queueCount === 0) {
		return items.length === 1 ? "Message for the next step" : `${items.length} messages for the next step`
	}
	if (steerCount === 0) {
		return items.length === 1 ? "Message for after the run" : `${items.length} messages for after the run`
	}
	return `${steerCount} for the next step, ${queueCount} after the run`
}

interface QueuedPromptsProps {
	items?: QueuedPrompt[]
}

export function QueuedPrompts({ items = [] }: QueuedPromptsProps) {
	const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())

	if (items.length === 0) {
		return null
	}

	const runRowAction = (promptId: string, action: () => Promise<unknown>, failure: string) => {
		setBusyIds((current) => new Set(current).add(promptId))
		action()
			.catch((error) => {
				console.error(failure, error)
			})
			.finally(() => {
				setBusyIds((current) => {
					const next = new Set(current)
					next.delete(promptId)
					return next
				})
			})
	}

	const cancelQueuedPrompt = (promptId: string) =>
		runRowAction(
			promptId,
			() => TaskServiceClient.cancelQueuedPrompt(StringRequest.create({ value: promptId })),
			"Failed to cancel queued prompt:",
		)

	const toggleDelivery = (item: QueuedPrompt) =>
		runRowAction(
			item.id,
			() =>
				TaskServiceClient.updateQueuedPrompt(
					UpdateQueuedPromptRequest.create({
						promptId: item.id,
						delivery: item.delivery === "steer" ? "queue" : "steer",
					}),
				),
			"Failed to update queued prompt:",
		)

	return (
		<div className="mx-3 mt-2.5 mb-2.5 rounded-xs border border-editor-group-border bg-code/70 px-2.5 py-2 shadow-xs">
			<div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-description">
				<span aria-hidden="true" className="codicon codicon-clock text-[12px]" />
				<span>{queueSummary(items)}</span>
			</div>
			<div className="flex max-h-28 flex-col gap-1.5 overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
				{items.map((item) => {
					const attachments = attachmentLabel(item.attachmentCount)
					const isSteer = item.delivery === "steer"
					const isBusy = busyIds.has(item.id)
					// The prompt text renders in spans whose line boxes are 5 spacing units tall
					// (the global `span { @apply leading-5 }` base style), so every control in the
					// row is sized/offset against that same 5-unit first line to stay vertically
					// centered with it: the dot ((5 - 1.5) / 2 units), the h-5 badges, and the
					// size-5 (26px) cancel button pulled in by -my-1.5 ((5u - size-5) / 2).
					return (
						<div
							className="flex items-start gap-2 rounded-[3px] bg-input-background/40 px-2 py-1.5 text-xs"
							key={item.id}>
							<span aria-hidden="true" className="mt-1.75 size-1.5 shrink-0 rounded-full bg-description/70" />
							<span className="min-w-0 flex-1 break-words text-foreground">{truncatePrompt(item.prompt)}</span>
							<button
								aria-label={isSteer ? "Send after the run instead" : "Send at the next step instead"}
								className="flex h-5 shrink-0 items-center rounded-[3px] border border-editor-group-border px-1.5 text-[10px] leading-none text-description hover:bg-toolbar-hover-background hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								disabled={isBusy}
								onClick={() => toggleDelivery(item)}
								title={
									isSteer
										? "Reaches the agent at its next step. Click to send it after the run instead."
										: "Sent as a new message after the run. Click to send it at the next step instead."
								}
								type="button">
								{isSteer ? "Next step" : "After run"}
							</button>
							{attachments && (
								<span className="flex h-5 shrink-0 items-center rounded-[3px] border border-editor-group-border px-1.5 text-[10px] leading-none text-description">
									{attachments}
								</span>
							)}
							<button
								aria-label="Cancel queued message"
								className="-my-1.5 flex size-5 shrink-0 items-center justify-center rounded-[3px] text-description hover:bg-toolbar-hover-background hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								disabled={isBusy}
								onClick={() => cancelQueuedPrompt(item.id)}
								title="Cancel queued message"
								type="button">
								<span aria-hidden="true" className="codicon codicon-close text-[12px]" />
							</button>
						</div>
					)
				})}
			</div>
		</div>
	)
}
