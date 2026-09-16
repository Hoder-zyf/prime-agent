import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSessionInfo, SessionManager } from "../../src/core/session-manager.js";

const timestamp = "2026-01-01T00:00:00.000Z";
const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};
const expectedUsage = (count: number) => ({ inputTokens: count, outputTokens: count * 2, cost: count * 3 });

/** Entry serialized in the order SessionManager writes it (type key first). */
function entry(type: string, id: string, parentId: string | null, rest: Record<string, unknown>): string {
	return `${JSON.stringify({ type, id, parentId, timestamp, ...rest })}\n`;
}

/** Entry serialized in the id-first order (type key last), as other writers and fixtures emit it. */
function legacyEntry(type: string, id: string, parentId: string | null, rest: Record<string, unknown>): string {
	return `${JSON.stringify({ id, parentId, timestamp, type, ...rest })}\n`;
}

function userEntry(id: string, parentId: string | null, text: string, messageTimestamp: number): string {
	return entry("message", id, parentId, { message: { role: "user", content: text, timestamp: messageTimestamp } });
}

function assistantEntry(id: string, parentId: string | null, text: string, messageTimestamp: number): string {
	return entry("message", id, parentId, {
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "responses",
			provider: "test",
			model: "test",
			stopReason: "stop",
			timestamp: messageTimestamp,
			usage,
		},
	});
}

