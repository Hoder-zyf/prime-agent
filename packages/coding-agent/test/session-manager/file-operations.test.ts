import {
	appendFileSync,
	chmodSync,
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fullReadCounter = vi.hoisted(() => ({ suffix: undefined as string | undefined, count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], options?: never) => {
			// Suffix match: repair resolves the realpath (/private/var vs /var on macOS).
			if (fullReadCounter.suffix !== undefined && String(path).endsWith(fullReadCounter.suffix)) {
				fullReadCounter.count++;
			}
			return actual.readFileSync(path, options);
		}) as typeof actual.readFileSync,
	};
});

import { computeOwnAndTotalUsage } from "../../src/core/context-tree.js";
import {
	findMostRecentSession,
	loadEntriesFromFile,
	loadEntriesFromFileAsync,
	readSessionInfo,
	resolveSessionRlmDepth,
	SessionManager,
} from "../../src/core/session-manager.js";
import { sessionUsageSummaryFrom } from "../../src/core/usage.js";

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const emptyFiles: Array<[string, string | undefined]> = [
		["a non-existent file", undefined],
		["an empty file", ""],
		["a file without a valid session header", '{"type":"message","id":"1"}\n'],
		["a malformed line", "not json\n"],
	];
	it.each(emptyFiles)("returns an empty array for %s", (_case, content) => {
		const file = join(tempDir, "entries.jsonl");
		if (content !== undefined) {
			writeFileSync(file, content);
		}
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("skips malformed lines but keeps valid ones", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
	});

	it("yields while parsing a multi-megabyte session below the streaming threshold", async () => {
		const file = join(tempDir, "buffered.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "x".repeat(5 * 1024 * 1024), timestamp: 1 },
				}),
			].join("\n"),
		);
		const setImmediateSpy = vi.spyOn(globalThis, "setImmediate");
		try {
			const entries = await loadEntriesFromFileAsync(file, { streamThresholdBytes: Number.MAX_SAFE_INTEGER });
			expect(entries).toHaveLength(2);
			expect(setImmediateSpy).toHaveBeenCalled();
		} finally {
			setImmediateSpy.mockRestore();
		}
	});

	it("streams large sessions with the same parsing semantics as the Buffer loader", async () => {
		const file = join(tempDir, "streamed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\r\n' +
				"\r\n" +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"héllo 世界","timestamp":1}}',
		);

		const streamed = await loadEntriesFromFileAsync(file, { streamThresholdBytes: 0 });
		expect(streamed).toEqual(loadEntriesFromFile(file));
	});

	it("only treats LF bytes as JSONL record boundaries", async () => {
		const file = join(tempDir, "unicode-separators.jsonl");
		const content = "before\u2028middle\u2029after";
		writeFileSync(
			file,
			[
				'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content, timestamp: 1 },
				}),
			].join("\n"),
		);

		const streamed = await loadEntriesFromFileAsync(file, { streamThresholdBytes: 0 });
		expect(streamed).toEqual(loadEntriesFromFile(file));
		expect(streamed[1]).toMatchObject({ type: "message", message: { content } });
		expect((await readSessionInfo(file))?.firstMessage).toBe(content);
	});

	it("streams a multi-megabyte JSONL record without losing following entries", async () => {
		const file = join(tempDir, "large-record.jsonl");
		const largeContent = "x".repeat(2 * 1024 * 1024);
		writeFileSync(
			file,
			[
				'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: largeContent, timestamp: 1 },
				}),
				'{"type":"message","id":"2","parentId":"1","timestamp":"2025-01-01T00:00:02Z","message":{"role":"user","content":"after","timestamp":2}}',
			].join("\n"),
		);

		const entries = await loadEntriesFromFileAsync(file, { streamThresholdBytes: 0 });
		expect(entries).toHaveLength(3);
		expect(entries[2]).toMatchObject({ type: "message", id: "2" });
	});
});

