import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLatestCompactionEntry, SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

// SessionManager caches the live leaf's branch path (getBranch() reads) because
// agent-session re-reads it on every assistant message end. These tests pin the
// cache's contract: identical reads share the array, appends extend it, every
// other leaf move drops it, and non-leaf reads never poison it.
describe("SessionManager leaf branch cache", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	function createTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-leaf-branch-cache-"));
		tempDirs.push(dir);
		return dir;
	}

	function ids(session: SessionManager): string[] {
		return session.getBranch().map((entry) => entry.id);
	}

	// Walks the cached path and checks it against the byId parent chain, so a
	// stale or half-extended cache cannot pass by returning the right ids only.
	function expectChainMatches(session: SessionManager, expected: string[]): void {
		const branch = session.getBranch();
		expect(branch.map((entry) => entry.id)).toEqual(expected);
		for (let index = 1; index < branch.length; index++) {
			expect(branch[index]!.parentId).toBe(branch[index - 1]!.id);
			expect(session.getEntry(branch[index]!.id)).toBe(branch[index]);
		}
	}

	it("returns the same cached array for repeated leaf reads", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage(userMsg("one"));
		const secondId = session.appendMessage(assistantMsg("two"));

		const first = session.getBranch();
		const second = session.getBranch();

		expect(second).toBe(first);
		expect(first.map((entry) => entry.id)).toEqual([firstId, secondId]);
	});

	it("extends the cached branch in place on append", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage(userMsg("one"));
		const secondId = session.appendMessage(assistantMsg("two"));
		expect(ids(session)).toEqual([firstId, secondId]); // populates the cache

		const thirdId = session.appendCustomMessageEntry("note", "hello", false);
		expectChainMatches(session, [firstId, secondId, thirdId]);

		const fourthId = session.appendMessage(userMsg("four"));
		expectChainMatches(session, [firstId, secondId, thirdId, fourthId]);
	});

	it("invalidates the cached branch when branching to an older entry", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage(userMsg("one"));
		const secondId = session.appendMessage(assistantMsg("two"));
		expect(ids(session)).toEqual([firstId, secondId]); // populates the cache

		session.branch(firstId);
		expectChainMatches(session, [firstId]);

		const siblingId = session.appendMessage(userMsg("sibling"));
		expectChainMatches(session, [firstId, siblingId]);

		// Branching back to the abandoned entry must not resurrect the old cache.
		session.branch(secondId);
		expectChainMatches(session, [firstId, secondId]);
	});

	it("invalidates the cached branch on resetLeaf", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage(userMsg("one"));
		const secondId = session.appendMessage(assistantMsg("two"));
		expect(ids(session)).toEqual([firstId, secondId]);

		session.resetLeaf();
		expect(session.getLeafId()).toBeNull();
		expect(session.getBranch()).toEqual([]);

		// A reset leaf re-roots the next append.
		const rootId = session.appendMessage(userMsg("root again"));
		expect(session.getEntry(rootId)?.parentId).toBeNull();
		expectChainMatches(session, [rootId]);
	});

	it("invalidates the cached branch when a branch summary changes the path", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage(userMsg("one"));
		const secondId = session.appendMessage(assistantMsg("two"));
		const thirdId = session.appendMessage(userMsg("three"));
		expect(ids(session)).toEqual([firstId, secondId, thirdId]);

		const summaryId = session.branchWithSummary(secondId, "summary of the abandoned path");
		expectChainMatches(session, [firstId, secondId, summaryId]);
		expect(getLatestCompactionEntry(session.getBranch())).toBeNull();

		const compactionId = session.appendCompaction("compaction summary", thirdId, 1234, {
			readFiles: [],
			modifiedFiles: [],
		});
		expect(getLatestCompactionEntry(session.getBranch())?.id).toBe(compactionId);
		expectChainMatches(session, [firstId, secondId, summaryId, compactionId]);
	});

	it("returns the correct suffix for a mid-branch read without poisoning the leaf cache", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage(userMsg("one"));
		const secondId = session.appendMessage(assistantMsg("two"));
		const thirdId = session.appendMessage(userMsg("three"));
		const fourthId = session.appendMessage(assistantMsg("four"));

		const leafPath = session.getBranch();
		expect(leafPath.map((entry) => entry.id)).toEqual([firstId, secondId, thirdId, fourthId]);

		const suffix = session.getBranch(secondId);
		expect(suffix.map((entry) => entry.id)).toEqual([firstId, secondId]);
		expect(suffix).not.toBe(leafPath);

		// The mid-branch read must not have replaced the cached leaf path.
		const reread = session.getBranch();
		expect(reread).toBe(leafPath);
		expect(reread.map((entry) => entry.id)).toEqual([firstId, secondId, thirdId, fourthId]);

		// ...nor cached a suffix as if it were the leaf path.
		session.appendMessage(userMsg("five"));
		expect(session.getBranch().map((entry) => entry.id)).toEqual([
			firstId,
			secondId,
			thirdId,
			fourthId,
			session.getLeafId(),
		]);
	});

	it("drops the cached branch when a failed append is rolled back", () => {
		const dir = createTempDir();
		const session = SessionManager.create(dir, join(dir, "sessions"));
		const firstId = session.appendMessage(userMsg("one"));
		expect(ids(session)).toEqual([firstId]); // populates the cache

		vi.spyOn(session, "_persist").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		expect(() => session.appendCustomMessageEntryWithRollback("note", "unsaved", false)).toThrow("disk full");

		expect(session.getLeafId()).toBe(firstId);
		expectChainMatches(session, [firstId]);

		// The next append starts from the rolled-back leaf and stays coherent.
		const secondId = session.appendCustomMessageEntry("note", "saved", false);
		expectChainMatches(session, [firstId, secondId]);

		// The rolled-back entry must not reach disk either: the rewrite triggered
		// by the assistant message must produce the same path the cache serves.
		const thirdId = session.appendMessage(assistantMsg("three"));
		expectChainMatches(session, [firstId, secondId, thirdId]);
		expect(
			SessionManager.open(session.getSessionFile()!)
				.getBranch()
				.map((entry) => entry.id),
		).toEqual(session.getBranch().map((entry) => entry.id));
	});

	it("keeps the cached branch identical to a reopened session's branch", () => {
		const dir = createTempDir();
		const session = SessionManager.create(dir, join(dir, "sessions"));
		const firstId = session.appendMessage(userMsg("one"));
		const secondId = session.appendMessage(assistantMsg("two"));
		const thirdId = session.appendMessage(userMsg("three"));

		const reopened = SessionManager.open(session.getSessionFile()!);

		expect(reopened.getBranch().map((entry) => entry.id)).toEqual(session.getBranch().map((entry) => entry.id));
		expect(reopened.getBranch().map((entry) => entry.id)).toEqual([firstId, secondId, thirdId]);
	});
});
