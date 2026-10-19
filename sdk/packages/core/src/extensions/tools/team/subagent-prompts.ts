import {
	buildClineSubAgentSystemPrompt,
	buildClineSystemPrompt,
} from "@cline/shared";
import type { DelegatedAgentRuntimeConfig } from "./delegated-agent";

export function buildTeammateSystemPrompt(
	prompt: string,
	config: DelegatedAgentRuntimeConfig,
): string {
	const trimmedPrompt = prompt.trim();
	if (config.providerId.toLowerCase() !== "cline") {
		return trimmedPrompt;
	}

	return buildClineSystemPrompt({
		ide: config.clineIdeName?.trim() || "Terminal",
		workspaceRoot: config.cwd?.trim() || "/",
		providerId: config.providerId,
		rules: `# Team Teammate Role\n${trimmedPrompt}`,
		platform: config.clinePlatform,
		metadata: config.workspaceMetadata,
	});
}

export function buildSubAgentSystemPrompt(
	// The prompt provided when spawning the subagent
	prompt: string,
	config: DelegatedAgentRuntimeConfig,
): string {
	return buildClineSubAgentSystemPrompt({
		role: prompt,
		ide: config.clineIdeName?.trim() || undefined,
		platform: config.clinePlatform,
		workspaceRoot: config.cwd?.trim() || "/",
		metadata: config.workspaceMetadata,
		mode: config.mode,
		providerId: config.providerId,
	});
}
