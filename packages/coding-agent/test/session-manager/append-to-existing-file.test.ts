import { type appendFileSync, mkdtempSync, type readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type AppendFileSync = typeof appendFileSync;
type ReadFileSync = typeof readFileSync;

const fsMocks = vi.hoisted(() => ({ appendFileSync: vi.fn<AppendFileSync>(), readFileSync: vi.fn<ReadFileSync>() }));

// Passthrough spies: real fs behavior everywhere, with call counts on the two
// calls that tell a full transcript parse (readFileSync) from an append.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	fsMocks.appendFileSync.mockImplementation(actual.appendFileSync);
	fsMocks.readFileSync.mockImplementation(actual.readFileSync);
	return { ...actual, appendFileSync: fsMocks.appendFileSync, readFileSync: fsMocks.readFileSync };
});

import { ENV_AGENT_DIR } from "../../src/config.js";
import {
	appendCustomMessageToExistingFile,
	appendSessionInfoToExistingFile,
	appendSessionStateToExistingFile,
	SessionManager,
} from "../../src/core/session-manager.js";
import { DaemonCatalogClient } from "../../src/modes/daemon/daemon-catalog-process.js";

const NOTICE =
	"<prime_agent_worker_interrupted>\nThe isolated session worker stopped during in-flight work. The saved transcript was recovered, but uncertain model, tool, bash, or child-agent work was not replayed. Inspect external side effects before continuing.\n</prime_agent_worker_interrupted>";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix = "pi-session-append-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Header plus a chained transcript, shaped like a real session file. */
function sessionLines(
	dir: string,
	options: { entries?: number; allUser?: boolean; textBytes?: number; version?: number } = {},
): string[] {
	const count = options.entries ?? 4;
	const lines = [
		JSON.stringify({
			type: "session",
			version: options.version ?? 3,
			id: "fixture-session",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
		}),
	];
	let parentId: string | null = null;
	for (let i = 0; i < count; i++) {
		const id = `e${i}`;
		const timestamp = 1_767_225_600_000 + i;
		const text = options.textBytes !== undefined && i === count - 1 ? "x".repeat(options.textBytes) : `payload ${i}`;
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			stopReason: "stop",
			usage,
			timestamp,
		};
		const message = options.allUser === true || i % 2 === 0 ? { role: "user", content: text, timestamp } : assistant;
		lines.push(
			JSON.stringify({ type: "message", id, parentId, timestamp: new Date(timestamp).toISOString(), message }),
		);
		parentId = id;
	}
	return lines;
}

function writeSession(dir: string, name: string, lines: string[], terminate = true): string {
	const file = join(dir, name);
	writeFileSync(file, lines.join("\n") + (terminate ? "\n" : ""));
	return file;
}

/** Clears the fs counters so one scenario's reads are measured on their own. */
function resetIo(): void {
	fsMocks.appendFileSync.mockClear();
	fsMocks.readFileSync.mockClear();
}

function rawFile(file: string): Buffer {
	return fsMocks.readFileSync(file) as unknown as Buffer;
}

function lastLine(file: string): Record<string, unknown> {
	const lines = rawFile(file).toString("utf8").trimEnd().split("\n");
	return JSON.parse(lines[lines.length - 1]!);
}

/** The bytes appended to `file` since `before`, parsed as JSON. */
function appended(before: Buffer, file: string): Record<string, unknown> {
	const bytes = rawFile(file).subarray(before.length).toString("utf8");
	expect(bytes.endsWith("\n")).toBe(true);
	return JSON.parse(bytes.trim());
}

/** Appends through the fast path and asserts nothing read the whole file. */
function fastAppend(file: string, append: () => void): Record<string, unknown> {
	const before = rawFile(file);
	resetIo();
	append();
	expect(fsMocks.readFileSync).not.toHaveBeenCalled();
	return appended(before, file);
}

