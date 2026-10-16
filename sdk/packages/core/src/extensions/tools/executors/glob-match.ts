/**
 * Glob matching for list_files. Supports `**`, `*`, `?`, `{a,b}` and `[...]`.
 * Patterns are matched against `/`-separated paths relative to the searched
 * directory; a pattern without `/` matches the file name at any depth.
 */

export function globToRegExp(pattern: string): RegExp {
	let normalized = pattern
		.trim()
		.replace(/^(\.\/)+/, "")
		.replace(/^\/+/, "");
	if (!normalized.includes("/")) {
		normalized = `**/${normalized}`;
	}
	return new RegExp(`^${translate(normalized)}$`);
}

function translate(glob: string): string {
	let out = "";
	let i = 0;
	while (i < glob.length) {
		const char = glob[i];
		if (char === "*") {
			if (glob[i + 1] === "*") {
				let end = i + 2;
				while (glob[end] === "*") end++;
				if (glob[end] === "/") {
					out += "(?:.*/)?";
					i = end + 1;
				} else {
					out += ".*";
					i = end;
				}
			} else {
				out += "[^/]*";
				i++;
			}
		} else if (char === "?") {
			out += "[^/]";
			i++;
		} else if (char === "{") {
			const close = findClosingBrace(glob, i);
			if (close === -1) {
				out += "\\{";
				i++;
			} else {
				const options = splitTopLevel(glob.slice(i + 1, close));
				out += `(?:${options.map(translate).join("|")})`;
				i = close + 1;
			}
		} else if (char === "[") {
			const close = glob.indexOf("]", i + 2);
			if (close === -1) {
				out += "\\[";
				i++;
			} else {
				out += translateClass(glob.slice(i + 1, close));
				i = close + 1;
			}
		} else if (char === "\\" && i + 1 < glob.length) {
			out += escapeRegExp(glob[i + 1]);
			i += 2;
		} else {
			out += escapeRegExp(char);
			i++;
		}
	}
	return out;
}

function translateClass(body: string): string {
	const negated = body[0] === "!" || body[0] === "^";
	const members = (negated ? body.slice(1) : body).replace(/[\\\]^]/g, "\\$&");
	return `[${negated ? "^" : ""}${members}]`;
}

function findClosingBrace(glob: string, open: number): number {
	let depth = 0;
	for (let i = open; i < glob.length; i++) {
		if (glob[i] === "\\") {
			i++;
		} else if (glob[i] === "{") {
			depth++;
		} else if (glob[i] === "}" && --depth === 0) {
			return i;
		}
	}
	return -1;
}

function splitTopLevel(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		if (body[i] === "\\") {
			i++;
		} else if (body[i] === "{") {
			depth++;
		} else if (body[i] === "}") {
			depth--;
		} else if (body[i] === "," && depth === 0) {
			parts.push(body.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(body.slice(start));
	return parts;
}

function escapeRegExp(char: string): string {
	return char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
