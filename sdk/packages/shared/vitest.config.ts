import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// Upstream tests expect telemetry and Cline services on; gate tests turn them off.
		env: { CLINE_REMOTE_SERVICES: "on" },
		include: ["src/**/*.test.ts"],
		// SQLite-backed tests routinely exceed vitest's 5s default on the
		// 2-core windows-latest runner. A hang guard, not a timing assertion.
		testTimeout: 15_000,
		hookTimeout: 15_000,
		exclude: ["src/**/*.e2e.test.ts"],
	},
});