function writeSession(dir: string, id: string, lines: string[]): string {
	const path = join(dir, `${id}.jsonl`);
	writeFileSync(
		path,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: dir, rlmDepth: 0 })}\n${lines.join("")}`,
	);
	return path;
}

function withDir(run: (dir: string) => Promise<void>): () => Promise<void> {
	return async () => {
		const dir = mkdtempSync(join(tmpdir(), "message-count-scan-"));
		try {
			await run(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

describe("session list message counts", () => {
	it(
		"counts a tool-result entry from its header when its payload does not parse",
		withDir(async (dir) => {
			const brokenToolResult =
				`{"type":"message","id":"t1","parentId":"a1","timestamp":"${timestamp}",` +
				'"message":{"role":"toolResult","toolCallId":"c1","toolName":"ipython","content":[{"type":"text","text":"partial';
			const path = writeSession(dir, "broken-tool-result", [
				userEntry("u1", null, "hello", 1000),
				assistantEntry("a1", "u1", "reply", 2000),
				`${brokenToolResult}\n`,
			]);

			const info = await readSessionInfo(path);

			expect(info?.messageCount, "the entry header proves the tool result").toBe(3);
			expect(info?.firstMessage).toBe("hello");
			expect(info?.allMessagesText).toBe("hello reply");
			expect(info?.usage).toEqual(expectedUsage(1));
			expect(info?.modified.getTime()).toBe(2000);
		}),
	);

	it(
		"counts a tool result whose header puts the type key after the entry metadata",
		withDir(async (dir) => {
			const toolResultMessage = {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "ipython",
				content: [{ type: "text", text: "paste" }],
				isError: false,
				timestamp: 5000,
			};
			writeSession(dir, "legacy-order", [
				legacyEntry("message", "u1", null, { message: { role: "user", content: "hello", timestamp: 1000 } }),
				legacyEntry("message", "a1", "u1", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "reply" }],
						api: "responses",
						provider: "test",
						model: "test",
						stopReason: "stop",
						timestamp: 2000,
						usage,
					},
				}),
				legacyEntry("message", "t1", "a1", {
					message: { ...toolResultMessage, content: [{ type: "text", text: "pa" }] },
				}),
				`{"id":"t2","parentId":"t1","timestamp":"${timestamp}","type":"message","message":{"role":"toolResult","toolCallId":"c2","toolName":"ipython","content":[{"type":"text","text":"partial`,
				`\n`,
			]);

			const [session] = await SessionManager.listAll(undefined, dir);

			expect(session?.messageCount, "both tool results count from their headers").toBe(4);
			expect(session?.allMessagesText).toBe("hello reply");
			expect(session?.usage).toEqual(expectedUsage(1));
			expect(session?.modified.getTime()).toBe(2000);
		}),
	);

	it(
		"keeps folding an entry whose payload embeds the message header layout",
		withDir(async (dir) => {
			const path = writeSession(dir, "embedded-layout", [
				legacyEntry("session_info", "n1", "a1", {
					data: { type: "message", message: { role: "toolResult" } },
					name: "kept name",
				}),
				userEntry("u1", null, "hello", 1000),
			]);

			const info = await readSessionInfo(path);

			expect(info?.name, "the embedded layout is a payload, not the entry header").toBe("kept name");
			expect(info?.messageCount).toBe(1);
		}),
	);

	it(
		"does not treat a message header quoted inside searchable text as a tool result",
		withDir(async (dir) => {
			const quoted = 'bench log: {"type":"message","message":{"role":"toolResult"}}';
			writeSession(dir, "quoted-header", [
				userEntry("u1", null, "hello", 1000),
				assistantEntry("a1", "u1", quoted, 2000),
			]);

			const [session] = await SessionManager.listAll(undefined, dir);

			expect(session?.messageCount).toBe(2);
			expect(session?.usage, "the assistant entry is still folded").toEqual(expectedUsage(1));
			expect(session?.allMessagesText).toBe(`hello ${quoted}`);
		}),
	);

	it(
		"counts a tool result larger than the parse limit without reading it as content",
		withDir(async (dir) => {
			const path = writeSession(dir, "oversized-tool-result", [
				userEntry("u1", null, "hello", 1000),
				assistantEntry("a1", "u1", "reply", 2000),
				entry("message", "t1", "a1", {
					message: {
						role: "toolResult",
						toolCallId: "c1",
						toolName: "ipython",
						content: [{ type: "text", text: "y".repeat(1024 * 1024 + 512) }],
						isError: false,
						timestamp: 5000,
					},
				}),
			]);

			const info = await readSessionInfo(path);

			expect(info?.messageCount).toBe(3);
			expect(info?.firstMessage).toBe("hello");
			expect(info?.allMessagesText).toBe("hello reply");
			expect(info?.usage).toEqual(expectedUsage(1));
			expect(info?.modified.getTime()).toBe(2000);
		}),
	);

	it(
		"drops a damaged session whose first entry is a tool result",
		withDir(async (dir) => {
			const path = join(dir, "headerless.jsonl");
			writeFileSync(
				path,
				entry("message", "t1", null, {
					message: { role: "toolResult", toolCallId: "c1", toolName: "ipython", content: [], isError: false },
				}),
			);

			expect(await readSessionInfo(path)).toBeNull();
			expect(await SessionManager.listAll(undefined, dir)).toEqual([]);
		}),
	);

	it(
		"falls back for a container between the type key and the role marker",
		withDir(async (dir) => {
			// The meta payload quotes the header layout, so the first role marker after the
			// type key belongs to meta, not to the entry's own message.
			const shadowed = `{"type":"message","meta":{"message":{"role":"toolResult"}},"message":{"role":"user","content":"kept","timestamp":1000}}`;
			const path = writeSession(dir, "shadowed-role", [`${shadowed}\n`]);

			const info = await readSessionInfo(path);

			expect(info?.messageCount, "the entry itself is a message").toBe(1);
			expect(info?.firstMessage, "a shadowed role marker must not hide the entry's text").toBe("kept");
			expect(info?.allMessagesText).toBe("kept");
			expect(info?.modified.getTime()).toBe(1000);
		}),
	);

	it(
		"falls back when the role value starts at the header prefix boundary",
		withDir(async (dir) => {
			const padded = (idLength: number) =>
				`{"type":"message","id":"${"x".repeat(idLength)}","parentId":null,"timestamp":"${timestamp}",` +
				'"message":{"role":"user","content":"kept","timestamp":1000}}';
			// Padding the id past the prefix boundary leaves the role value outside the
			// window the header check reads, so the line must take the full parse.
			const idLength = 512 - 19 - padded(0).indexOf('"message":{"role":"');
			const line = padded(idLength);
			expect(line.indexOf('"message":{"role":"') + 19).toBe(512);
			const path = writeSession(dir, "role-at-boundary", [`${line}\n`]);

			const info = await readSessionInfo(path);

			expect(info?.messageCount).toBe(1);
			expect(info?.firstMessage).toBe("kept");
			expect(info?.allMessagesText).toBe("kept");
			expect(info?.modified.getTime()).toBe(1000);
		}),
	);

	it(
		"counts a torn tool-result tail once across incremental scans",
		withDir(async (dir) => {
			const path = join(dir, "torn-append.jsonl");
			writeFileSync(
				path,
				`${JSON.stringify({ type: "session", version: 3, id: "torn-append", timestamp, cwd: dir, rlmDepth: 0 })}\n` +
					userEntry("u1", null, "hello", 1000) +
					assistantEntry("a1", "u1", "reply", 2000) +
					`{"type":"message","id":"t1","parentId":"a1","timestamp":"${timestamp}",` +
					'"message":{"role":"toolResult","toolCallId":"c1","toolName":"ipython","content":[{"type":"text","text":"partial',
			);

			const torn = await readSessionInfo(path);

			expect(torn?.messageCount, "the in-flight append counts from its header").toBe(3);
			expect(torn?.allMessagesText).toBe("hello reply");

			appendFileSync(path, '"}],"isError":false,"timestamp":5000}}\n');

			const completed = await readSessionInfo(path);

			expect(completed?.messageCount, "the completed line is not counted twice").toBe(3);
			expect(completed?.allMessagesText).toBe("hello reply");
			expect(completed?.usage).toEqual(expectedUsage(1));
			expect(completed?.modified.getTime()).toBe(2000);
			expect((await readSessionInfo(path))?.messageCount, "an unchanged rescan stays stable").toBe(3);
		}),
	);

	it(
		"folds a spaced header layout through the full parse",
		withDir(async (dir) => {
			const spacedToolResult =
				`{"type": "message", "id": "t1", "parentId": "a1", "timestamp": "${timestamp}", ` +
				'"message": {"role": "toolResult", "toolCallId": "c1", "toolName": "ipython", ' +
				'"content": [{"type": "text", "text": "spaced"}], "isError": false, "timestamp": 5000}}';
			const path = writeSession(dir, "spaced-layout", [
				userEntry("u1", null, "hello", 1000),
				assistantEntry("a1", "u1", "reply", 2000),
				`${spacedToolResult}\n`,
			]);

			const info = await readSessionInfo(path);

			expect(info?.messageCount).toBe(3);
			expect(info?.allMessagesText).toBe("hello reply");
			expect(info?.modified.getTime()).toBe(2000);
		}),
	);
});
