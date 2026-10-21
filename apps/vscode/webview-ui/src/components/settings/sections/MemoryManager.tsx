import { EmptyRequest } from "@shared/proto/cline/common"
import { type MemoryItem, type MemoryList, MemoryRequest } from "@shared/proto/cline/memory"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { MemoryServiceClient } from "@/services/grpc-client"

type Scope = "project" | "user"

const request = (scope: Scope, name = "") => MemoryRequest.create({ scope, name })
const CONFIRM_MS = 4000

function logError(action: string) {
	return (error: unknown) => console.error(`Failed to ${action}:`, error)
}

interface ScopeListProps {
	title: string
	detail?: string
	scope: Scope
	items: MemoryItem[]
	confirming?: string
	onDelete: (item: MemoryItem) => void
}

const ScopeList = ({ title, detail, scope, items, confirming, onDelete }: ScopeListProps) => (
	<div className="space-y-1.5" data-testid={`memory-${scope}`}>
		<div className="flex items-center justify-between gap-2">
			<div className="min-w-0">
				<div className="text-xs font-medium text-foreground">{title}</div>
				{detail && <div className="ph-no-capture text-xs text-description truncate">{detail}</div>}
			</div>
			<Button
				onClick={() => MemoryServiceClient.openMemoryIndex(request(scope)).catch(logError("open the memory index"))}
				size="xs"
				variant="ghost">
				Open index
			</Button>
		</div>
		{items.length === 0 ? (
			<p className="text-xs text-description">No {scope} memories yet.</p>
		) : (
			<ul className="space-y-1">
				{items.map((item) => (
					<li className="flex items-start justify-between gap-2 py-1" key={item.slug}>
						<div className="ph-no-capture min-w-0 text-xs break-words">
							<span className="font-medium text-foreground">{item.name}</span>
							{item.description && <span className="text-description"> — {item.description}</span>}
						</div>
						<div className="flex shrink-0 gap-1">
							<Button
								aria-label={`Open ${item.name}`}
								onClick={() =>
									MemoryServiceClient.openMemory(request(scope, item.slug)).catch(logError("open the memory"))
								}
								size="xs"
								variant="ghost">
								Open
							</Button>
							<Button aria-label={`Delete ${item.name}`} onClick={() => onDelete(item)} size="xs" variant="ghost">
								{confirming === `${scope}/${item.slug}` ? "Confirm delete" : "Delete"}
							</Button>
						</div>
					</li>
				))}
			</ul>
		)}
	</div>
)

const MemoryManager = () => {
	const [list, setList] = useState<MemoryList | undefined>()
	const [open, setOpen] = useState(false)
	const [confirming, setConfirming] = useState<string | undefined>()

	useEffect(() => {
		if (!confirming) {
			return
		}
		const timer = setTimeout(() => setConfirming(undefined), CONFIRM_MS)
		return () => clearTimeout(timer)
	}, [confirming])

	const refresh = useCallback(() => {
		MemoryServiceClient.listMemories(EmptyRequest.create()).then(setList).catch(logError("list memories"))
	}, [])

	const toggle = () => {
		if (!open) {
			refresh()
		}
		setOpen(!open)
	}

	const remove = (item: MemoryItem) => {
		const key = `${item.scope}/${item.slug}`
		if (confirming !== key) {
			setConfirming(key)
			return
		}
		setConfirming(undefined)
		MemoryServiceClient.deleteMemory(request(item.scope as Scope, item.slug))
			.then(setList)
			.catch(logError("delete the memory"))
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<Button onClick={toggle} size="sm" variant="secondary">
					{open ? "Hide memories" : "Manage memories"}
				</Button>
				{open && (
					<Button onClick={refresh} size="sm" variant="ghost">
						Refresh
					</Button>
				)}
			</div>
			{open && list && (
				<div className="space-y-3">
					<ScopeList
						confirming={confirming}
						detail={list.projectKey}
						items={list.project}
						onDelete={remove}
						scope="project"
						title="Project memory"
					/>
					<ScopeList confirming={confirming} items={list.user} onDelete={remove} scope="user" title="User memory" />
				</div>
			)}
		</div>
	)
}

export default MemoryManager
