import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqliteDb, type SqliteDb } from "@cline/shared/db";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	countLines,
	getToolOutputStoreFromContext,
	MAX_STORED_OUTPUT_CHARS,
	MemoryToolOutputStore,
	SqliteToolOutputStore,
	type ToolOutputInput,
	type ToolOutputStore,
} from "./store";

const forced = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		randomBytes: ((size: number) =>
			forced.ids.length > 0
				? Buffer.from(forced.ids.shift() as string, "hex")
				: actual.randomBytes(size)) as typeof actual.randomBytes,
	};
});

let root: string;
const openDbs: SqliteDb[] = [];
let dbCounter = 0;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "tool-output-store-"));
});

afterEach(() => {
	forced.ids.length = 0;
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

afterAll(async () => {
	for (const db of openDbs) {
		try {
			db.close?.();
		} catch {
			// Already closed by the test.
		}
	}
	await rm(root, { recursive: true, force: true });
});

function openDb(file = `store-${dbCounter++}.db`): SqliteDb {
	const db = loadSqliteDb(join(root, file));
	openDbs.push(db);
	return db;
}

function input(overrides: Partial<ToolOutputInput> = {}): ToolOutputInput {
	return {
		sessionId: "s1",
		agentId: "lead",
		toolCallId: "call-1",
		toolName: "run_commands",
		summary: "npm test",
		text: "line one\nline two\nline three\n",
		...overrides,
	};
}

describe("countLines", () => {
	it.each([
		["", 0],
		["a", 1],
		["a\n", 1],
		["a\nb", 2],
		["a\n\nb\n", 3],
	])("counts %j as %i", (text, lines) => {
		expect(countLines(text)).toBe(lines);
	});
});

describe.each([
	[
		"SqliteToolOutputStore",
		(): ToolOutputStore => new SqliteToolOutputStore(openDb()),
	],
	["MemoryToolOutputStore", (): ToolOutputStore => new MemoryToolOutputStore()],
])("%s", (_name, createStore) => {
	it("stores a record and reads it back by id", () => {
		const store = createStore();
		const record = store.put(input());

		expect(record).toMatchObject({
			sessionId: "s1",
			agentId: "lead",
			toolCallId: "call-1",
			toolName: "run_commands",
			summary: "npm test",
			chars: input().text.length,
			lines: 3,
		});
		expect(record?.id).toMatch(/^[0-9a-f]{8}$/);
		expect(record?.createdAt).toBeGreaterThan(0);
		expect(store.get("s1", record?.id as string)).toEqual(record);
		expect(store.readText("s1", record?.id as string)).toBe(input().text);
	});

	it("omits the agent id when none was given", () => {
		const store = createStore();
		const record = store.put(input({ agentId: undefined }));

		expect(store.get("s1", record?.id as string)?.agentId).toBeUndefined();
	});

	it("returns undefined for unknown ids and other sessions", () => {
		const store = createStore();
		const record = store.put(input());

		expect(store.get("s1", "ffffffff")).toBeUndefined();
		expect(store.readText("s1", "ffffffff")).toBeUndefined();
		expect(store.get("s2", record?.id as string)).toBeUndefined();
		expect(store.readText("s2", record?.id as string)).toBeUndefined();
	});

	it("finds a record by tool call id within its session", () => {
		const store = createStore();
		const first = store.put(input({ toolCallId: "call-1" }));
		const second = store.put(input({ toolCallId: "call-2" }));
		store.put(input({ sessionId: "s2", toolCallId: "call-3" }));

		expect(store.findByToolCall("s1", "call-1")?.id).toBe(first?.id);
		expect(store.findByToolCall("s1", "call-2")?.id).toBe(second?.id);
		expect(store.findByToolCall("s1", "call-3")).toBeUndefined();
		expect(store.findByToolCall("s2", "call-1")).toBeUndefined();
	});

	it("lists a session's records newest first, up to the limit", () => {
		const store = createStore();
		const ids = [1, 2, 3].map(
			(n) => store.put(input({ toolCallId: `call-${n}` }))?.id,
		);
		store.put(input({ sessionId: "other" }));

		expect(store.list("s1", 10).map((record) => record.id)).toEqual(
			[...ids].reverse(),
		);
		expect(store.list("s1", 2).map((record) => record.id)).toEqual([
			ids[2],
			ids[1],
		]);
		expect(store.list("empty", 10)).toEqual([]);
	});

	it("gives each record of a session its own id", () => {
		const store = createStore();
		const ids = new Set(
			Array.from(
				{ length: 50 },
				(_, n) => store.put(input({ toolCallId: `c${n}` }))?.id,
			),
		);

		expect(ids.size).toBe(50);
	});

	it("retries an id that clashes within the session", () => {
		const store = createStore();
		forced.ids.push("aaaaaaaa", "aaaaaaaa", "bbbbbbbb");

		expect(store.put(input())?.id).toBe("aaaaaaaa");
		expect(store.put(input({ toolCallId: "call-2" }))?.id).toBe("bbbbbbbb");
	});

	it("allows the same id in different sessions", () => {
		const store = createStore();
		forced.ids.push("aaaaaaaa", "aaaaaaaa");

		const first = store.put(input({ sessionId: "s1" }));
		const second = store.put(input({ sessionId: "s2", text: "other" }));

		expect(first?.id).toBe("aaaaaaaa");
		expect(second?.id).toBe("aaaaaaaa");
		expect(store.readText("s1", "aaaaaaaa")).toBe(input().text);
		expect(store.readText("s2", "aaaaaaaa")).toBe("other");
	});

	it("deletes one session and leaves the others", () => {
		const store = createStore();
		const kept = store.put(input({ sessionId: "keep" }));
		store.put(input({ sessionId: "drop", toolCallId: "a" }));
		store.put(input({ sessionId: "drop", toolCallId: "b" }));

		store.deleteSession("drop");

		expect(store.list("drop", 10)).toEqual([]);
		expect(store.findByToolCall("drop", "a")).toBeUndefined();
		expect(store.readText("keep", kept?.id as string)).toBe(input().text);
	});

	it("clamps text over the stored-output maximum and says so", () => {
		const store = createStore();
		const record = store.put(
			input({
				text: `${"x".repeat(MAX_STORED_OUTPUT_CHARS)}${"y".repeat(500)}`,
			}),
		);

		const text = store.readText("s1", record?.id as string) ?? "";
		expect(text.startsWith("x".repeat(MAX_STORED_OUTPUT_CHARS))).toBe(true);
		expect(text).not.toContain("y");
		expect(text).toContain(
			`[Stored output stopped at ${MAX_STORED_OUTPUT_CHARS} chars]`,
		);
		expect(record?.chars).toBe(text.length);
	});

	it("keeps text of exactly the maximum unchanged", () => {
		const store = createStore();
		const text = "z".repeat(MAX_STORED_OUTPUT_CHARS);
		const record = store.put(input({ text }));

		expect(record?.chars).toBe(MAX_STORED_OUTPUT_CHARS);
		expect(store.readText("s1", record?.id as string)).toBe(text);
	});
});

describe("SqliteToolOutputStore", () => {
	it("keeps records across store instances on the same file", () => {
		const file = "persist.db";
		const record = new SqliteToolOutputStore(openDb(file)).put(input());

		const reopened = new SqliteToolOutputStore(openDb(file));

		expect(reopened.get("s1", record?.id as string)).toEqual(record);
		expect(reopened.readText("s1", record?.id as string)).toBe(input().text);
	});

	it("returns undefined instead of throwing when the write fails", () => {
		const db = openDb();
		const store = new SqliteToolOutputStore(db);
		db.close?.();

		expect(store.put(input())).toBeUndefined();
	});

	it("gives up after repeated id clashes", () => {
		const store = new SqliteToolOutputStore(openDb());
		forced.ids.push("aaaaaaaa");
		store.put(input());
		forced.ids.push(..."xxxxxx".split("").map(() => "aaaaaaaa"));

		expect(store.put(input({ toolCallId: "call-2" }))).toBeUndefined();
	});

	describe("sweep", () => {
		const DAY = 24 * 60 * 60 * 1000;

		it("drops rows older than the retention and keeps newer ones", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const store = new SqliteToolOutputStore(openDb(), {
				retentionMs: 7 * DAY,
				maxTotalChars: Number.MAX_SAFE_INTEGER,
			});
			const old = store.put(input({ toolCallId: "old" }));
			vi.setSystemTime(new Date("2026-01-05T00:00:00Z"));
			const recent = store.put(input({ toolCallId: "recent" }));

			store.sweep(new Date("2026-01-07T00:00:00Z").getTime());
			expect(store.get("s1", old?.id as string)).toBeDefined();

			store.sweep(new Date("2026-01-09T00:00:00Z").getTime());
			expect(store.get("s1", old?.id as string)).toBeUndefined();
			expect(store.get("s1", recent?.id as string)).toBeDefined();

			store.sweep(new Date("2026-01-13T00:00:00Z").getTime());
			expect(store.list("s1", 10)).toEqual([]);
		});

		it("sweeps on construction", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const file = "sweep-on-open.db";
			new SqliteToolOutputStore(openDb(file)).put(input());

			vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
			const reopened = new SqliteToolOutputStore(openDb(file));

			expect(reopened.list("s1", 10)).toEqual([]);
		});

		it("drops the oldest rows once the total exceeds the cap", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const store = new SqliteToolOutputStore(openDb(), {
				retentionMs: 365 * DAY,
				maxTotalChars: 250,
			});
			const ids: string[] = [];
			for (let n = 0; n < 4; n++) {
				vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, n)));
				ids.push(
					store.put(input({ toolCallId: `c${n}`, text: "x".repeat(100) }))
						?.id as string,
				);
			}

			store.sweep();

			expect(store.list("s1", 10).map((record) => record.id)).toEqual([
				ids[3],
				ids[2],
			]);
		});

		it("keeps everything while under both limits", () => {
			const store = new SqliteToolOutputStore(openDb());
			store.put(input({ toolCallId: "a" }));
			store.put(input({ toolCallId: "b", sessionId: "s2" }));

			store.sweep();

			expect(store.list("s1", 10)).toHaveLength(1);
			expect(store.list("s2", 10)).toHaveLength(1);
		});

		it("runs by itself every 200 puts", () => {
			const store = new SqliteToolOutputStore(openDb(), {
				retentionMs: 365 * DAY,
				maxTotalChars: 50,
			});
			for (let n = 0; n < 199; n++)
				store.put(input({ toolCallId: `c${n}`, text: "x".repeat(10) }));
			expect(store.list("s1", 1_000)).toHaveLength(199);

			store.put(input({ toolCallId: "c199", text: "x".repeat(10) }));

			expect(store.list("s1", 1_000)).toHaveLength(5);
			expect(store.findByToolCall("s1", "c199")).toBeDefined();
		});
	});
});

