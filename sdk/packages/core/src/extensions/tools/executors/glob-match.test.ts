import { describe, expect, it } from "vitest";
import { globToRegExp } from "./glob-match";

const matches = (pattern: string, candidate: string) =>
	globToRegExp(pattern).test(candidate);

describe("globToRegExp", () => {
	it("matches a pattern without a slash against the file name at any depth", () => {
		expect(matches("*.ts", "a.ts")).toBe(true);
		expect(matches("*.ts", "src/deep/a.ts")).toBe(true);
		expect(matches("*.ts", "a.tsx")).toBe(false);
		expect(matches("*.ts", "src/a.ts/b.js")).toBe(false);
	});

	it("treats `*` as anything except a slash", () => {
		expect(matches("src/*.ts", "src/a.ts")).toBe(true);
		expect(matches("src/*.ts", "src/util/a.ts")).toBe(false);
		expect(matches("src/*/a.ts", "src/util/a.ts")).toBe(true);
	});

	it("matches zero or more directories with `**/`", () => {
		expect(matches("**/a.ts", "a.ts")).toBe(true);
		expect(matches("**/a.ts", "x/y/a.ts")).toBe(true);
		expect(matches("src/**/a.ts", "src/a.ts")).toBe(true);
		expect(matches("src/**/a.ts", "src/x/y/a.ts")).toBe(true);
		expect(matches("src/**/a.ts", "lib/a.ts")).toBe(false);
	});

	it("matches everything below a directory with a trailing `**`", () => {
		expect(matches("src/**", "src/a.ts")).toBe(true);
		expect(matches("src/**", "src/x/y.ts")).toBe(true);
		expect(matches("src/**", "lib/a.ts")).toBe(false);
	});

	it("treats `?` as one non-slash character", () => {
		expect(matches("a?.ts", "ab.ts")).toBe(true);
		expect(matches("a?.ts", "a.ts")).toBe(false);
		expect(matches("src/a?b", "src/a/b")).toBe(false);
	});

	it("supports `{a,b}` alternation, including nested and path-containing options", () => {
		expect(matches("*.{ts,tsx}", "a.tsx")).toBe(true);
		expect(matches("*.{ts,tsx}", "a.js")).toBe(false);
		expect(matches("*.{ts,{js,mjs}}", "a.mjs")).toBe(true);
		expect(matches("{src,lib}/**/*.ts", "lib/x/a.ts")).toBe(true);
		expect(matches("{src,lib}/**/*.ts", "app/a.ts")).toBe(false);
	});

	it("supports `[...]` classes and negation", () => {
		expect(matches("file[0-9].txt", "file7.txt")).toBe(true);
		expect(matches("file[0-9].txt", "filex.txt")).toBe(false);
		expect(matches("file[!0-9].txt", "filex.txt")).toBe(true);
		expect(matches("file[!0-9].txt", "file7.txt")).toBe(false);
		expect(matches("[ab].ts", "b.ts")).toBe(true);
	});

	it("escapes regex specials in the pattern", () => {
		expect(matches("a.ts", "a.ts")).toBe(true);
		expect(matches("a.ts", "abts")).toBe(false);
		expect(matches("c++.md", "c++.md")).toBe(true);
		expect(matches("c++.md", "cc.md")).toBe(false);
		expect(matches("(a)|b$.txt", "(a)|b$.txt")).toBe(true);
	});

	it("treats unbalanced `{` and `[` as literals", () => {
		expect(matches("a{b.txt", "a{b.txt")).toBe(true);
		expect(matches("a[b.txt", "a[b.txt")).toBe(true);
	});

	it("honours a backslash escape", () => {
		expect(matches("a\\*.txt", "a*.txt")).toBe(true);
		expect(matches("a\\*.txt", "ab.txt")).toBe(false);
	});

	it("ignores a leading ./ or /", () => {
		expect(matches("./src/*.ts", "src/a.ts")).toBe(true);
		expect(matches("/src/*.ts", "src/a.ts")).toBe(true);
	});

	it("matches dotfiles", () => {
		expect(matches("*.json", ".eslintrc.json")).toBe(true);
		expect(matches("**/*", ".github/workflows/ci.yml")).toBe(true);
	});
});
