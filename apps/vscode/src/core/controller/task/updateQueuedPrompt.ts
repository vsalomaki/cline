import { Empty } from "@shared/proto/cline/common"
import type { UpdateQueuedPromptRequest } from "@shared/proto/cline/task"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

export async function updateQueuedPrompt(controller: Controller, request: UpdateQueuedPromptRequest): Promise<Empty> {
	if (request.delivery !== "queue" && request.delivery !== "steer") {
		throw new Error(`Unknown queued prompt delivery: ${request.delivery}`)
	}
	try {
		await controller.updateQueuedPrompt(request.promptId, request.delivery)
		return Empty.create()
	} catch (error) {
		Logger.error("Error in updateQueuedPrompt handler:", error)
		throw error
	}
}
