import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import * as path from "node:path";
import { resolveClineDataDir } from "@cline/shared/storage";
import type {
	LanguageServerConfig,
	LanguageServerSettings,
} from "../../extensions/tools/code-intelligence/types";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;

/** LSP language ids for common extensions, used when a server entry maps none. */
const KNOWN_LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascriptreact",
	".py": "python",
	".pyi": "python",
	".rs": "rust",
	".rb": "ruby",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".cs": "csharp",
	".kt": "kotlin",
	".kts": "kotlin",
	".sh": "shellscript",
	".bash": "shellscript",
	".yml": "yaml",
	".md": "markdown",
	".ex": "elixir",
	".exs": "elixir",
	".hs": "haskell",
	".ml": "ocaml",
};

interface BuiltinServer {
	/** Commands to try in order; the first whose binary is found is used. */
	candidates: (root: string) => string[][];
	extensions: string[];
	initializationOptions?: unknown;
	startupTimeoutMs?: number;
}

const BUILTIN_SERVERS: Record<string, BuiltinServer> = {
	typescript: {
		candidates: () => [["typescript-language-server", "--stdio"]],
		extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
		// The syntax-only server answers while the project loads and cannot follow imports.
		initializationOptions: { tsserver: { useSyntaxServer: "never" } },
	},
	python: {
		candidates: () => [
			["pyright-langserver", "--stdio"],
			["basedpyright-langserver", "--stdio"],
		],
		extensions: [".py", ".pyi"],
	},
	java: {
		candidates: (root) => [
			[
				"jdtls",
				"-data",
				path.join(
					resolveClineDataDir(),
					"jdtls",
					createHash("sha1").update(root).digest("hex").slice(0, 12),
				),
			],
		],
		extensions: [".java"],
		startupTimeoutMs: 60_000,
	},
	go: {
		candidates: () => [["gopls"]],
		extensions: [".go"],
	},
	rust: {
		candidates: () => [["rust-analyzer"]],
		extensions: [".rs"],
	},
};

export interface ResolvedLanguageServer {
	name: string;
	/** `command[0]` is the absolute path of the binary. */
	command: string[];
	/** Lowercase, with the leading dot. */
	extensions: string[];
	languageIds: Record<string, string>;
	initializationOptions?: unknown;
	startupTimeoutMs: number;
}

export interface UnavailableLanguageServer {
	name: string;
	binary: string;
	extensions: string[];
}

export interface ResolvedLanguageServers {
	/** In routing order: configured servers first, then the remaining built-ins. */
	available: ResolvedLanguageServer[];
	unavailable: UnavailableLanguageServer[];
}

export interface ExecutableLookup {
	root: string;
	env?: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
}

function isExecutableFile(
	filePath: string,
	platform: NodeJS.Platform,
): boolean {
	try {
		if (!statSync(filePath).isFile()) {
			return false;
		}
		if (platform !== "win32") {
			accessSync(filePath, constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

/** Finds `name` in the workspace `node_modules/.bin`, then on PATH. */
export function findExecutable(
	name: string,
	lookup: ExecutableLookup,
): string | undefined {
	const env = lookup.env ?? process.env;
	const platform = lookup.platform ?? process.platform;
	const pathApi = platform === "win32" ? path.win32 : path.posix;
	const extensions =
		platform === "win32"
			? [
					"",
					...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
						.split(";")
						.filter(Boolean)
						.map((ext) => ext.toLowerCase()),
				]
			: [""];
	const find = (base: string) =>
		extensions
			.map((ext) => base + ext)
			.find((candidate) => isExecutableFile(candidate, platform));
	if (name.includes("/") || (platform === "win32" && name.includes("\\"))) {
		return find(pathApi.resolve(lookup.root, name));
	}
	const pathValue =
		platform === "win32" ? (env.Path ?? env.PATH ?? "") : (env.PATH ?? "");
	const dirs = [
		pathApi.join(lookup.root, "node_modules", ".bin"),
		...pathValue.split(pathApi.delimiter).filter(Boolean),
	];
	for (const dir of dirs) {
		const found = find(pathApi.join(dir, name));
		if (found) {
			return found;
		}
	}
	return undefined;
}

function normalizeExtension(extension: string): string {
	const lower = extension.trim().toLowerCase();
	return lower.startsWith(".") ? lower : `.${lower}`;
}

function isValidConfig(config: unknown): config is LanguageServerConfig {
	const candidate = config as LanguageServerConfig | undefined;
	return (
		Array.isArray(candidate?.command) &&
		candidate.command.length > 0 &&
		candidate.command.every((part) => typeof part === "string") &&
		candidate.command[0].trim().length > 0 &&
		Array.isArray(candidate.extensions) &&
		candidate.extensions.every((ext) => typeof ext === "string")
	);
}

function normalizeLanguageIds(
	languageIds: Record<string, string> | undefined,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [extension, id] of Object.entries(languageIds ?? {})) {
		if (typeof id === "string") {
			result[normalizeExtension(extension)] = id;
		}
	}
	return result;
}

/**
 * Merges the built-in servers with the user's `servers` entries and keeps
 * the ones whose binary exists, so a session knows up front whether any
 * language server can serve it.
 */
export function resolveLanguageServers(
	settings: LanguageServerSettings | undefined,
	lookup: ExecutableLookup,
): ResolvedLanguageServers {
	const configured = settings?.servers ?? {};
	const entries: {
		name: string;
		candidates: string[][];
		extensions: string[];
		languageIds: Record<string, string>;
		initializationOptions?: unknown;
		startupTimeoutMs?: number;
	}[] = [];
	for (const [name, config] of Object.entries(configured)) {
		if (!isValidConfig(config)) {
			continue;
		}
		entries.push({
			name,
			candidates: [config.command],
			extensions: config.extensions.map(normalizeExtension),
			languageIds: normalizeLanguageIds(config.languageIds),
			initializationOptions: config.initializationOptions,
			startupTimeoutMs: config.startupTimeoutMs,
		});
	}
	for (const [name, builtin] of Object.entries(BUILTIN_SERVERS)) {
		if (name in configured) {
			continue;
		}
		entries.push({
			name,
			candidates: builtin.candidates(lookup.root),
			extensions: builtin.extensions,
			languageIds: {},
			initializationOptions: builtin.initializationOptions,
			startupTimeoutMs: builtin.startupTimeoutMs,
		});
	}

	const result: ResolvedLanguageServers = { available: [], unavailable: [] };
	for (const entry of entries) {
		let resolved: string[] | undefined;
		for (const candidate of entry.candidates) {
			const binary = findExecutable(candidate[0], lookup);
			if (binary) {
				resolved = [binary, ...candidate.slice(1)];
				break;
			}
		}
		if (!resolved) {
			result.unavailable.push({
				name: entry.name,
				binary: entry.candidates.map((candidate) => candidate[0]).join(" or "),
				extensions: entry.extensions,
			});
			continue;
		}
		const timeout = entry.startupTimeoutMs;
		result.available.push({
			name: entry.name,
			command: resolved,
			extensions: entry.extensions,
			languageIds: entry.languageIds,
			initializationOptions: entry.initializationOptions,
			startupTimeoutMs:
				typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
					? timeout
					: DEFAULT_STARTUP_TIMEOUT_MS,
		});
	}
	return result;
}

export function languageIdFor(
	server: Pick<ResolvedLanguageServer, "languageIds">,
	filePath: string,
): string {
	const extension = path.extname(filePath).toLowerCase();
	return (
		server.languageIds[extension] ??
		KNOWN_LANGUAGE_IDS[extension] ??
		extension.slice(1)
	);
}
