import * as path from "node:path";
import type { BasicLogger } from "@cline/shared";
import type {
	CodeDiagnostic,
	CodeIntelligenceProvider,
	CodeLocation,
	CodePosition,
	CodeSymbol,
} from "../../extensions/tools/code-intelligence/types";
import { LanguageServer } from "./language-server";
import type {
	ResolvedLanguageServer,
	UnavailableLanguageServer,
} from "./servers";

/** How long a server nobody uses stays up, so the next session in the process finds it warm. */
const DEFAULT_IDLE_DISPOSE_MS = 120_000;

export interface LanguageServerLease {
	readonly server: LanguageServer;
	release(): Promise<void>;
}

interface PoolEntry {
	server: LanguageServer;
	refs: number;
	idleTimer?: NodeJS.Timeout;
}

/**
 * Language servers shared by every session in the process, keyed by
 * workspace root and server config, and counted by the sessions using them.
 */
export class LanguageServerPool {
	private readonly entries = new Map<string, PoolEntry>();

	constructor(
		private readonly options: {
			idleDisposeMs?: number;
			createServer?: (
				config: ResolvedLanguageServer,
				root: string,
			) => LanguageServer;
		} = {},
	) {}

	private key(root: string, config: ResolvedLanguageServer): string {
		return JSON.stringify([
			root,
			config.name,
			config.command,
			config.initializationOptions ?? null,
		]);
	}

	/** A lease on the live server for this root and config, if one is already running. */
	acquireRunning(
		root: string,
		config: ResolvedLanguageServer,
	): LanguageServerLease | undefined {
		const entry = this.entries.get(this.key(root, config));
		return entry && !entry.server.isDead ? this.lease(entry) : undefined;
	}

	acquire(root: string, config: ResolvedLanguageServer): LanguageServerLease {
		const key = this.key(root, config);
		let entry = this.entries.get(key);
		if (!entry || entry.server.isDead) {
			const server =
				this.options.createServer?.(config, root) ??
				new LanguageServer(config, root);
			entry = { server, refs: 0 };
			this.entries.set(key, entry);
		}
		return this.lease(entry);
	}

	private lease(entry: PoolEntry): LanguageServerLease {
		entry.refs += 1;
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
			entry.server.setReferenced(true);
		}
		let released = false;
		return {
			server: entry.server,
			release: async () => {
				if (released) {
					return;
				}
				released = true;
				entry.refs -= 1;
				if (entry.refs > 0) {
					return;
				}
				const idleMs = this.options.idleDisposeMs ?? DEFAULT_IDLE_DISPOSE_MS;
				if (idleMs <= 0 || entry.server.isDead) {
					await this.dispose(entry);
					return;
				}
				entry.server.closeDocuments();
				entry.server.setReferenced(false);
				entry.idleTimer = setTimeout(() => {
					entry.idleTimer = undefined;
					void this.dispose(entry);
				}, idleMs);
				entry.idleTimer.unref();
			},
		};
	}

	private async dispose(entry: PoolEntry): Promise<void> {
		for (const [key, candidate] of this.entries) {
			if (candidate === entry) {
				this.entries.delete(key);
			}
		}
		await entry.server.dispose();
	}

	get size(): number {
		return this.entries.size;
	}
}

export const sharedLanguageServerPool = new LanguageServerPool();

export interface LspCodeIntelligenceOptions {
	root: string;
	servers: ResolvedLanguageServer[];
	unavailable?: UnavailableLanguageServer[];
	pool?: LanguageServerPool;
	logger?: BasicLogger;
}

/** A CodeIntelligenceProvider that routes each file by extension to a language server it starts on first use. */
export class LspCodeIntelligence implements CodeIntelligenceProvider {
	private readonly root: string;
	private readonly servers: ResolvedLanguageServer[];
	private readonly unavailable: UnavailableLanguageServer[];
	private readonly pool: LanguageServerPool;
	private readonly logger?: BasicLogger;
	private readonly leases = new Map<string, LanguageServerLease>();
	private released = false;

	constructor(options: LspCodeIntelligenceOptions) {
		this.root = options.root;
		this.servers = options.servers;
		this.unavailable = options.unavailable ?? [];
		this.pool = options.pool ?? sharedLanguageServerPool;
		this.logger = options.logger;
	}

	private configFor(filePath: string): ResolvedLanguageServer {
		const extension = path.extname(filePath).toLowerCase();
		const config = this.servers.find((server) =>
			server.extensions.includes(extension),
		);
		if (config) {
			return config;
		}
		const label = extension ? `${extension} files` : path.basename(filePath);
		const missing = this.unavailable.find((server) =>
			server.extensions.includes(extension),
		);
		throw new Error(
			missing
				? `No language server is available for ${label}: ${missing.binary} was not found on PATH`
				: `No language server is configured for ${label}`,
		);
	}

	private assertActive(): void {
		if (this.released) {
			throw new Error("Language servers for this session were released");
		}
	}

	/** This session's lease on the server, taking one from the pool (and starting the server) when needed. */
	private leaseFor(config: ResolvedLanguageServer): LanguageServerLease {
		this.assertActive();
		let lease = this.leases.get(config.name);
		if (!lease) {
			lease = this.pool.acquire(this.root, config);
			this.leases.set(config.name, lease);
		}
		return lease;
	}

