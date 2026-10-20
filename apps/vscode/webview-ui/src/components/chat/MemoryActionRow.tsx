import type { ClineSayMemory } from "@shared/ExtensionMessage"
import { MemoryRequest } from "@shared/proto/cline/memory"
import { BrainIcon } from "lucide-react"
import { MemoryServiceClient } from "@/services/grpc-client"

const DONE_VERBS: Record<ClineSayMemory["action"], string> = {
	save: "Saved",
	update: "Updated",
	delete: "Deleted",
	view: "Viewed",
}

function memoryTitle(memory: ClineSayMemory): string {
	if (memory.error) {
		return `Couldn't ${memory.action} ${memory.scope} memory`
	}
	if (memory.automatic) {
		return `Memory saved automatically (${memory.scope})`
	}
	if (memory.action === "view" && !memory.name) {
		return `Viewed the ${memory.scope} memory index`
	}
	return `${DONE_VERBS[memory.action]} ${memory.scope} memory`
}

function openMemoryFile(memory: Pick<ClineSayMemory, "scope" | "name">): void {
	if (!memory.name) {
		return
	}
	MemoryServiceClient.openMemory(MemoryRequest.create({ scope: memory.scope, name: memory.name })).catch((error) => {
		console.error("Failed to open memory:", error)
	})
}

interface MemoryActionRowProps {
	memory: ClineSayMemory
	canOpen: boolean
}

const MemoryActionRow = ({ memory, canOpen }: MemoryActionRowProps) => {
	const title = memoryTitle(memory)
	if (memory.action === "view" && !memory.error) {
		return (
			<div className="flex items-center gap-2.5 text-description">
				<BrainIcon className="size-2 shrink-0" />
				<span className="ph-no-capture truncate">{memory.name ? `${title}: ${memory.name}` : title}</span>
			</div>
		)
	}

	const openable = canOpen && !memory.error && memory.action !== "delete" && !!memory.name
	const summary = (
		<>
			<span className="font-medium">{memory.name}</span>
			{memory.description && <span className="text-description"> — {memory.description}</span>}
		</>
	)
	return (
		<div>
			<div className="flex items-center gap-2.5 mb-3">
				<BrainIcon className="size-2 shrink-0" />
				<span className="font-bold">{title}</span>
			</div>
			{memory.name &&
				(openable ? (
					<button
						className="w-full text-left bg-code border border-editor-group-border rounded-xs py-[9px] px-2.5 cursor-pointer break-words"
						onClick={() => openMemoryFile(memory)}
						title="Open the memory file"
						type="button">
						<span className="ph-no-capture">{summary}</span>
					</button>
				) : (
					<div className="bg-code border border-editor-group-border rounded-xs py-[9px] px-2.5 break-words">
						<span className="ph-no-capture">{summary}</span>
					</div>
				))}
			{memory.error && <div className="mt-2 text-xs text-error break-words">{memory.error}</div>}
		</div>
	)
}

export default MemoryActionRow
