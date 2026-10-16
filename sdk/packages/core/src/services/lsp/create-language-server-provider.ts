import type { BasicLogger } from "@cline/shared";
import type {
	CodeIntelligenceProvider,
	LanguageServerSettings,
} from "../../extensions/tools/code-intelligence/types";
import { LspCodeIntelligence } from "./lsp-code-intelligence";
import { resolveLanguageServers } from "./servers";

export interface LanguageServerProviderInput {
	workspaceRoot: string;
	settings?: LanguageServerSettings;
	logger?: BasicLogger;
}

export interface SessionCodeIntelligence {
	provider: CodeIntelligenceProvider;
	/** Called once when the session ends. */
	release(): Promise<void>;
}

/**
 * Creates the SDK's language-server-backed provider for a session whose host
 * supplied none. Server binaries are looked up now, so a session where none
 * is installed gets no provider; servers start on first use.
 */
export function createLanguageServerProvider(
	input: LanguageServerProviderInput,
): SessionCodeIntelligence | undefined {
	const { available, unavailable } = resolveLanguageServers(input.settings, {
		root: input.workspaceRoot,
	});
	if (available.length === 0) {
		return undefined;
	}
	const provider = new LspCodeIntelligence({
		root: input.workspaceRoot,
		servers: available,
		unavailable,
		logger: input.logger,
	});
	return { provider, release: () => provider.release() };
}
