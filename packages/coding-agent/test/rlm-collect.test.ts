import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionMessageController } from "../src/core/agent-messages.js";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createRlmCollectHostHandler, type SubagentRuntimeHost } from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function userText(context: Context): string {
	const last = context.messages.at(-1);
	if (!last || last.role !== "user") return "";
	if (typeof last.content === "string") return last.content;
	return last.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function usage(input = 7, output = 3): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

function streamAnswer(text: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

async function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await sleep(10);
	}
}

/**
 * Release every gated child answer until the listed runs leave the run maps
 * (their detached unwind settled). Every wait is bounded.
 */
async function waitForRlmRunCleanup(
	gate: { releaseAll: () => void },
	session: AgentSession,
	childIds: string[],
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && childIds.some((childId) => session.getRlmChildRunStatus(childId) !== undefined)) {
		gate.releaseAll();
		await sleep(20);
	}
	for (const childId of childIds) {
		if (session.getRlmChildRunStatus(childId) !== undefined) {
			throw new Error(`Timed out waiting for RLM child cleanup: ${childId}`);
		}
	}
}

/** Stream that answers only once its release promise resolves; each call gets its own gate. */
function createGatedStream() {
	const releases: Array<() => void> = [];
	const startedPrompts = new Set<string>();
	const streamFn: StreamFn = (_model, context) => {
		const text = userText(context).replace(/^\[task from parent\]\n\n/, "");
		const stream = createAssistantMessageEventStream();
		startedPrompts.add(text);
		const release = new Promise<void>((resolve) => {
			releases.push(resolve);
		});
		void release.then(() => {
			stream.push({ type: "done", reason: "stop", message: assistantMessageLike(`child answer: ${text}`) });
		});
		return stream;
	};
	return {
		releases,
		startedPrompts,
		streamFn,
		releaseAll: () =>
			releases.forEach((release) => {
				release();
			}),
	};
}

