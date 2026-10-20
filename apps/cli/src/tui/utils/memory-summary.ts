import type { describeMemory } from "@cline/core";

type MemoryDescription = Awaited<ReturnType<typeof describeMemory>>;

export function formatMemorySummary(
	memory: MemoryDescription,
	enabled: boolean,
): string {
	const status = enabled
		? "Memory is on."
		: 'Memory is off. Turn it on with --memory, or with "memory": { "enabled": true } in global-settings.json.';
	return [
		status,
		"",
		`Project memory (${memory.projectKey})`,
		memory.projectDir,
		memory.projectIndex.trim() || "(none)",
		"",
		"User memory",
		memory.userDir,
		memory.userIndex.trim() || "(none)",
	].join("\n");
}