	/** The server for `config` only if one is already running, here or in the pool. */
	private runningServer(
		config: ResolvedLanguageServer,
	): LanguageServer | undefined {
		let lease = this.leases.get(config.name);
		if (!lease && !this.released) {
			lease = this.pool.acquireRunning(this.root, config);
			if (lease) {
				this.leases.set(config.name, lease);
			}
		}
		return lease && !lease.server.isDead ? lease.server : undefined;
	}

	private async readyServerFor(filePath: string): Promise<LanguageServer> {
		const server = this.leaseFor(this.configFor(filePath)).server;
		await server.ready;
		return server;
	}

	async definition(
		pos: CodePosition,
		signal?: AbortSignal,
	): Promise<CodeLocation[]> {
		return (await this.readyServerFor(pos.path)).definition(pos, signal);
	}

	async implementation(
		pos: CodePosition,
		signal?: AbortSignal,
	): Promise<CodeLocation[]> {
		return (await this.readyServerFor(pos.path)).implementation(pos, signal);
	}

	async references(
		pos: CodePosition,
		signal?: AbortSignal,
	): Promise<CodeLocation[]> {
		return (await this.readyServerFor(pos.path)).references(pos, signal);
	}

	async hover(
		pos: CodePosition,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		return (await this.readyServerFor(pos.path)).hover(pos, signal);
	}

	async documentSymbols(
		filePath: string,
		signal?: AbortSignal,
	): Promise<CodeSymbol[]> {
		return (await this.readyServerFor(filePath)).documentSymbols(
			filePath,
			signal,
		);
	}

	async workspaceSymbols(
		query: string,
		signal?: AbortSignal,
	): Promise<CodeSymbol[]> {
		this.assertActive();
		const running = this.servers
			.map((config) => this.runningServer(config))
			.filter((server): server is LanguageServer => server?.isReady === true);
		if (running.length === 0) {
			throw new Error(
				"No language server is running yet; call document_symbols or definition on a file first",
			);
		}
		const results = await Promise.allSettled(
			running.map((server) => server.workspaceSymbols(query, signal)),
		);
		const symbols = results.flatMap((result) =>
			result.status === "fulfilled" ? result.value : [],
		);
		const failure = results.find((result) => result.status === "rejected");
		if (symbols.length === 0 && failure?.status === "rejected") {
			throw failure.reason;
		}
		return symbols;
	}

	/** Groups paths by the server that handles them; throws when none of them is handled. */
	private groupByServer(
		paths: string[],
	): Map<ResolvedLanguageServer, string[]> {
		const groups = new Map<ResolvedLanguageServer, string[]>();
		let firstError: unknown;
		for (const filePath of paths) {
			try {
				const config = this.configFor(filePath);
				groups.set(config, [...(groups.get(config) ?? []), filePath]);
			} catch (error) {
				firstError ??= error;
			}
		}
		if (groups.size === 0 && firstError) {
			throw firstError;
		}
		return groups;
	}

	async diagnostics(paths: string[]): Promise<Map<string, CodeDiagnostic[]>> {
		const result = new Map<string, CodeDiagnostic[]>();
		for (const [config, group] of this.groupByServer(paths)) {
			const server = this.runningServer(config);
			for (const filePath of group) {
				const known = server?.knownDiagnosticsFor(filePath);
				if (known) {
					result.set(filePath, known);
				}
			}
		}
		return result;
	}

	prepare(filePath: string): void {
		const extension = path.extname(filePath).toLowerCase();
		if (!this.servers.some((server) => server.extensions.includes(extension))) {
			return;
		}
		void this.readyServerFor(filePath)
			.then((server) => server.ensureCurrent(filePath))
			.catch((error: unknown) =>
				this.logger?.debug("Language server could not open file", {
					path: filePath,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
	}

	async diagnosticsAfterChange(
		paths: string[],
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<Map<string, CodeDiagnostic[]>> {
		const deadline = Date.now() + options.timeoutMs;
		const result = new Map<string, CodeDiagnostic[]>();
		const outcomes = await Promise.allSettled(
			[...this.groupByServer(paths)].map(async ([config, group]) => {
				const server = this.leaseFor(config).server;
				if (!server.isReady) {
					await waitUntil(server.ready, deadline - Date.now());
					if (server.isDead) {
						await server.ready;
					}
					if (!server.isReady) {
						for (const filePath of group) {
							this.prepare(filePath);
						}
						throw new Error(
							`Language server ${config.name} is still starting; try again shortly`,
						);
					}
				}
				await Promise.all(
					group.map((filePath) => server.syncFromDisk(filePath)),
				);
				const diagnostics = await server.waitForDiagnostics(
					group,
					Math.max(0, deadline - Date.now()),
					options.signal,
				);
				for (const [filePath, entries] of diagnostics) {
					result.set(filePath, entries);
				}
			}),
		);
		const failure = outcomes.find((outcome) => outcome.status === "rejected");
		if (result.size === 0 && failure?.status === "rejected") {
			throw failure.reason;
		}
		return result;
	}

	async release(): Promise<void> {
		this.released = true;
		const leases = [...this.leases.values()];
		this.leases.clear();
		await Promise.all(leases.map((lease) => lease.release()));
	}
}

/** Waits for `promise` to settle or `ms` to pass, whichever is first; never rejects. */
async function waitUntil(promise: Promise<unknown>, ms: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	await Promise.race([
		promise.catch(() => {}),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, Math.max(0, ms));
		}),
	]);
	clearTimeout(timer);
}
