const SUMMARY_KEYS = [
	"commands",
	"command",
	"files",
	"paths",
	"path",
	"file_path",
	"queries",
	"query",
	"pattern",
	"regex",
	"requests",
	"urls",
	"url",
	"skill",
] as const;
const MAX_SUMMARY_CHARS = 200;

/** A one-line description of a tool call from its input: the command, paths, queries or URLs. */
export function describeToolCall(input: unknown): string {
	const parts: string[] = [];
	const visit = (value: unknown, depth: number): void => {
		if (parts.join(", ").length >= MAX_SUMMARY_CHARS || depth > 3) return;
		if (typeof value === "string") {
			parts.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry, depth + 1);
			return;
		}
		if (!value || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		if (typeof record.command === "string" && Array.isArray(record.args)) {
			parts.push([record.command, ...record.args.map(String)].join(" "));
			return;
		}
		if (typeof record.path === "string" && record.start_line != null) {
			parts.push(
				`${record.path}:${record.start_line}-${record.end_line ?? "end"}`,
			);
			return;
		}
		for (const key of SUMMARY_KEYS) {
			if (key in record) visit(record[key], depth + 1);
		}
	};
	visit(input, 0);
	const text =
		parts.length > 0 ? parts.join(", ") : (JSON.stringify(input) ?? "");
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > MAX_SUMMARY_CHARS
		? `${oneLine.slice(0, MAX_SUMMARY_CHARS - 1)}…`
		: oneLine;
}
