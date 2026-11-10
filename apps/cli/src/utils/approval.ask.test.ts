import { afterEach, describe, expect, it } from "vitest";
import { askQuestionInTerminal, NO_USER_TO_ASK_ANSWER } from "./approval";

describe("askQuestionInTerminal without a terminal", () => {
	const stdinTTY = process.stdin.isTTY;

	afterEach(() => {
		process.stdin.isTTY = stdinTTY;
	});

	it("says no one could answer instead of picking the first option", async () => {
		process.stdin.isTTY = false;

		const answer = await askQuestionInTerminal("Which median?", [
			"Return the lower middle value",
			"Keep the average",
		]);

		expect(answer).toBe(NO_USER_TO_ASK_ANSWER);
		expect(answer).not.toContain("lower middle");
	});
});
