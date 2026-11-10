import type { ImageContent } from "@cline/shared";
import YAML from "yaml";

/** Keep native images on the media path for both text representations. */
function splitToolResultMedia(output: unknown): {
	textual: unknown;
	images: ImageContent[];
} {
	const images: ImageContent[] = [];
	function extract(value: unknown): unknown {
		if (value !== null && typeof value === "object") {
			if (
				"type" in value &&
				value.type === "image" &&
				"data" in value &&
				typeof value.data === "string"
			) {
				if ("mediaType" in value && typeof value.mediaType === "string") {
					images.push(value as ImageContent);
					return "[image attached]";
				}
				if ("mimeType" in value && typeof value.mimeType === "string") {
					images.push({
						type: "image",
						data: value.data,
						mediaType: value.mimeType,
					});
					return "[image attached]";
				}
			}
			if (Array.isArray(value)) return value.map(extract);
			return Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [key, extract(entry)]),
			);
		}
		return value;
	}
	return { textual: extract(output), images };
}

/** Size and truncate the persisted representation sent to the model. */
export function prepareToolResultPreview(content: unknown): {
	text: string | undefined;
	images: ImageContent[];
} {
	const { textual, images } = splitToolResultMedia(content);
	return {
		text:
			typeof textual === "string" ? textual : JSON.stringify(textual, null, 2),
		images,
	};
}

/** YAML is only the readable recovery copy, not the truncation threshold. */
export function prepareToolResultRecovery(output: unknown): {
	text: string | undefined;
	images: ImageContent[];
} {
	const { textual, images } = splitToolResultMedia(output);
	return {
		text:
			typeof textual === "string"
				? textual
				: textual === undefined
					? undefined
					: YAML.stringify(textual, { blockQuote: "literal", lineWidth: 0 }),
		images,
	};
}
