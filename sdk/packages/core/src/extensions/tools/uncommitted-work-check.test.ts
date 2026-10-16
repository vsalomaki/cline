import { describe, expect, it } from "vitest";
import { parsePorcelainV2 } from "./uncommitted-work-check";

describe("parsePorcelainV2", () => {
	it("reads HEAD, changed, renamed, unmerged and untracked paths", () => {
		const output = [
			"# branch.oid 1111111111111111111111111111111111111111",
			"# branch.head main",
			"1 .M N... 100644 100644 100644 aaaa bbbb src/a file.ts",
			"2 R. N... 100644 100644 100644 cccc dddd R100 new.ts",
			"old.ts",
			"u UU N... 100644 100644 100644 100644 eeee ffff 0000 conflict.ts",
			"? scratch/",
			"",
		].join("\0");

		const { head, files } = parsePorcelainV2(output);

		expect(head).toBe("1111111111111111111111111111111111111111");
		expect([...files.keys()]).toEqual([
			"src/a file.ts",
			"new.ts",
			"conflict.ts",
			"scratch/",
		]);
		expect(files.get("src/a file.ts")).toEqual({
			untracked: false,
			added: false,
			unstaged: true,
			indexHash: "bbbb",
		});
		expect(files.get("new.ts")).toEqual({
			untracked: false,
			added: false,
			unstaged: false,
			indexHash: "dddd",
		});
		expect(files.get("scratch/")).toEqual({ untracked: true, unstaged: true });
	});

	it("treats an unborn branch as having no HEAD", () => {
		expect(parsePorcelainV2("# branch.oid (initial)\0").head).toBeUndefined();
	});
});