describe("MemoryToolOutputStore", () => {
	it("evicts the oldest records once the total exceeds the cap", () => {
		const store = new MemoryToolOutputStore(250);
		const ids = [0, 1, 2].map(
			(n) =>
				store.put(input({ toolCallId: `c${n}`, text: "x".repeat(100) }))
					?.id as string,
		);

		expect(store.get("s1", ids[0])).toBeUndefined();
		expect(store.findByToolCall("s1", "c0")).toBeUndefined();
		expect(store.list("s1", 10).map((record) => record.id)).toEqual([
			ids[2],
			ids[1],
		]);
	});

	it("evicts across sessions and returns undefined for a record larger than the cap", () => {
		const store = new MemoryToolOutputStore(150);
		const other = store.put(
			input({ sessionId: "other", text: "x".repeat(100) }),
		);

		expect(store.put(input({ text: "y".repeat(200) }))).toBeUndefined();
		expect(store.get("other", other?.id as string)).toBeUndefined();
		expect(store.list("s1", 10)).toEqual([]);
	});

	it("frees the space of a deleted session", () => {
		const store = new MemoryToolOutputStore(250);
		store.put(input({ sessionId: "a", text: "x".repeat(100) }));
		store.put(
			input({ sessionId: "a", toolCallId: "2", text: "x".repeat(100) }),
		);
		store.deleteSession("a");

		const kept = store.put(input({ sessionId: "b", text: "z".repeat(200) }));

		expect(store.readText("b", kept?.id as string)).toBe("z".repeat(200));
	});
});