describe("session tree metadata", () => {
	it.each(["2.5", "2oops", "9007199254740993"])("rejects invalid RLM_DEPTH value %s", (value) => {
		const tempDir = join(tmpdir(), `invalid-root-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		vi.stubEnv("RLM_DEPTH", value);
		try {
			expect(() => SessionManager.create(tempDir, tempDir)).toThrow("RLM_DEPTH must be a non-negative integer");
		} finally {
			vi.unstubAllEnvs();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not persist an unsafe derived depth", () => {
		const tempDir = join(tmpdir(), `max-parent-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const parent = SessionManager.create(tempDir, tempDir);
			parent.newSession({ rlmDepth: Number.MAX_SAFE_INTEGER });
			parent.flushNow();
			const parentFile = parent.getSessionFile();
			if (!parentFile) throw new Error("Missing parent session file");

			const child = SessionManager.create(tempDir, tempDir);
			child.newSession({ parentSession: parentFile });

			expect(child.getHeader()?.rlmDepth).toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("persists a derived depth and exposes parent linkage from the header", async () => {
		const tempDir = join(tmpdir(), `session-tree-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const parent = SessionManager.create(tempDir, tempDir);
			parent.newSession({ rlmDepth: 2 });
			parent.flushNow();
			const parentFile = parent.getSessionFile();
			if (!parentFile) throw new Error("Missing parent session file");

			const child = SessionManager.create(tempDir, tempDir);
			child.newSession({ parentSession: parentFile });
			child.flushNow();
			const childFile = child.getSessionFile();
			if (!childFile) throw new Error("Missing child session file");

			const header = JSON.parse(readFileSync(childFile, "utf8").split("\n")[0] ?? "{}");
			expect(header).toMatchObject({ parentSession: parentFile, rlmDepth: 3 });
			expect(await readSessionInfo(childFile)).toMatchObject({
				parentSessionPath: parentFile,
				rlmDepth: 3,
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it.each([0, 2])("copies source depth %i across branch and fork reference edges", (depth) => {
		const tempDir = join(tmpdir(), `session-reference-depth-test-${depth}-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const source = SessionManager.create(tempDir, tempDir);
			source.newSession({ rlmDepth: depth });
			const leafId = source.appendMessage({ role: "user", content: "fork here", timestamp: 1 });
			source.flushNow();
			const sourceFile = source.getSessionFile();
			if (!sourceFile) throw new Error("Missing source session file");

			const forked = SessionManager.forkFrom(sourceFile, tempDir, tempDir);
			expect(forked.getHeader()?.rlmDepth).toBe(depth);

			const branched = SessionManager.open(sourceFile, tempDir);
			branched.createBranchedSession(leafId);
			expect(branched.getHeader()?.rlmDepth).toBe(depth);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves legacy root depth across branch and fork reference edges", () => {
		const tempDir = join(tmpdir(), `legacy-session-reference-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const source = SessionManager.create(tempDir, tempDir);
			source.newSession({ rlmDepth: undefined });
			const leafId = source.appendMessage({ role: "user", content: "fork here", timestamp: 1 });
			source.flushNow();
			const sourceFile = source.getSessionFile();
			if (!sourceFile) throw new Error("Missing source session file");

			expect(SessionManager.forkFrom(sourceFile, tempDir, tempDir).getHeader()?.rlmDepth).toBe(0);
			const branched = SessionManager.open(sourceFile, tempDir);
			branched.createBranchedSession(leafId);
			expect(branched.getHeader()?.rlmDepth).toBe(0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("leaves derived child depth unknown when a legacy parent has no depth", () => {
		const tempDir = join(tmpdir(), `legacy-parent-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const parentFile = join(tempDir, "legacy-parent.jsonl");
			writeFileSync(
				parentFile,
				`${JSON.stringify({ type: "session", id: "parent", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir })}\n`,
			);
			const child = SessionManager.create(tempDir, tempDir);
			child.newSession({ parentSession: parentFile });
			expect(child.getHeader()).toMatchObject({ parentSession: parentFile });
			expect(child.getHeader()?.rlmDepth).toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("infers root depth when materializing a legacy fork", () => {
		const tempDir = join(tmpdir(), `materialized-legacy-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const parentFile = join(tempDir, "legacy-parent.jsonl");
			const session = SessionManager.inMemory(tempDir);
			session.newSession({ parentSession: parentFile, rlmDepth: undefined });

			const sessionFile = session.materializeSessionFile(tempDir);
			const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0] ?? "{}");
			expect(header).toMatchObject({ parentSession: parentFile });
			expect(header.rlmDepth).toBe(0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("infers and backfills legacy child depth from nested subagent directories on open", async () => {
		const tempDir = join(tmpdir(), `legacy-session-tree-test-${Date.now()}-${Math.random()}`);
		const parentFile = join(tempDir, "parent.jsonl");
		const childDir = join(tempDir, "session-artifacts", "root", "sub-1234abcd", "sub-deadbeef");
		const childFile = join(childDir, "child.jsonl");
		mkdirSync(childDir, { recursive: true });
		try {
			const header = {
				type: "session" as const,
				id: "child",
				timestamp: "2025-01-01T00:00:01Z",
				cwd: tempDir,
				parentSession: parentFile,
			};
			writeFileSync(childFile, `${JSON.stringify(header)}\n`);

			expect(resolveSessionRlmDepth(header, childFile)).toBe(2);
			expect((await readSessionInfo(childFile))?.rlmDepth).toBe(2);
			expect(JSON.parse(readFileSync(childFile, "utf8").split("\n")[0] ?? "{}").rlmDepth).toBeUndefined();

			expect(SessionManager.open(childFile).getHeader()?.rlmDepth).toBe(2);
			expect(JSON.parse(readFileSync(childFile, "utf8").split("\n")[0] ?? "{}").rlmDepth).toBe(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("copies and backfills a readable source depth for a legacy fork", async () => {
		const tempDir = join(tmpdir(), `legacy-fork-source-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const sourceFile = join(tempDir, "source.jsonl");
			const forkFile = join(tempDir, "fork.jsonl");
			writeFileSync(
				sourceFile,
				`${JSON.stringify({
					type: "session",
					id: "source",
					timestamp: "2025-01-01T00:00:00Z",
					cwd: tempDir,
					rlmDepth: 2,
				})}
`,
			);
			const forkHeader = {
				type: "session" as const,
				id: "fork",
				timestamp: "2025-01-01T00:00:01Z",
				cwd: tempDir,
				parentSession: sourceFile,
			};
			writeFileSync(
				forkFile,
				`${JSON.stringify(forkHeader)}
`,
			);

			expect(resolveSessionRlmDepth(forkHeader, forkFile)).toBe(2);
			expect((await readSessionInfo(forkFile))?.rlmDepth).toBe(2);
			expect(JSON.parse(readFileSync(forkFile, "utf8").split("\n")[0] ?? "{}").rlmDepth).toBeUndefined();

			expect(SessionManager.open(forkFile).getHeader()?.rlmDepth).toBe(2);
			expect(JSON.parse(readFileSync(forkFile, "utf8").split("\n")[0] ?? "{}").rlmDepth).toBe(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("treats a legacy fork in the sessions directory as a root", async () => {
		const tempDir = join(tmpdir(), `legacy-fork-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const forkFile = join(tempDir, "fork.jsonl");
			const header = {
				type: "session" as const,
				id: "fork",
				timestamp: "2025-01-01T00:00:01Z",
				cwd: tempDir,
				parentSession: join(tempDir, "source.jsonl"),
			};
			writeFileSync(forkFile, `${JSON.stringify(header)}\n`);

			expect(resolveSessionRlmDepth(header, forkFile)).toBe(0);
			expect((await readSessionInfo(forkFile))?.rlmDepth).toBe(0);
			expect(SessionManager.open(forkFile).getHeader()?.rlmDepth).toBe(0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not count a matching segment outside the trailing subagent path", () => {
		const sessionFile = join(tmpdir(), "sub-deadbeef", "sessions", "child.jsonl");
		expect(resolveSessionRlmDepth({ parentSession: "/missing-parent.jsonl" }, sessionFile)).toBe(0);
	});

	it("prefers the parent header depth over path inference", () => {
		const tempDir = join(tmpdir(), `parent-header-depth-test-${Date.now()}-${Math.random()}`);
		const parentFile = join(tempDir, "parent.jsonl");
		const childFile = join(tempDir, "sub-1234abcd", "sub-deadbeef", "child.jsonl");
		mkdirSync(tempDir, { recursive: true });
		try {
			writeFileSync(
				parentFile,
				`${JSON.stringify({
					type: "session",
					id: "parent",
					timestamp: "2025-01-01T00:00:00Z",
					cwd: tempDir,
					rlmDepth: 4,
				})}
`,
			);

			expect(resolveSessionRlmDepth({ parentSession: parentFile }, childFile)).toBe(5);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves relative parent paths from each legacy session directory", () => {
		const tempDir = join(tmpdir(), `relative-parent-depth-test-${Date.now()}-${Math.random()}`);
		const grandparentFile = join(tempDir, "grandparent.jsonl");
		const parentFile = join(tempDir, "parent.jsonl");
		const childDir = join(tempDir, "sub-1234abcd");
		const childFile = join(childDir, "child.jsonl");
		mkdirSync(childDir, { recursive: true });
		try {
			writeFileSync(
				grandparentFile,
				`${JSON.stringify({
					type: "session",
					id: "grandparent",
					timestamp: "2025-01-01T00:00:00Z",
					cwd: tempDir,
					rlmDepth: 4,
				})}
`,
			);
			writeFileSync(
				parentFile,
				`${JSON.stringify({
					type: "session",
					id: "parent",
					timestamp: "2025-01-01T00:00:01Z",
					cwd: tempDir,
					parentSession: "grandparent.jsonl",
				})}
`,
			);

			expect(resolveSessionRlmDepth({ parentSession: "../parent.jsonl" }, childFile)).toBe(5);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("prefers a valid persisted depth over path inference", () => {
		const sessionFile = join(tmpdir(), "sub-1234abcd", "sub-deadbeef", "session.jsonl");
		expect(resolveSessionRlmDepth({ parentSession: "/parent.jsonl", rlmDepth: 7 }, sessionFile)).toBe(7);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});
});

describe("SessionManager.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// The suspicion gate must keep clean opens at ONE full read (the loader's own).
	it.each([
		[
			"a clean large session",
			(): string[] => {
				const filler = "x".repeat(2048);
				const lines: string[] = [];
				for (let index = 0; index < 2000; index++) {
					lines.push(
						JSON.stringify({
							type: "message",
							id: `m${index}`,
							parentId: index === 0 ? null : `m${index - 1}`,
							message: { role: "user", content: filler, timestamp: index },
						}),
					);
				}
				return lines;
			},
		],
		[
			"a benign trailing blank line",
			(): string[] => [
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					message: { role: "user", content: "hi", timestamp: 1 },
				}),
				"",
			],
		],
	])("opens %s with exactly one full read", (_name, buildLines) => {
		const file = join(tempDir, "gate.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "gate-session",
			timestamp: "2026-01-01T00:00:00Z",
			cwd: "/tmp",
		};
		writeFileSync(file, `${[JSON.stringify(header), ...buildLines()].join("\n")}\n`);
		fullReadCounter.suffix = "gate.jsonl";
		fullReadCounter.count = 0;

		try {
			SessionManager.open(file, tempDir);
			expect(fullReadCounter.count).toBe(1);
		} finally {
			fullReadCounter.suffix = undefined;
		}
	});

	it("repairs crash damage at open: torn tail truncated, zero-filled record recovered, appends stay separate lines", () => {
		const file = join(tempDir, "crashed.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "crashed-session",
			timestamp: "2026-01-01T00:00:00Z",
			cwd: "/tmp",
		};
		const kept = {
			type: "message",
			id: "m1",
			parentId: null,
			message: { role: "user", content: "kept", timestamp: 1 },
		};
		const zeroFilled = {
			type: "message",
			id: "m2",
			parentId: "m1",
			message: { role: "user", content: "recovered", timestamp: 2 },
		};
		const damaged = `${JSON.stringify(header)}\n${JSON.stringify(kept)}\n\u0000\u0000\u0000\u0000${JSON.stringify(zeroFilled)}\n{"type":"message","id":"torn`;
		writeFileSync(file, damaged);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const sm = SessionManager.open(file, tempDir);
			expect(sm.getHeader()?.id).toBe("crashed-session");
			expect(sm.getEntries().map((entry) => entry.id)).toEqual(["m1", "m2"]);
			sm.appendMessage({ role: "user", content: "after crash", timestamp: 3 });
			sm.flushNow();

			const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
			const parsed = lines.map((line) => JSON.parse(line));
			expect(parsed.map((entry) => entry.id ?? entry.type)).toEqual([
				"crashed-session",
				"m1",
				"m2",
				expect.any(String),
			]);
			expect(parsed.at(-1)?.message?.content).toBe("after crash");
			expect(errorSpy).toHaveBeenCalledTimes(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("repairs a damaged transcript through its symlink alias at the real file", () => {
		const realFile = join(tempDir, "real.jsonl");
		const alias = join(tempDir, "alias.jsonl");
		const header = { type: "session", version: 3, id: "sym-session", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" };
		writeFileSync(realFile, `${JSON.stringify(header)}\n{"type":"message","id":"torn`);
		chmodSync(realFile, 0o600);
		symlinkSync(realFile, alias);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			SessionManager.open(alias, tempDir);
			expect(lstatSync(alias).isSymbolicLink()).toBe(true);
			const repaired = readFileSync(realFile, "utf-8");
			expect(repaired.endsWith("\n")).toBe(true);
			expect(repaired).not.toContain("torn");
			expect(statSync(realFile).mode & 0o777).toBe(0o600);
		} finally {
			errorSpy.mockRestore();
		}
	});

	const noHeader = '{"type":"message","id":"abc","message":{"role":"assistant"}}\n';
	const damaged: Array<[string, string]> = [
		["an empty file", ""],
		["a file with no session header", noHeader],
	];
	it.each(damaged)("truncates and rewrites %s into a valid session", (_case, content) => {
		const file = join(tempDir, "recovered.jsonl");
		writeFileSync(file, content);
		const sm = SessionManager.open(file, tempDir);
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");
		const lines = readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		expect(JSON.parse(lines[0]).id).toBe(sm.getSessionId());
	});

	it("keeps the explicit path and a stable id across recovered loads", () => {
		const file = join(tempDir, "my-session.jsonl");
		writeFileSync(file, "garbage content\n");
		const first = SessionManager.open(file, tempDir);
		expect(first.getSessionFile()).toBe(file);
		const second = SessionManager.open(file, tempDir);
		expect(second.getSessionId()).toBe(first.getSessionId());
		expect(second.getHeader()?.type).toBe("session");
	});
});

describe("session info usage totals", () => {
	it("scan and resident computation agree on whole-file own spend, forks and attributions included", async () => {
		const tempDir = join(tmpdir(), `session-usage-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const usage = (input: number, output: number, cost: number, cacheRead = 10, cacheWrite = 5) => ({
				input,
				output,
				cacheRead,
				cacheWrite,
				totalTokens: input + output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
			});
			const msg = (id: string, parentId: string | null, role: string, u?: unknown) =>
				({ type: "message", id, parentId, message: { role, content: "x", timestamp: 1, usage: u } }) as const;
			const file = join(tempDir, "usage.jsonl");
			const lines = [
				{ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" },
				msg("m1", null, "user"),
				msg("m2", "m1", "assistant", usage(1000, 200, 0.5)),
				// On-disk original usage; the loader folds the aggregate below onto it in memory.
				msg("m3", "m1", "assistant", usage(2000, 300, 1.0)),
				{
					type: "child_usage_attributed",
					id: "a1",
					parentId: "m3",
					targetId: "m3",
					childUsage: usage(500, 100, 0.4),
					aggregateUsage: usage(2500, 400, 1.4, 20, 10),
				},
				{
					type: "compaction",
					id: "c1",
					parentId: "m3",
					summary: "compacted",
					firstKeptEntryId: "m3",
					tokensBefore: 5000,
					usage: usage(100, 20, 0.05),
				},
				{
					type: "branch_summary",
					id: "b1",
					parentId: "c1",
					fromId: "m1",
					summary: "left",
					usage: usage(60, 8, 0.02),
				},
			];
			writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

			const entries = SessionManager.open(file).getEntries();
			const resident = sessionUsageSummaryFrom(computeOwnAndTotalUsage(entries, entries).ownUsage);

			const scanned = (await readSessionInfo(file))?.usage;
			expect(scanned).toMatchObject({ inputTokens: 3220, outputTokens: 528 });
			expect(scanned?.cost).toBeCloseTo(1.57);
			expect(resident).toEqual(scanned);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("readSessionInfo incremental scans", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-scan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const header = { type: "session", version: 3, id: "scan1", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" };
	const msg = (id: string, parentId: string | null, role: string, text: string) => ({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01Z",
		message: { role, content: text, timestamp: 1 },
	});
	const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;

	it("scans the last recorded model from model_change entries and assistant messages", async () => {
		const file = join(tempDir, "model.jsonl");
		writeFileSync(
			file,
			[
				line(header),
				line({ type: "model_change", id: "mc1", parentId: null, provider: "openai", modelId: "gpt-4o" }),
				line(msg("m1", "mc1", "user", "hi")),
				line({
					type: "message",
					id: "m2",
					parentId: "m1",
					message: {
						role: "assistant",
						content: "x",
						timestamp: 1,
						provider: "prime-inference",
						model: "glm-4.7",
					},
				}),
			].join(""),
		);
		expect((await readSessionInfo(file))?.model).toEqual({ provider: "prime-inference", modelId: "glm-4.7" });

		const bare = join(tempDir, "bare.jsonl");
		writeFileSync(bare, line(header));
		expect((await readSessionInfo(bare))?.model).toBeUndefined();
	});

	it("coalesces concurrent unchanged readers and gives post-append readers the fresh snapshot", async () => {
		const file = join(tempDir, "serialized.jsonl");
		let content = line(header);
		for (let i = 0; i < 20000; i++) {
			content += line(msg(`m${i}`, i === 0 ? null : `m${i - 1}`, "user", `filler message ${i} ${"x".repeat(120)}`));
		}
		writeFileSync(file, content);

		const [first, second] = await Promise.all([readSessionInfo(file), readSessionInfo(file)]);
		expect(first?.messageCount).toBe(20000);
		expect(second).toBe(first);

		const early = readSessionInfo(file);
		// Let the scan stat the file and start streaming before the append.
		await new Promise((resolveTick) => setImmediate(resolveTick));
		appendFileSync(file, line(msg("late", "m19999", "assistant", "post-append entry")));
		const late = await readSessionInfo(file);
		expect(late?.messageCount).toBe(20001);
		expect((await early)?.messageCount).toBeLessThanOrEqual(20001);
	});

	it("resumes from the scanned offset: prefix never re-read, torn tail folded exactly once", async () => {
		const file = join(tempDir, "incremental.jsonl");
		const torn = line(msg("m2", "m1", "assistant", "answer"));
		writeFileSync(file, line(header) + line(msg("m1", null, "user", "original question")) + torn.slice(0, 20));
		expect((await readSessionInfo(file))?.messageCount).toBe(1);

		// Same-length positional write into the scanned prefix, keeping the inode:
		// outside the writer model, so consumed bytes are never re-read.
		const position = readFileSync(file, "utf8").indexOf("original question");
		const fd = openSync(file, "r+");
		try {
			writeSync(fd, Buffer.from("modified question"), 0, 17, position);
		} finally {
			closeSync(fd);
		}
		appendFileSync(file, torn.slice(20));

		const info = await readSessionInfo(file);
		expect(info?.messageCount).toBe(2);
		expect(info?.firstMessage).toBe("original question");
	});

	// The rename row preserves the 16 bytes before the old offset, so only the
	// replaced inode identifies it; the truncate row keeps the inode, so only
	// the changed prefix tail does.
	it.each([
		{ mode: "rename", first: "name variant AAAA", rewrittenFirst: "name variant BBBB" },
		{ mode: "truncate", first: "first draft AAAAAA", rewrittenFirst: "rewritten opening line" },
	])("rescans from byte 0 after a grown $mode rewrite", async ({ mode, first, rewrittenFirst }) => {
		const file = join(tempDir, `${mode}-rewrite.jsonl`);
		writeFileSync(
			file,
			line(header) + line(msg("m1", null, "user", first)) + line(msg("m2", "m1", "assistant", "stable reply")),
		);
		expect((await readSessionInfo(file))?.firstMessage).toBe(first);

		const rewritten =
			line(header) +
			line(msg("m1", null, "user", rewrittenFirst)) +
			line(msg("m2", "m1", "assistant", "stable reply")) +
			line(msg("m3", "m2", "assistant", "appended"));
		if (mode === "rename") {
			const tempPath = join(tempDir, "rewrite.tmp");
			writeFileSync(tempPath, rewritten);
			renameSync(tempPath, file);
		} else {
			writeFileSync(file, rewritten);
		}

		const info = await readSessionInfo(file);
		expect(info?.messageCount).toBe(3);
		expect(info?.firstMessage).toBe(rewrittenFirst);
	});

	it("invalidates scanned bytes after crash repair and resumes later appends", async () => {
		const file = join(tempDir, "repaired-scan.jsonl");
		writeFileSync(
			file,
			line(header) +
				line(msg("m1", null, "user", "kept")) +
				"\0\0" +
				line(msg("m2", "m1", "user", "recovered")) +
				'{"type":"message","id":"torn',
		);
		expect((await readSessionInfo(file))?.messageCount).toBe(1);
		const manager = SessionManager.open(file, tempDir);
		expect((await readSessionInfo(file))?.messageCount).toBe(2);
		manager.appendMessage({ role: "user", content: "after repair", timestamp: 3 });
		manager.flushNow();
		const scanned = await readSessionInfo(file);
		expect(scanned?.messageCount).toBe(3);
		expect(scanned?.allMessagesText).toContain("recovered");
		expect(scanned?.allMessagesText).toContain("after repair");
	});

	it("evicts scan state when the file disappears so a recreated file rescans", async () => {
		const file = join(tempDir, "recreated.jsonl");
		writeFileSync(file, line(header) + line(msg("m1", null, "user", "before delete")));
		const fixedTime = new Date("2026-01-02T00:00:00Z");
		utimesSync(file, fixedTime, fixedTime);
		expect((await readSessionInfo(file))?.firstMessage).toBe("before delete");

		rmSync(file);
		expect(await readSessionInfo(file)).toBeNull();

		writeFileSync(file, line(header) + line(msg("m1", null, "user", "after recreate")));
		utimesSync(file, fixedTime, fixedTime);
		expect((await readSessionInfo(file))?.firstMessage).toBe("after recreate");
	});
	describe("tool-result entries counted from their headers", () => {
		const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 3 } };
		const tokens = { inputTokens: 1, outputTokens: 2, cost: 3 };
		const entry = (body: string, idFirst = false) =>
			idFirst
				? `{"id":"e","parentId":null,"timestamp":"${header.timestamp}","type":"message",${body}}\n`
				: `{"type":"message","id":"e","parentId":null,"timestamp":"${header.timestamp}",${body}}\n`;
		const message = (role: string, body: string, idFirst = false) =>
			entry(`"message":{"role":"${role}",${body}}`, idFirst);
		const ask = message("user", '"content":"hello","timestamp":1');
		const reply = message("assistant", `"content":"reply","timestamp":1,"usage":${JSON.stringify(usage)}`);
		const prompt = line(header) + ask + reply;
		const tool = (text: string, idFirst = false) =>
			message("toolResult", `"content":"${text}","timestamp":5000`, idFirst);
		/** An entry torn mid-write: its serialized header is intact, its JSON is not. */
		const torn = (entry: string) => entry.slice(0, entry.indexOf('"content"'));
		const write = (name: string, content: string) => {
			const file = join(tempDir, `${name}.jsonl`);
			writeFileSync(file, content);
			return file;
		};

		const counted: Array<[string, () => string, number]> = [
			["an unparsed", () => torn(tool("partial")), 3],
			["an oversized", () => tool("y".repeat(1024 * 1024 + 512)), 3],
			["an id-first", () => tool("paste", true) + torn(tool("partial", true)), 4],
		];
		it.each(counted)("counts %s tool result from its header", async (_case, build, messageCount) => {
			const info = await readSessionInfo(write("counted", prompt + build()));
			expect(info).toMatchObject({ messageCount, allMessagesText: "hello reply", usage: tokens });
			expect(info?.firstMessage).toBe("hello");
		});

		it("counts a torn tool-result tail once across incremental scans", async () => {
			const file = write("torn-append", prompt + torn(tool("partial")));
			expect((await readSessionInfo(file))?.messageCount).toBe(3);
			appendFileSync(file, '"content":"paste"},"timestamp":5000}}\n');
			expect((await readSessionInfo(file))?.messageCount).toBe(3);
		});

		it("drops a damaged session whose first entry is a tool result", async () => {
			expect(await readSessionInfo(write("headerless", tool("paste")))).toBeNull();
			expect(await SessionManager.listAll(undefined, tempDir)).toEqual([]);
		});

		const container = `{"type":"message","meta":{"message":{"role":"toolResult"}},"message":{"role":"user","content":"kept","timestamp":1}}`;
		const embedded = `{"id":"n1","parentId":null,"timestamp":"${header.timestamp}","type":"session_info","data":{"type":"message","message":{"role":"toolResult"}}}`;
		const spaced = `{"type": "message", "message": {"role": "toolResult", "content": [{"type": "text", "text": "spaced"}], "isError": false}}`;
		const quoted = 'bench log: {"type":"message","message":{"role":"toolResult"}}';
		const boundary = (idLength: number) =>
			`{"type":"message","id":"${"x".repeat(idLength)}","parentId":null,"timestamp":"${header.timestamp}","message":{"role":"user","content":"kept","timestamp":1}}`;
		const boundaryId = 512 - 19 - boundary(0).indexOf('"message":{"role":"');
		const quotedReply = line(msg("a2", "a1", "assistant", quoted));

		it.each([
			["a container before the role marker", `${line(header)}${container}\n`, 1, "kept"],
			["a quoted header inside text", `${prompt}${quotedReply}`, 3, `hello reply ${quoted}`],
			["a spaced layout", `${prompt}${spaced}\n`, 3, "hello reply"],
			["the role at the prefix boundary", `${line(header)}${boundary(boundaryId)}\n`, 1, "kept"],
			["an embedded header inside a payload", `${line(header)}${embedded}\n${ask}`, 1, "hello"],
		])("folds %s through the full parse", async (_layout, content, messageCount, allMessagesText) => {
			const info = await readSessionInfo(write("fallback", content));
			expect(info).toMatchObject({ messageCount, allMessagesText });
		});
	});
});
