import type { BasicLogger } from "@cline/shared";
import type {
	CodeIntelligenceProvider,
	LanguageServerSettings,
} from "../../extensions/tools/code-intelligence/types";

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
 * supplied none. Returns undefined when no language server is available.
 */
export function createLanguageServerProvider(
	_input: LanguageServerProviderInput,
): SessionCodeIntelligence | undefined {
	return undefined;
}
