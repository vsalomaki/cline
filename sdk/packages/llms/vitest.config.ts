import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@cline\/shared\/(.+)$/,
				replacement: resolve(rootDir, "../shared/src/$1"),
			},
			{
				find: /^@cline\/shared$/,
				replacement: resolve(rootDir, "../shared/src/index.ts"),
			},
		],
	},
	test: {
		environment: "node",
		// Upstream tests expect telemetry and Cline services on; gate tests turn them off.
		env: { CLINE_REMOTE_SERVICES: "on" },
		include: ["src/**/*.test.ts"],
	},
});