describe("append metadata to an existing session file", () => {
	it("appends a rename line without reading or parsing the whole transcript", () => {
		const dir = tempDir();
		const file = writeSession(dir, "rename-fast.jsonl", sessionLines(dir, { entries: 18_000 }));
		const before = rawFile(file);
		expect(before.length).toBeGreaterThan(1_000_000); // big enough that a full parse would show

		resetIo();
		appendSessionInfoToExistingFile(file, "  Renamed  ");

		expect(fsMocks.readFileSync).not.toHaveBeenCalled(); // no full-file read or parse
		expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1); // exactly one appended line
		expect(appended(before, file)).toMatchObject({ type: "session_info", name: "Renamed", parentId: "e17999" });

		const reopened = SessionManager.open(file);
		expect(reopened.getSessionName()).toBe("Renamed");
		expect(reopened.getEntries()).toHaveLength(18_001);
	});

	it("falls back to a full open whenever only a full open can place the entry", () => {
		const rows = [
			// An oversized tail: the bounded window cannot resolve the leaf.
			{
				name: "huge-tail.jsonl",
				lines: (dir: string) => sessionLines(dir, { entries: 3, textBytes: 300_000 }),
				migrates: false,
			},
			// A v1 file: the open migrates it and assigns the ids an appended parentId chains to.
			{
				name: "v1.jsonl",
				lines: (dir: string) => [
					JSON.stringify({ type: "session", id: "legacy", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
					...sessionLines(dir, { entries: 2 }),
				],
				migrates: true,
			},
			// A v4 file: a format this build does not write, so the manager places the entry.
			{ name: "v4.jsonl", lines: (dir: string) => sessionLines(dir, { entries: 2, version: 4 }), migrates: false },
		];
		for (const row of rows) {
			const dir = tempDir();
			const file = writeSession(dir, row.name, row.lines(dir));
			const before = rawFile(file);
			resetIo();
			appendSessionInfoToExistingFile(file, "Renamed");

			expect(fsMocks.readFileSync).toHaveBeenCalled(); // the full open parsed the transcript
			expect(lastLine(file)).toMatchObject({ type: "session_info", name: "Renamed", parentId: expect.any(String) });
			expect(SessionManager.open(file).getSessionName()).toBe("Renamed");
			// Only the v1 migration rewrites what it read; the other fallbacks append.
			if (row.migrates) expect(JSON.parse(rawFile(file).toString("utf8").split("\n")[0]!).version).toBe(3);
			else expect(rawFile(file).subarray(0, before.length).equals(before)).toBe(true);
		}
	});

	it("appends through the fast path for the file shapes the loader accepts", () => {
		const dir = tempDir();
		const chain = sessionLines(dir, { entries: 3 });
		const rows = [
			// A leading blank line: the loader skips it, so the header window does too.
			{ file: writeSession(dir, "leading-blank.jsonl", ["", ...chain]), parentId: "e2" },
			// A header-only file: the appended entry becomes the first entry after it.
			{ file: writeSession(dir, "header-only.jsonl", sessionLines(dir, { entries: 0 })), parentId: null },
		];
		for (const { file, parentId } of rows) {
			expect(fastAppend(file, () => appendSessionInfoToExistingFile(file, "Renamed"))).toMatchObject({
				type: "session_info",
				parentId,
			});
			expect(SessionManager.open(file).getSessionName()).toBe("Renamed");
		}
		// A torn tail: the crash repair re-terminates the final line before the append.
		const torn = writeSession(dir, "torn.jsonl", chain, false);
		appendSessionInfoToExistingFile(torn, "Renamed");
		const repaired = rawFile(torn).toString("utf8").trimEnd().split("\n");
		expect(JSON.parse(repaired[repaired.length - 2]!)).toMatchObject({ type: "message", id: "e2" });
		expect(lastLine(torn)).toMatchObject({ type: "session_info", name: "Renamed", parentId: "e2" });
	});

	it("appends a lifecycle state entry and the worker notice through the fast path", () => {
		const dir = tempDir();
		// No assistant entry yet, which a live append would suppress.
		const file = writeSession(dir, "archive-notice.jsonl", sessionLines(dir, { entries: 3, allUser: true }));
		const state = fastAppend(file, () => appendSessionStateToExistingFile(file, { status: "archived" }));
		expect(state).toMatchObject({ type: "session_state", state: { status: "archived" }, parentId: "e2" });

		const notice = fastAppend(file, () =>
			appendCustomMessageToExistingFile(file, "prime-agent.worker_recovery", NOTICE, false, {
				activeSessionId: "active-1",
				operations: ["model_stream"],
			}),
		);
		expect(notice).toMatchObject({
			type: "custom_message",
			customType: "prime-agent.worker_recovery",
			content: NOTICE,
			display: false,
			details: { activeSessionId: "active-1", operations: ["model_stream"] },
			parentId: state.id,
		});
	});

	it("fails cleanly instead of recreating a missing or header-invalid session file", () => {
		const dir = tempDir();
		// No session header at all: the leading line is malformed and the rest are entries.
		const invalid = writeSession(dir, "invalid.jsonl", [
			"not json at all",
			...sessionLines(dir, { entries: 2 }).slice(1),
		]);
		const contents = rawFile(invalid).toString("utf8");

		resetIo();
		expect(() => appendSessionInfoToExistingFile(join(dir, "missing.jsonl"), "Renamed")).toThrow(
			/missing session file/,
		);
		expect(() => appendSessionInfoToExistingFile(writeSession(dir, "empty.jsonl", [""]), "Renamed")).toThrow(
			/no valid session header/,
		);
		expect(() => appendSessionInfoToExistingFile(invalid, "Renamed")).toThrow(/no valid session header/);
		expect(fsMocks.appendFileSync).not.toHaveBeenCalled(); // nothing created, appended, or rewritten
		expect(rawFile(invalid).toString("utf8")).toBe(contents);
	});
	it("keeps the full-open drop for a fallback session without an assistant entry", () => {
		// The oversized tail forces the fallback, and the live manager suppresses
		// the notice without an assistant entry, so nothing is appended.
		const dir = tempDir();
		const file = writeSession(
			dir,
			"fallback-notice.jsonl",
			sessionLines(dir, { entries: 3, allUser: true, textBytes: 300_000 }),
		);
		const before = rawFile(file);
		resetIo();
		appendCustomMessageToExistingFile(file, "prime-agent.worker_recovery", NOTICE, false, {
			activeSessionId: "active-1",
		});
		expect(fsMocks.readFileSync).toHaveBeenCalled(); // the tail window could not resolve the leaf
		expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
		expect(rawFile(file).equals(before)).toBe(true);
	});
});

describe("daemon catalog metadata commands", () => {
	async function withCatalog(run: (client: DaemonCatalogClient) => Promise<void>): Promise<void> {
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = tempDir("pa-catalog-metadata-");
		const client = new DaemonCatalogClient(() => {});
		try {
			await client.start();
			await run(client);
		} finally {
			await client.stop();
			if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
	}

	it("appends rename, archive, and interruption metadata without reopening the transcript", async () => {
		const sessionDir = tempDir("pa-catalog-sessions-");
		const file = writeSession(sessionDir, "catalog.jsonl", sessionLines(sessionDir, { entries: 40 }));
		const before = rawFile(file);

		await withCatalog(async (client) => {
			await client.rename(file, "  Catalog Renamed  ");
			const renamed = lastLine(file);
			expect(renamed).toMatchObject({ type: "session_info", name: "Catalog Renamed", parentId: "e39" });

			await client.archive(file, "fixture-session");
			const archived = lastLine(file);
			expect(archived).toMatchObject({ type: "session_state", state: { status: "archived" }, parentId: renamed.id });

			await client.markInterrupted(file, "active-1", ["model_stream"]);
			expect(lastLine(file)).toMatchObject({
				type: "custom_message",
				customType: "prime-agent.worker_recovery",
				content: NOTICE,
				display: false,
				details: { activeSessionId: "active-1", operations: ["model_stream"] },
				parentId: archived.id,
			});
		});
		// Every command appended in place and left the transcript it read untouched.
		expect(rawFile(file).subarray(0, before.length).equals(before)).toBe(true);
	});

	it("rejects a rename of a header-invalid file with a clean error", async () => {
		const sessionDir = tempDir("pa-catalog-invalid-");
		const file = writeSession(sessionDir, "invalid.jsonl", [
			"not json at all",
			...sessionLines(sessionDir, { entries: 1 }).slice(1), // no session header anywhere
		]);
		const contents = rawFile(file).toString("utf8");
		await withCatalog(async (client) => {
			await expect(client.rename(file, "Nope")).rejects.toThrow(/no valid session header/);
		});
		expect(rawFile(file).toString("utf8")).toBe(contents); // untouched, no stub rewrite
	});
});
