/**
 * Utility for expanding variables in MCP configuration values.
 * Supports ${env:VAR_NAME} and ${workspaceFolder}.
 */

import { expandMcpConfigVariables } from "@cline/shared"
import { Logger } from "@/shared/services/Logger"

/**
 * Recursively expands `${env:VAR_NAME}` and `${workspaceFolder}` in any value
 * (string, object, array). A reference with no value is left as written.
 *
 * @example
 * // If process.env.API_KEY = "secret123"
 * expandEnvironmentVariables({ token: "Bearer ${env:API_KEY}" }) // { token: "Bearer secret123" }
 * expandEnvironmentVariables("${env:MISSING}") // "${env:MISSING}" (unchanged)
 */
export function expandEnvironmentVariables<T>(value: T, workspaceFolder?: string): T {
	return expandMcpConfigVariables(value, {
		env: process.env,
		workspaceFolder,
		onMissing: (reference) => {
			Logger.warn(
				reference.startsWith("env:")
					? `[MCP Config] Environment variable not found: ${reference.slice(4).trim()}`
					: `[MCP Config] No workspace folder is open for \${${reference}}`,
			)
		},
	})
}
