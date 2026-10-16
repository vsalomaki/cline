import type { CodeIntelligenceProvider } from "./types";

/**
 * An in-memory provider for tests: every lookup is empty unless overridden,
 * and `diagnostics` knows no file, so a problems check takes its baseline
 * from `diagnosticsAfterChange`.
 */
export function createFakeCodeIntelligence(
	overrides: Partial<CodeIntelligenceProvider> = {},
): CodeIntelligenceProvider & { prepared: string[] } {
	const prepared: string[] = [];
	return {
		prepared,
		definition: async () => [],
		implementation: async () => [],
		references: async () => [],
		hover: async () => undefined,
		documentSymbols: async () => [],
		workspaceSymbols: async () => [],
		diagnostics: async () => new Map(),
		prepare: (filePath) => {
			prepared.push(filePath);
		},
		diagnosticsAfterChange: async () => new Map(),
		...overrides,
	};
}
