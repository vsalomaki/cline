import { isRemoteServicesDisabled } from "../runtime/remote-services";

/**
 * Fallback default model for the Cline provider. The `cline` provider manifest
 * in `@cline/llms` prefers the first entry of the Cline recommended-models list
 * and falls back to this id when that list is empty.
 */
export const CLINE_DEFAULT_MODEL_ID = "anthropic/claude-sonnet-5.5";

/** Provider used when nothing is configured; builds without Cline's services can't use `cline`. */
export function getDefaultProviderId(): string {
	return isRemoteServicesDisabled() ? "openai-compatible" : "cline";
}