function assistantMessageLike(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("rlm.collect typed fan-in", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-rlm-collect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function makeSession(
		streamFn: StreamFn = (_model, context) => streamAnswer(`child answer: ${userText(context)}`),
		options: {
			agentMessageController?: AgentSessionMessageController;
			subagentRuntimeHost?: SubagentRuntimeHost;
			rlmSessionDir?: string;
		} = {},
	): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn,
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
			agentMessageController: options.agentMessageController,
			subagentRuntimeHost: options.subagentRuntimeHost,
			rlmSessionDir: options.rlmSessionDir,
		});
	}

	it("returns a typed envelope once the child settles", async () => {
		session = makeSession();
		const handle = await session.runRlmChild("compute the answer", { name: "worker-a" });

		const results = await session.collectRlmChildren([handle.rlm_child_id], 10_000);
		expect(results.results).toHaveLength(1);
		const entry = results.results[0];
		expect(entry.rlm_child_id).toBe(handle.rlm_child_id);
		expect(entry.session_name).toBe("worker-a");
		expect(entry.status).toBe("done");
		expect(entry.settled).toBe(true);
		expect(entry.answer_preview).toContain("child answer");
		expect(entry.error).toBeUndefined();
	});

	it("collects every direct child when no targets are given", async () => {
		session = makeSession();
		const first = await session.runRlmChild("first task", { name: "worker-a" });
		const second = await session.runRlmChild("second task", { name: "worker-b" });

		const results = await session.collectRlmChildren([], 10_000);
		const ids = results.results.map((entry) => entry.rlm_child_id).sort();
		expect(ids).toEqual([first.rlm_child_id, second.rlm_child_id].sort());
		expect(results.results.every((entry) => entry.settled && entry.status === "done")).toBe(true);
	});

	it("re-collects a settled child after terminal cleanup", async () => {
		session = makeSession();
		const handle = await session.runRlmChild("compute the answer", { name: "worker-a" });
		// Wait for settlement: the terminal path removes the settled run from
		// _activeRlmChildRuns while its envelope stays retained until deleted.
		const settled = await session.collectRlmChildren([handle.rlm_child_id], 10_000);
		expect(settled.results[0]?.settled).toBe(true);

		const byId = await session.collectRlmChildren([handle.rlm_child_id], 0);
		expect(byId.results).toHaveLength(1);
		expect(byId.results[0]?.rlm_child_id).toBe(handle.rlm_child_id);
		expect(byId.results[0]?.status).toBe("done");
		expect(byId.results[0]?.settled).toBe(true);
		expect(byId.results[0]?.answer_preview).toContain("child answer");

		const byName = await session.collectRlmChildren(["worker-a"], 0);
		expect(byName.results[0]?.rlm_child_id).toBe(handle.rlm_child_id);

		const all = await session.collectRlmChildren([], 0);
		expect(all.results.map((entry) => entry.rlm_child_id)).toContain(handle.rlm_child_id);
	});

	it("returns only the selected child from a targeted collect", async () => {
		session = makeSession();
		const first = await session.runRlmChild("first task", { name: "worker-a" });
		const second = await session.runRlmChild("second task", { name: "worker-b" });
		await session.collectRlmChildren([], 10_000);

		const targeted = await session.collectRlmChildren([first.rlm_child_id], 0);
		expect(targeted.results.map((entry) => entry.rlm_child_id)).toEqual([first.rlm_child_id]);
		const byName = await session.collectRlmChildren(["worker-b"], 0);
		expect(byName.results.map((entry) => entry.rlm_child_id)).toEqual([second.rlm_child_id]);
	});

	it("returns current snapshots on timeout without rejecting", async () => {
		session = makeSession();
		const handle = await session.runRlmChild("slow task", { name: "worker-a" });
		// The child runs to completion quickly in this stub; a zero timeout is
		// the guaranteed non-blocking read used for polling.
		const snapshot = await session.collectRlmChildren([handle.rlm_child_id], 0);
		expect(snapshot.results).toHaveLength(1);
		expect(snapshot.results[0].rlm_child_id).toBe(handle.rlm_child_id);
		expect(["queued", "running", "done"]).toContain(snapshot.results[0].status);
	});

	it("returns cancelled envelopes for just-deleted targets without throwing", async () => {
		const gate = createGatedStream();
		session = makeSession(gate.streamFn);
		const victim = await session.runRlmChild("victim shard", { name: "victim-worker" });
		await waitForCondition(() => gate.startedPrompts.has("victim shard"), 10_000);

		await session.deleteRlmSubagent(victim.rlm_child_id);

		// The delete receipt returned while the aborted run still unwinds;
		// collect answers with a terminal cancelled envelope instead of the
		// unknown-selector error, and it does not spend the timeout budget.
		const collectStartedAt = Date.now();
		const byId = await session.collectRlmChildren([victim.rlm_child_id], 10_000);
		expect(Date.now() - collectStartedAt).toBeLessThan(2_000);
		expect(byId.results).toHaveLength(1);
		expect(byId.results[0]).toMatchObject({
			rlm_child_id: victim.rlm_child_id,
			session_name: "victim-worker",
			status: "cancelled",
			settled: true,
			error: "Deleted by parent orchestrator",
		});

		const byName = await session.collectRlmChildren(["victim-worker"], 0);
		expect(byName.results).toHaveLength(1);
		expect(byName.results[0]).toMatchObject({
			rlm_child_id: victim.rlm_child_id,
			status: "cancelled",
			settled: true,
		});

		// Unknown selectors keep throwing; the cancelled fallback is scoped to deleted targets.
		await expect(session.collectRlmChildren(["no-such-child"], 0)).rejects.toThrow(
			'No direct RLM child matches "no-such-child"',
		);

		gate.releaseAll();
		await waitForCondition(() => session!.getRlmChildRunStatus(victim.rlm_child_id) === undefined, 10_000);
	});

	it("collects live and deleted targets together", async () => {
		const gate = createGatedStream();
		session = makeSession(gate.streamFn);
		const live = await session.runRlmChild("live shard", { name: "live-worker" });
		const victim = await session.runRlmChild("victim shard", { name: "victim-worker" });
		await waitForCondition(
			() => gate.startedPrompts.has("live shard") && gate.startedPrompts.has("victim shard"),
			10_000,
		);
		await session.deleteRlmSubagent("victim-worker");

		const results = await session.collectRlmChildren([live.rlm_child_id, victim.rlm_child_id], 0);
		const byId = new Map(results.results.map((entry) => [entry.rlm_child_id, entry]));
		expect(byId.get(live.rlm_child_id)).toMatchObject({ session_name: "live-worker", status: "running" });
		expect(byId.get(victim.rlm_child_id)).toMatchObject({
			status: "cancelled",
			settled: true,
			error: "Deleted by parent orchestrator",
		});

		gate.releaseAll();
		await waitForCondition(
			() =>
				session!.getRlmChildRunStatus(victim.rlm_child_id) === undefined &&
				session!.getRlmChildRunStatus(live.rlm_child_id) === undefined,
			10_000,
		);
	});

	it("throws ambiguity when a deleted selector matches several detached runs", async () => {
		const gate = createGatedStream();
		session = makeSession(gate.streamFn);
		const first = await session.runRlmChild("first shard", { name: "reused-worker" });
		await waitForCondition(() => gate.startedPrompts.has("first shard"), 10_000);

		// A delete receipt frees the name, so a reused selector can race two
		// accepted deletes whose detached unwinds are still pending. The second
		// mid-unwind record is injected exactly like the sibling-recursion
		// fixtures do: real concurrent deleted runs cannot be spawned twice in
		// one tick, and collect must still refuse the ambiguous selector.
		const internals = session as unknown as {
			_activeRlmChildRuns: Map<string, Record<string, unknown>>;
		};
		const injectedDetachedRun = {
			id: "injected-deleted-run",
			prompt: "hidden parent",
			sessionName: "reused-worker",
			sessionDir: join(tempDir, "injected-deleted-run"),
			model,
			abort: () => {},
			status: "cancelled",
			settled: false,
			progressNotes: [],
			detachedDeletion: {
				rlm_child_id: "injected-deleted-run",
				active_session_id: null,
				session_id: null,
				session_name: "reused-worker",
				session_dir: join(tempDir, "injected-deleted-run"),
				status: "running",
			},
		};
		internals._activeRlmChildRuns.set("injected-deleted-run", injectedDetachedRun);

		await session.deleteRlmSubagent(first.rlm_child_id);
		// Both deleted runs match the reused name; a single selector cannot
		// resolve to several envelopes, exactly like the live branch.
		await expect(session.collectRlmChildren(["reused-worker"], 0)).rejects.toThrow(
			'RLM child selector "reused-worker" is ambiguous in the current parent session',
		);

		// Each deleted run stays individually addressable by id.
		const byId = await session.collectRlmChildren([first.rlm_child_id, "injected-deleted-run"], 0);
		expect(byId.results).toHaveLength(2);
		expect(byId.results.every((entry) => entry.status === "cancelled" && entry.settled)).toBe(true);

		// These are deliberately minimal lifecycle records; remove the injected
		// run before fixture teardown asks real runs to settle.
		internals._activeRlmChildRuns.delete("injected-deleted-run");
		gate.releaseAll();
		await waitForCondition(() => session!.getRlmChildRunStatus(first.rlm_child_id) === undefined, 10_000);
	});

	it("does not report a settled cancellation while a delete preflight can still fail", async () => {
		const gate = createGatedStream();
		let holdListing = false;
		let releaseListing!: () => void;
		const listingGate = new Promise<void>((resolve) => {
			releaseListing = resolve;
		});
		session = makeSession(gate.streamFn, {
			agentMessageController: {
				listAgents: async () => {
					if (!holdListing) {
						return {
							current: { activeSessionId: "parent-active", sessionId: "parent-session" },
							agents: [],
						};
					}
					await listingGate;
					return {
						current: { activeSessionId: "parent-active", sessionId: "parent-session" },
						agents: [
							{
								activeSessionId: "passive-active",
								sessionId: "passive-session",
								sessionName: "victim-worker",
								runtimeKind: "subagent" as const,
								cwd: tempDir,
								isStreaming: false,
								unfinishedActionCount: 0,
								parentActiveSessionId: "parent-active",
								rlmChildId: "passive-child",
								sessionDir: join(tempDir, "passive-child"),
							},
						],
					};
				},
				sendAgentMessage: async () => {
					throw new Error("unexpected send");
				},
			},
		});
		const victim = await session.runRlmChild("victim shard", { name: "victim-worker" });
		await waitForCondition(() => gate.startedPrompts.has("victim shard"), 10_000);

		// The delete reserves the run synchronously, then blocks on the daemon
		// listing preflight that will find a conflicting passive selector.
		holdListing = true;
		const deleting = session.deleteRlmSubagent("victim-worker");
		// Mid-preflight the delete can still fail, so collect must not answer
		// with a settled cancelled envelope; the reserved run is simply hidden.
		await expect(session.collectRlmChildren(["victim-worker"], 0)).rejects.toThrow(
			'No direct RLM child matches "victim-worker" in the current parent session',
		);

		releaseListing();
		await expect(deleting).rejects.toThrow(
			'RLM subagent selector "victim-worker" is ambiguous in the current parent session',
		);

		// The failed delete cleared the reservation: the child is live and
		// collectable again, not silently cancelled.
		const live = await session.collectRlmChildren(["victim-worker"], 0);
		expect(live.results).toHaveLength(1);
		expect(live.results[0]).toMatchObject({
			rlm_child_id: victim.rlm_child_id,
			status: "running",
			settled: false,
		});

		gate.releaseAll();
		await session.collectRlmChildren([victim.rlm_child_id], 10_000);
	});

	it("keeps a reused selector off the previous generation's cancelled envelope during delete preflight", async () => {
		const gate = createGatedStream();
		// The first generation's cleanup stays open, so its accepted delete remains
		// the stale envelope a reused selector could resolve to by mistake.
		let releaseCleanup: () => void = () => {};
		const cleanupGate = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		let holdListing = false;
		let releaseListing!: () => void;
		const listingGate = new Promise<void>((resolve) => {
			releaseListing = resolve;
		});
		const hostedChildren: AgentSession[] = [];
		const makeHostedChild = (): AgentSession => {
			const root = session;
			const child = makeSession(gate.streamFn);
			// Hosted children are torn down by this test, so the suite teardown keeps
			// targeting the parent it owns.
			session = root;
			hostedChildren.push(child);
			return child;
		};
		const root = makeSession(gate.streamFn, {
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: makeHostedChild() }),
				deleteRlmSubagentRuntime: async () => {
					await cleanupGate;
				},
			},
			agentMessageController: {
				listAgents: async () => {
					if (!holdListing) {
						return {
							current: { activeSessionId: "parent-active", sessionId: "parent-session" },
							agents: [],
						};
					}
					await listingGate;
					return {
						current: { activeSessionId: "parent-active", sessionId: "parent-session" },
						agents: [
							{
								activeSessionId: "passive-active",
								sessionId: "passive-session",
								sessionName: "reused-worker",
								runtimeKind: "subagent" as const,
								cwd: tempDir,
								isStreaming: false,
								unfinishedActionCount: 0,
								parentActiveSessionId: "parent-active",
								rlmChildId: "passive-child",
								sessionDir: join(tempDir, "passive-child"),
							},
						],
					};
				},
				sendAgentMessage: async () => {
					throw new Error("unexpected send");
				},
			},
		});

		const first = await root.runRlmChild("first shard", { name: "reused-worker" });
		await waitForCondition(() => gate.startedPrompts.has("first shard"), 10_000);
		// The delete receipt frees the name while the first generation still unwinds.
		await root.deleteRlmSubagent(first.rlm_child_id);
		const replacement = await root.runRlmChild("replacement shard", { name: "reused-worker" });
		expect(replacement.rlm_child_id).not.toBe(first.rlm_child_id);
		await waitForCondition(() => gate.startedPrompts.has("replacement shard"), 10_000);

		// The replacement is reserved but still inside its delete preflight, which can
		// fail and leave the replacement running. The previous generation's accepted
		// delete matches the same reused name, so the deleted fallback must not answer
		// the selector with that stale cancelled envelope.
		holdListing = true;
		const deleting = root.deleteRlmSubagent(replacement.rlm_child_id);
		await expect(root.collectRlmChildren(["reused-worker"], 0)).rejects.toThrow(
			'No direct RLM child matches "reused-worker" in the current parent session',
		);
		// Addressing the reserved generation by id is the same no-match answer.
		await expect(root.collectRlmChildren([replacement.rlm_child_id], 0)).rejects.toThrow(
			'No direct RLM child matches "',
		);

		releaseListing();
		await expect(deleting).resolves.toMatchObject({
			subagent: { rlm_child_id: replacement.rlm_child_id },
		});
		// Once the receipt returns, both generations are accepted deletes under the
		// same reused name, so the selector is ambiguous rather than silently one
		// generation. Each generation stays addressable through its own envelope.
		await expect(root.collectRlmChildren(["reused-worker"], 0)).rejects.toThrow(
			'RLM child selector "reused-worker" is ambiguous in the current parent session',
		);
		const deletedReplacement = await root.collectRlmChildren([replacement.rlm_child_id], 0);
		expect(deletedReplacement.results).toHaveLength(1);
		expect(deletedReplacement.results[0]).toMatchObject({
			rlm_child_id: replacement.rlm_child_id,
			session_name: "reused-worker",
			status: "cancelled",
			settled: true,
			error: "Deleted by parent orchestrator",
		});
		const deletedFirst = await root.collectRlmChildren([first.rlm_child_id], 0);
		expect(deletedFirst.results).toHaveLength(1);
		expect(deletedFirst.results[0]).toMatchObject({
			rlm_child_id: first.rlm_child_id,
			status: "cancelled",
			settled: true,
		});

		// Both generations unwind once their cleanup and their gated shards are
		// released; every wait is bounded.
		releaseCleanup();
		await waitForRlmRunCleanup(gate, root, [first.rlm_child_id, replacement.rlm_child_id]);
		expect(root.getRlmChildRunStatus(first.rlm_child_id)).toBeUndefined();
		expect(root.getRlmChildRunStatus(replacement.rlm_child_id)).toBeUndefined();
		for (const hosted of hostedChildren) hosted.dispose();
	});

	it("keeps a deleted child's cancelled envelope after its unwind settles", async () => {
		const gate = createGatedStream();
		session = makeSession(gate.streamFn);
		const victim = await session.runRlmChild("victim shard", { name: "victim-worker" });
		await waitForCondition(() => gate.startedPrompts.has("victim shard"), 10_000);
		await session.deleteRlmSubagent(victim.rlm_child_id);

		// Mid-unwind the run is still in the lookup maps, so collect reads it there.
		const midUnwind = await session.collectRlmChildren([victim.rlm_child_id], 0);
		expect(midUnwind.results[0]).toMatchObject({ status: "cancelled", settled: true });

		// Once the unwind settles the run leaves both maps. The delete receipt still
		// promises a cancelled envelope, so collect must answer from the tombstone.
		await waitForRlmRunCleanup(gate, session, [victim.rlm_child_id]);
		expect(session.getRlmChildRunStatus(victim.rlm_child_id)).toBeUndefined();
		const byId = await session.collectRlmChildren([victim.rlm_child_id], 0);
		expect(byId.results).toHaveLength(1);
		expect(byId.results[0]).toMatchObject({
			rlm_child_id: victim.rlm_child_id,
			session_name: "victim-worker",
			status: "cancelled",
			settled: true,
			error: "Deleted by parent orchestrator",
		});
		const byName = await session.collectRlmChildren(["victim-worker"], 0);
		expect(byName.results).toHaveLength(1);
		expect(byName.results[0]).toMatchObject({
			rlm_child_id: victim.rlm_child_id,
			status: "cancelled",
			settled: true,
		});

		// The settled fan-out list still excludes deleted children.
		expect((await session.collectRlmChildren([], 0)).results).toEqual([]);
	});

	it("keeps a tombstoned generation off a reused name that is mid-delete-preflight", async () => {
		const gate = createGatedStream();
		let holdListing = false;
		let releaseListing!: () => void;
		const listingGate = new Promise<void>((resolve) => {
			releaseListing = resolve;
		});
		session = makeSession(gate.streamFn, {
			agentMessageController: {
				listAgents: async () => {
					if (!holdListing) {
						return {
							current: { activeSessionId: "parent-active", sessionId: "parent-session" },
							agents: [],
						};
					}
					await listingGate;
					return {
						current: { activeSessionId: "parent-active", sessionId: "parent-session" },
						agents: [
							{
								activeSessionId: "passive-active",
								sessionId: "passive-session",
								sessionName: "reused-worker",
								runtimeKind: "subagent" as const,
								cwd: tempDir,
								isStreaming: false,
								unfinishedActionCount: 0,
								parentActiveSessionId: "parent-active",
								rlmChildId: "passive-child",
								sessionDir: join(tempDir, "passive-child"),
							},
						],
					};
				},
				sendAgentMessage: async () => {
					throw new Error("unexpected send");
				},
			},
		});

		const first = await session.runRlmChild("first shard", { name: "reused-worker" });
		await waitForCondition(() => gate.startedPrompts.has("first shard"), 10_000);
		await session.deleteRlmSubagent(first.rlm_child_id);
		await waitForRlmRunCleanup(gate, session, [first.rlm_child_id]);
		// The unwound generation survives only as a collectable tombstone.
		const tombstone = await session.collectRlmChildren([first.rlm_child_id], 0);
		expect(tombstone.results[0]).toMatchObject({
			rlm_child_id: first.rlm_child_id,
			status: "cancelled",
			settled: true,
		});

		const replacement = await session.runRlmChild("replacement shard", { name: "reused-worker" });
		expect(replacement.rlm_child_id).not.toBe(first.rlm_child_id);
		await waitForCondition(() => gate.startedPrompts.has("replacement shard"), 10_000);

		// The replacement is reserved but still inside its delete preflight, so that
		// delete can still fail and leave a live run under the reused name. The
		// selector must report no match instead of the tombstoned generation.
		holdListing = true;
		const deleting = session.deleteRlmSubagent(replacement.rlm_child_id);
		await expect(session.collectRlmChildren(["reused-worker"], 0)).rejects.toThrow(
			'No direct RLM child matches "reused-worker" in the current parent session',
		);

		releaseListing();
		await expect(deleting).resolves.toMatchObject({
			subagent: { rlm_child_id: replacement.rlm_child_id },
		});
		// Right after the receipt the reused name matches the tombstoned generation
		// and the just-deleted replacement, so it is ambiguous rather than either
		// generation; each stays addressable by id.
		await expect(session.collectRlmChildren(["reused-worker"], 0)).rejects.toThrow(
			'RLM child selector "reused-worker" is ambiguous in the current parent session',
		);
		const replacementEnvelope = await session.collectRlmChildren([replacement.rlm_child_id], 0);
		expect(replacementEnvelope.results[0]).toMatchObject({
			rlm_child_id: replacement.rlm_child_id,
			status: "cancelled",
			settled: true,
		});

		await waitForRlmRunCleanup(gate, session, [replacement.rlm_child_id]);
		expect(session.getRlmChildRunStatus(replacement.rlm_child_id)).toBeUndefined();
	});

	it("keeps each fully unwound deleted generation addressable under a reused name", async () => {
		const gate = createGatedStream();
		session = makeSession(gate.streamFn);

		const first = await session.runRlmChild("first shard", { name: "reused-worker" });
		await waitForCondition(() => gate.startedPrompts.has("first shard"), 10_000);
		await session.deleteRlmSubagent("reused-worker");
		await waitForRlmRunCleanup(gate, session, [first.rlm_child_id]);

		const second = await session.runRlmChild("second shard", { name: "reused-worker" });
		expect(second.rlm_child_id).not.toBe(first.rlm_child_id);
		await waitForCondition(() => gate.startedPrompts.has("second shard"), 10_000);
		await session.deleteRlmSubagent("reused-worker");
		await waitForRlmRunCleanup(gate, session, [second.rlm_child_id]);

		// Both generations are unwound tombstones under one reused name, so the name
		// is ambiguous exactly like two detached runs racing the same selector.
		await expect(session.collectRlmChildren(["reused-worker"], 0)).rejects.toThrow(
			'RLM child selector "reused-worker" is ambiguous in the current parent session',
		);
		const firstEnvelope = await session.collectRlmChildren([first.rlm_child_id], 0);
		expect(firstEnvelope.results).toHaveLength(1);
		expect(firstEnvelope.results[0]).toMatchObject({
			rlm_child_id: first.rlm_child_id,
			session_name: "reused-worker",
			status: "cancelled",
			settled: true,
			error: "Deleted by parent orchestrator",
		});
		const secondEnvelope = await session.collectRlmChildren([second.rlm_child_id], 0);
		expect(secondEnvelope.results).toHaveLength(1);
		expect(secondEnvelope.results[0]).toMatchObject({
			rlm_child_id: second.rlm_child_id,
			session_name: "reused-worker",
			status: "cancelled",
			settled: true,
			error: "Deleted by parent orchestrator",
		});
	});

	it("keeps a retained completed child's cancelled envelope after its delete receipt", async () => {
		session = makeSession();
		const done = await session.runRlmChild("done shard", { name: "done-worker" });
		// Terminal cleanup moves the settled run out of the active map and keeps the
		// child retained, so the delete takes the no-active-run path.
		await waitForCondition(() => session!.getRlmChildRunStatus(done.rlm_child_id) === undefined, 10_000);
		const settled = await session.collectRlmChildren([done.rlm_child_id], 10_000);
		expect(settled.results[0]).toMatchObject({ status: "done", settled: true });

		await expect(session.deleteRlmSubagent(done.rlm_child_id)).resolves.toMatchObject({
			subagent: { rlm_child_id: done.rlm_child_id },
		});

		// The receipt promises a cancelled envelope even though the run is gone.
		const byId = await session.collectRlmChildren([done.rlm_child_id], 0);
		expect(byId.results).toHaveLength(1);
		expect(byId.results[0]).toMatchObject({
			rlm_child_id: done.rlm_child_id,
			session_name: "done-worker",
			status: "cancelled",
			settled: true,
			error: "Deleted by parent orchestrator",
		});
		const byName = await session.collectRlmChildren(["done-worker"], 0);
		expect(byName.results).toHaveLength(1);
		expect(byName.results[0]).toMatchObject({
			rlm_child_id: done.rlm_child_id,
			status: "cancelled",
			settled: true,
		});
	});

	it("keeps a run-less retained child's cancelled envelope after its delete receipt", async () => {
		const root = makeSession();
		// The daemon registers hydrated passive children without a run, so the
		// tombstone has to carry the registry identity instead.
		const retainedChild = makeSession(undefined, {
			rlmSessionDir: join(tempDir, "runless-retained"),
		});
		session = root;
		retainedChild.setSessionName("runless-worker");
		expect(root.registerRlmChildSession("runless-child", retainedChild)).toBe(true);

		await expect(root.deleteRlmSubagent("runless-worker")).resolves.toMatchObject({
			subagent: { rlm_child_id: "runless-child" },
		});

		const byId = await root.collectRlmChildren(["runless-child"], 0);
		expect(byId.results).toHaveLength(1);
		expect(byId.results[0]).toMatchObject({
			rlm_child_id: "runless-child",
			session_name: "runless-worker",
			status: "cancelled",
			settled: true,
			error: "Deleted by parent orchestrator",
		});
		const byName = await root.collectRlmChildren(["runless-worker"], 0);
		expect(byName.results[0]).toMatchObject({
			rlm_child_id: "runless-child",
			status: "cancelled",
			settled: true,
		});
		// Registry identity keeps session-id selectors working without a session object.
		const bySessionId = await root.collectRlmChildren([retainedChild.sessionId], 0);
		expect(bySessionId.results[0]).toMatchObject({
			rlm_child_id: "runless-child",
			status: "cancelled",
			settled: true,
		});
	});

	it("keeps a run-less delete reservation off the previous generation's cancelled envelope", async () => {
		const gate = createGatedStream();
		let holdListing = false;
		let releaseListing!: () => void;
		const listingGate = new Promise<void>((resolve) => {
			releaseListing = resolve;
		});
		const root = makeSession(gate.streamFn, {
			agentMessageController: {
				listAgents: async () => {
					if (!holdListing) {
						return {
							current: { activeSessionId: "parent-active", sessionId: "parent-session" },
							agents: [],
						};
					}
					await listingGate;
					return {
						current: { activeSessionId: "parent-active", sessionId: "parent-session" },
						agents: [],
					};
				},
				sendAgentMessage: async () => {
					throw new Error("unexpected send");
				},
			},
		});
		session = root;

		const first = await root.runRlmChild("first shard", { name: "reused-worker" });
		await waitForCondition(() => gate.startedPrompts.has("first shard"), 10_000);
		await root.deleteRlmSubagent(first.rlm_child_id);
		await waitForRlmRunCleanup(gate, root, [first.rlm_child_id]);
		// The unwound generation is only a tombstone now, still matching the name.
		expect((await root.collectRlmChildren([first.rlm_child_id], 0)).results[0]).toMatchObject({
			rlm_child_id: first.rlm_child_id,
			status: "cancelled",
			settled: true,
		});

		// A run-less retained child reuses that name: candidates never see it, so its
		// reservation is the only mid-preflight signal.
		const retainedChild = makeSession(undefined, {
			rlmSessionDir: join(tempDir, "runless-pending"),
		});
		session = root;
		retainedChild.setSessionName("reused-worker");
		expect(root.registerRlmChildSession("runless-pending", retainedChild)).toBe(true);

		holdListing = true;
		const deleting = root.deleteRlmSubagent("reused-worker");
		// The run-less delete is undecided, so the reused selector must report no match
		// instead of the previous generation's tombstoned envelope.
		await expect(root.collectRlmChildren(["reused-worker"], 0)).rejects.toThrow(
			'No direct RLM child matches "reused-worker" in the current parent session',
		);

		releaseListing();
		await expect(deleting).resolves.toMatchObject({
			subagent: { rlm_child_id: "runless-pending" },
		});
		// Both generations are deleted under the reused name, so the name is ambiguous
		// while the run-less child keeps its own envelope by id.
		await expect(root.collectRlmChildren(["reused-worker"], 0)).rejects.toThrow(
			'RLM child selector "reused-worker" is ambiguous in the current parent session',
		);
		const runlessEnvelope = await root.collectRlmChildren(["runless-pending"], 0);
		expect(runlessEnvelope.results).toHaveLength(1);
		expect(runlessEnvelope.results[0]).toMatchObject({
			rlm_child_id: "runless-pending",
			session_name: "reused-worker",
			status: "cancelled",
			settled: true,
			error: "Deleted by parent orchestrator",
		});
	});

	it("throws for unknown selectors and keeps ambiguity detection", async () => {
		session = makeSession();
		await expect(session.collectRlmChildren(["no-such-child"], 0)).rejects.toThrow(
			'No direct RLM child matches "no-such-child"',
		);
	});

	it("validates host payload shape", async () => {
		const handler = createRlmCollectHostHandler(async () => ({ results: [] }));
		await expect(handler({ targets: "worker-a" })).rejects.toThrow("targets must be an array");
		await expect(handler({ targets: [""] })).rejects.toThrow("non-empty strings");
		await expect(handler({ timeout_ms: -1 })).rejects.toThrow("non-negative integer");
		await expect(handler({ timeout_ms: "soon" })).rejects.toThrow("non-negative integer");
		// Node clamps setTimeout delays above 2^31-1 to 1ms, so an oversized
		// timeout must be rejected instead of returning an immediate snapshot.
		await expect(handler({ timeout_ms: 2_147_483_648 })).rejects.toThrow("2147483647");
		const ok = await handler({ targets: ["worker-a"], timeout_ms: 5 });
		expect(ok).toEqual({ results: [] });
		const defaults = await handler({});
		expect(defaults).toEqual({ results: [] });
	});
});
