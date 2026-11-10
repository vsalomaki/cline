import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
	prepareToolResultPreview,
	prepareToolResultRecovery,
} from "./tool-result-cache";

describe("tool result preview and recovery text", () => {
	it("preserves structured fields and multiline text in YAML while leaving strings unchanged", () => {
		const output = {
			content: [{ type: "text", text: "first\nsecond\nthird" }],
			isError: false,
			structuredContent: { count: 3 },
		};
		const { text } = prepareToolResultRecovery(output);
		expect(YAML.parse(text ?? "")).toEqual(output);
		expect(text).toContain("text: |-\n");
		expect(text).not.toContain("first\\nsecond");
		expect(prepareToolResultRecovery("first\nsecond").text).toBe(
			"first\nsecond",
		);
		expect(prepareToolResultRecovery(undefined).text).toBeUndefined();
	});

	it.each([
		"mediaType",
		"mimeType",
	])("excludes %s image bytes from recovery text", (mimeField) => {
		const image = {
			type: "image" as const,
			data: "x".repeat(17 * 1024 * 1024),
			[mimeField]: "image/png",
		};
		const { text, images } = prepareToolResultRecovery([
			{ type: "text", text: "recover me".repeat(1000) },
			image,
		]);
		expect(images).toEqual([
			{ type: "image", data: image.data, mediaType: "image/png" },
		]);
		const preview = prepareToolResultPreview([image]);
		expect(preview.images).toEqual(images);
		expect(preview.text).not.toContain(image.data);
		expect(text).toContain("[image attached]");
		expect(text).toContain("recover me");
		expect(text?.length).toBeLessThan(11000);
	});

	it("serializes the preview of structured output as indented JSON", () => {
		const { text, images } = prepareToolResultPreview({ a: 1 });
		expect(text).toBe(JSON.stringify({ a: 1 }, null, 2));
		expect(images).toEqual([]);
		expect(prepareToolResultPreview("plain").text).toBe("plain");
	});
});
