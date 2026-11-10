import { describe, expect, it } from "vitest";
import { findOutputFilterPipe } from "./helpers";

describe("findOutputFilterPipe", () => {
	it.each([
		["npm test | tail -20", "tail"],
		["npm test 2>&1 | head -100", "head"],
		["npm test 2>&1 | grep -A5 'not ok'", "grep"],
		['npm test | grep -E "FAIL|Error"', "grep"],
		["npm test | sort | head -3", "head"],
		["npm test |& tail -5", "tail"],
		["ps aux | rg node", "rg"],
		["npm test && git log | head", "head"],
		["npm test | tail -5; echo done", "tail"],
		["npm test | egrep 'x'", "egrep"],
	])("finds the filter in %s", (command, filter) => {
		expect(findOutputFilterPipe(command)).toBe(filter);
	});

	it.each([
		"npm test",
		"grep -r needle src",
		"npm test || echo failed",
		"npm test | tee log.txt",
		"echo 'a | tail -5'",
		'echo "a | head"',
		"echo a \\| tail",
		"npm run build | tailwind",
		"tail -f log.txt",
		"npm test; tail -5 log.txt",
		"sleep 2; cat <<EOF\na | head -2\nEOF",
	])("finds no filter in %s", (command) => {
		expect(findOutputFilterPipe(command)).toBeUndefined();
	});
});