describe("getToolOutputStoreFromContext", () => {
	it("returns the store from the tool context metadata", () => {
		const store = new MemoryToolOutputStore();

		expect(
			getToolOutputStoreFromContext({ metadata: { toolOutputStore: store } }),
		).toBe(store);
	});

	it.each([
		["no metadata", {}],
		["no store", { metadata: {} }],
		["a non-object", { metadata: { toolOutputStore: "store" } }],
		["null", { metadata: { toolOutputStore: null } }],
		["an object without put", { metadata: { toolOutputStore: { get() {} } } }],
	])("returns undefined for %s", (_name, context) => {
		expect(getToolOutputStoreFromContext(context)).toBeUndefined();
	});
});

describe("getToolOutputStore", () => {
	it("opens one SQLite store at tool-output.db in the data directory", async () => {
		const dir = join(root, "singleton");
		vi.stubEnv("CLINE_DB_DATA_DIR", dir);
		vi.resetModules();
		const module = await import("./store");

		const store = module.getToolOutputStore();

		expect(store).toBeInstanceOf(module.SqliteToolOutputStore);
		expect(module.getToolOutputStore()).toBe(store);
		expect(existsSync(join(dir, "tool-output.db"))).toBe(true);
	});

	it("falls back to the in-memory store when the database cannot be opened", async () => {
		const blocker = join(root, "not-a-directory");
		await writeFile(blocker, "file");
		vi.stubEnv("CLINE_DB_DATA_DIR", join(blocker, "db"));
		vi.resetModules();
		const module = await import("./store");

		const store = module.getToolOutputStore();

		expect(store).toBeInstanceOf(module.MemoryToolOutputStore);
		expect(module.getToolOutputStore()).toBe(store);
		const record = store.put(input());
		expect(store.readText("s1", record?.id as string)).toBe(input().text);
	});
});
