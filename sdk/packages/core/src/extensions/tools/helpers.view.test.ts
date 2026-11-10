import { describe, expect, it } from "vitest";
import { normalizeRunCommandsView } from "./helpers";

describe("normalizeRunCommandsView", () => {
	it("returns an empty view for input that is not an object", () => {
		expect(normalizeRunCommandsView(undefined)).toEqual({});
		expect(normalizeRunCommandsView(null)).toEqual({});
		expect(normalizeRunCommandsView("ls")).toEqual({});
		expect(normalizeRunCommandsView(["ls"])).toEqual({});
	});

	it("returns an empty view when no view field is set", () => {
		expect(normalizeRunCommandsView({ commands: ["ls"] })).toEqual({});
	});

	it("extracts all four fields", () => {
		expect(
			normalizeRunCommandsView({
				commands: ["npm test"],
				head_lines: 5,
				tail_lines: 40,
				grep: "FAIL|Error",
				context_lines: 3,
			}),
		).toEqual({
			head_lines: 5,
			tail_lines: 40,
			grep: "FAIL|Error",
			context_lines: 3,
		});
	});

	it("coerces numbers given as strings", () => {
		expect(
			normalizeRunCommandsView({
				head_lines: "5",
				tail_lines: "40",
				context_lines: "0",
			}),
		).toEqual({ head_lines: 5, tail_lines: 40, context_lines: 0 });
	});

	it("ignores invalid fields and keeps the valid ones", () => {
		expect(
			normalizeRunCommandsView({
				head_lines: 0,
				tail_lines: -3,
				grep: "",
				context_lines: 21,
			}),
		).toEqual({});
		expect(
			normalizeRunCommandsView({
				head_lines: 1.5,
				tail_lines: "many",
				grep: 42,
				context_lines: 20,
			}),
		).toEqual({ context_lines: 20 });
		expect(
			normalizeRunCommandsView({ head_lines: "abc", tail_lines: 7 }),
		).toEqual({ tail_lines: 7 });
	});

	it("accepts the context_lines bounds", () => {
		expect(normalizeRunCommandsView({ context_lines: 0 })).toEqual({
			context_lines: 0,
		});
		expect(normalizeRunCommandsView({ context_lines: -1 })).toEqual({});
	});

	it("drops null and undefined values", () => {
		expect(
			normalizeRunCommandsView({
				head_lines: undefined,
				tail_lines: null,
				grep: undefined,
			}),
		).toEqual({});
	});
});
