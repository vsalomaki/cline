import { access } from "node:fs/promises";
import type { AgentToolContext } from "@cline/shared";
import { displayPath, formatDiagnostic } from "./format";
import type {
	CodeDiagnostic,
	CodeIntelligenceProvider,
	ProblemsAfterEditLevel,
} from "./types";

const MAX_PROBLEMS_PER_FILE = 20;

export interface ProblemsAfterEditOptions {
	level: Exclude<ProblemsAfterEditLevel, "off">;
	timeoutMs: number;
}

/** Tool context metadata that hands the provider and settings to the executors. */
export function createCodeIntelligenceMetadata(
	provider: CodeIntelligenceProvider | undefined,
	settings: {
		problemsAfterEdit: ProblemsAfterEditLevel;
		problemsTimeoutMs: number;
	},
): Record<string, unknown> {
	if (!provider) {
		return {};
	}
	return {
		codeIntelligence: provider,
		...(settings.problemsAfterEdit !== "off"
			? {
					problemsAfterEdit: {
						level: settings.problemsAfterEdit,
						timeoutMs: settings.problemsTimeoutMs,
					} satisfies ProblemsAfterEditOptions,
				}
			: {}),
	};
}

export function getCodeIntelligence(
	metadata: Record<string, unknown> | undefined,
): CodeIntelligenceProvider | undefined {
	const value = metadata?.codeIntelligence as
		| CodeIntelligenceProvider
		| undefined;
	return typeof value?.diagnosticsAfterChange === "function"
		? value
		: undefined;
}

function getProblemsAfterEditOptions(
	metadata: Record<string, unknown> | undefined,
): ProblemsAfterEditOptions | undefined {
	return metadata?.problemsAfterEdit as ProblemsAfterEditOptions | undefined;
}

function diagnosticKey(diagnostic: CodeDiagnostic): string {
	return JSON.stringify([
		diagnostic.severity,
		diagnostic.message,
		diagnostic.source ?? "",
		diagnostic.code ?? "",
	]);
}

/**
 * The `after` entries left once each `before` entry removes one match.
 * Positions are ignored, so problems the edit only moved are not new.
 */
export function diffNewProblems(
	before: CodeDiagnostic[],
	after: CodeDiagnostic[],
): CodeDiagnostic[] {
	const remaining = new Map<string, number>();
	for (const diagnostic of before) {
		const key = diagnosticKey(diagnostic);
		remaining.set(key, (remaining.get(key) ?? 0) + 1);
	}
	return after.filter((diagnostic) => {
		const key = diagnosticKey(diagnostic);
		const count = remaining.get(key) ?? 0;
		if (count > 0) {
			remaining.set(key, count - 1);
			return false;
		}
		return true;
	});
}

export function filterBySeverity(
	diagnostics: CodeDiagnostic[],
	level: ProblemsAfterEditOptions["level"],
): CodeDiagnostic[] {
	return diagnostics.filter(
		(diagnostic) =>
			diagnostic.severity === "error" ||
			(level === "warnings" && diagnostic.severity === "warning"),
	);
}

export function formatNewProblems(
	problemsByPath: Map<string, CodeDiagnostic[]>,
	cwd: string,
): string {
	const sections: string[] = [];
	for (const [filePath, problems] of problemsByPath) {
		if (problems.length === 0) {
			continue;
		}
		sections.push(
			displayPath(filePath, cwd),
			...problems
				.slice(0, MAX_PROBLEMS_PER_FILE)
				.map((problem) => `  ${formatDiagnostic(problem)}`),
		);
		if (problems.length > MAX_PROBLEMS_PER_FILE) {
			sections.push(
				`  … ${problems.length - MAX_PROBLEMS_PER_FILE} more not shown`,
			);
		}
	}
	return sections.length > 0
		? `New problems after this edit:\n${sections.join("\n")}`
		: "";
}

export interface ProblemsCheck {
	/** Text to append to the tool result after a successful write; empty when there is nothing new. */
	report(cwd: string): Promise<string>;
}

function exists(filePath: string): Promise<boolean> {
	return access(filePath).then(
		() => true,
		() => false,
	);
}

/**
 * Problems in `paths` before the edit. A file the provider knows nothing
 * about yet is checked first, so its existing problems are not reported as
 * new; a file whose check fails is left out.
 */
async function problemsBefore(
	provider: CodeIntelligenceProvider,
	paths: string[],
	options: ProblemsAfterEditOptions,
	signal: AbortSignal | undefined,
): Promise<Map<string, CodeDiagnostic[]>> {
	const before = new Map(await provider.diagnostics(paths));
	const unknown = paths.filter((filePath) => !before.has(filePath));
	const onDisk = await Promise.all(unknown.map(exists));
	const existing: string[] = [];
	for (const [index, filePath] of unknown.entries()) {
		if (onDisk[index]) {
			existing.push(filePath);
		} else {
			before.set(filePath, []);
		}
	}
	if (existing.length > 0) {
		const baseline = await provider
			.diagnosticsAfterChange(existing, {
				timeoutMs: options.timeoutMs,
				signal,
			})
			.catch(() => new Map<string, CodeDiagnostic[]>());
		for (const filePath of existing) {
			const diagnostics = baseline.get(filePath);
			if (diagnostics) {
				before.set(filePath, diagnostics);
			}
		}
	}
	return before;
}

/**
 * Snapshots the problems in `paths` before an edit. A provider failure or
 * timeout skips the report; it never fails the edit.
 */
export async function startProblemsCheck(
	context: AgentToolContext,
	paths: string[],
): Promise<ProblemsCheck | undefined> {
	const provider = getCodeIntelligence(context.metadata);
	const options = getProblemsAfterEditOptions(context.metadata);
	if (!provider || !options || paths.length === 0) {
		return undefined;
	}
	let before: Map<string, CodeDiagnostic[]>;
	try {
		before = await problemsBefore(provider, paths, options, context.signal);
	} catch {
		return undefined;
	}
	const checked = paths.filter((filePath) => before.has(filePath));
	if (checked.length === 0) {
		return undefined;
	}
	return {
		report: async (cwd) => {
			try {
				const after = await provider.diagnosticsAfterChange(checked, {
					timeoutMs: options.timeoutMs,
					signal: context.signal,
				});
				const problems = new Map<string, CodeDiagnostic[]>();
				for (const filePath of checked) {
					problems.set(
						filePath,
						filterBySeverity(
							diffNewProblems(
								before.get(filePath) ?? [],
								after.get(filePath) ?? [],
							),
							options.level,
						),
					);
				}
				const text = formatNewProblems(problems, cwd);
				return text ? `\n\n${text}` : "";
			} catch {
				return "";
			}
		},
	};
}
