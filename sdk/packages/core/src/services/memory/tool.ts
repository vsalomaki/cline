import {
	type AgentExtension,
	type AgentTool,
	createTool,
	validateWithZod,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import { MEMORY_SAVE_BAR, readMemoryPromptSection } from "./recall";
import { type MemoryEntry, type MemoryStore, memorySlug } from "./store";

export const MEMORY_TOOL_NAME = "memory";

const MemoryToolInputSchema = z.object({
	action: z
		.enum(["save", "update", "delete", "view"])
		.describe(
			"save adds a memory, update replaces one, delete removes one, view reads one (or the index when name is omitted)",
		),
	scope: z
		.enum(["project", "user"])
		.describe(
			"project: this repository. user: preferences that apply everywhere",
		),
	name: z
		.string()
		.optional()
		.describe("Short name; also the file name. Required except for view"),
	description: z
		.string()
		.optional()
		.describe("One line for the index. Required for save and update"),
	content: z
		.string()
		.optional()
		.describe("The memory itself. Required for save and update"),
});

type MemoryToolInput = z.infer<typeof MemoryToolInputSchema>;

const WRITE_DONE = {
	save: "Saved",
	update: "Updated",
	delete: "Deleted",
} as const;

/** Whether a memory tool result reports a write; refusals come back as plain text too. */
export function isMemoryWriteDone(output: string): boolean {
	return Object.values(WRITE_DONE).some((verb) =>
		output.startsWith(`${verb} `),
	);
}

function formatEntry(entry: MemoryEntry): string {
	return `# ${entry.name}\n${entry.description}\n\n${entry.content}`;
}

export function runMemoryToolAction(
	store: MemoryStore,
	input: MemoryToolInput,
): string {
	const { action, scope } = input;
	const name = input.name?.trim() ?? "";
	if (action === "view" && !name) {
		return store.readIndex(scope).trim() || `No ${scope} memories yet.`;
	}
	if (!name) {
		return `The ${action} action needs a name.`;
	}
	if (action === "view") {
		const entry = store.get(scope, name);
		return entry
			? formatEntry(entry)
			: `No ${scope} memory named "${memorySlug(name) ?? name}".`;
	}
	if (action === "delete") {
		const result = store.delete(scope, name);
		return result.ok
			? `${WRITE_DONE.delete} ${scope} memory "${result.slug}".`
			: result.error;
	}
	const result = store.write(
		scope,
		{
			name,
			description: input.description ?? "",
			content: input.content ?? "",
		},
		action,
	);
	if (!result.ok) return result.error;
	return `${WRITE_DONE[action]} ${scope} memory "${result.entry.slug}".`;
}

export function createMemoryTool(
	store: MemoryStore,
): AgentTool<MemoryToolInput, string> {
	return createTool<MemoryToolInput, string>({
		name: MEMORY_TOOL_NAME,
		description: `Read and keep notes that last across sessions: project memory for this repository, user memory for preferences that apply everywhere. The index of both is in the system prompt. ${MEMORY_SAVE_BAR} Never save secrets.`,
		inputSchema: zodToJsonSchema(MemoryToolInputSchema),
		retryable: false,
		maxRetries: 0,
		execute: async (input) =>
			runMemoryToolAction(store, validateWithZod(MemoryToolInputSchema, input)),
	});
}

/** The memory tool and the recalled index, for the lead agent only. */
export function createMemoryExtension(store: MemoryStore): AgentExtension {
	// Read once, so saves during the session leave the system prompt (and its cache) unchanged.
	const section = readMemoryPromptSection(store);
	return {
		name: "cline-memory",
		manifest: { capabilities: ["rules", "tools"] },
		setup(api) {
			api.registerRule({
				id: "cline-memory:index",
				source: "memory",
				content: section,
				whenToolAvailable: MEMORY_TOOL_NAME,
			});
			api.registerTool(createMemoryTool(store) as AgentTool);
		},
	};
}
