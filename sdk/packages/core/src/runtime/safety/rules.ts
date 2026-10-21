import type { AgentExtensionRule } from "@cline/shared";
import type {
	RuleConfig,
	UserInstructionConfigWatcher,
} from "../../extensions/config/user-instruction-config-loader";

export function isRuleEnabled(rule: RuleConfig): boolean {
	return rule.disabled !== true;
}

export function formatRulesForSystemPrompt(
	rules: ReadonlyArray<RuleConfig>,
): string {
	if (rules.length === 0) {
		return "";
	}

	const renderedRules = rules.map(formatRuleSection).join("\n\n");
	return `\n\n# Rules\n${renderedRules}`;
}

function formatRuleSection(rule: RuleConfig): string {
	return `## ${rule.name}\n${rule.instructions}`;
}

/** The system prompt rule for a set of rule files, with each file's size. */
export function createRulesPromptRule(input: {
	id: string;
	source: string;
	listRules: () => RuleConfig[];
}): AgentExtensionRule {
	return {
		id: input.id,
		source: input.source,
		content: () => formatRulesForSystemPrompt(input.listRules()),
		files: () =>
			input.listRules().map((rule) => ({
				name: rule.name,
				chars: formatRuleSection(rule).length,
			})),
	};
}

export function mergeRulesForSystemPrompt(
	primaryRules?: string,
	additionalRules?: string,
): string | undefined {
	const primary = primaryRules?.trim();
	const additional = additionalRules?.trim();
	if (primary && additional) {
		return `${primary}\n\n${additional}`;
	}
	return primary || additional || undefined;
}

/**
 * The rules a session's system prompt includes, from any source that can list
 * rule records: enabled rules only, in a stable name order. Every renderer of
 * the rules section goes through this one selection so they cannot drift.
 */
export function listEnabledRulesFromRecords(
	records: ReadonlyArray<{ item: RuleConfig }>,
): RuleConfig[] {
	return records
		.map((record) => record.item)
		.filter(isRuleEnabled)
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadRulesForSystemPromptFromRecords(
	records: ReadonlyArray<{ item: RuleConfig }>,
): string {
	return formatRulesForSystemPrompt(listEnabledRulesFromRecords(records));
}

export function listEnabledRulesFromWatcher(
	watcher: UserInstructionConfigWatcher,
): RuleConfig[] {
	const snapshot = watcher.getSnapshot("rule");
	return listEnabledRulesFromRecords(
		[...snapshot.values()].map((record) => ({
			item: record.item as RuleConfig,
		})),
	);
}
