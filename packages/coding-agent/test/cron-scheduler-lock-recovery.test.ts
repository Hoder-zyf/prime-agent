import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lock: vi.fn() }));
vi.mock("proper-lockfile", () => ({ lock: mocks.lock }));

import { AgentCronJobStore, AgentCronScheduler } from "../src/core/cron-jobs.js";

const tempDirs: string[] = [];
const schedulers: AgentCronScheduler[] = [];
const locked = () =>
	Object.assign(new Error("Lock file is already being held"), {
		code: "ELOCKED",
		file: "/synthetic/root/scheduled-jobs.json",
	});

function fakeStore() {
	const dir = mkdtempSync(join(tmpdir(), "prime-cron-timer-fix-"));
	tempDirs.push(dir);
	const store = new AgentCronJobStore(join(dir, "jobs.json"));
	vi.spyOn(store, "recoverInterruptedDispatches").mockResolvedValue([]);
	vi.spyOn(store, "claimDue").mockResolvedValue([]);
	vi.spyOn(store, "nextActiveRunAt").mockReturnValue(undefined);
	return store;
}

beforeEach(() => {
	mocks.lock.mockReset();
	mocks.lock.mockResolvedValue(async () => {});
});
afterEach(() => {
	for (const scheduler of schedulers.splice(0)) scheduler.stop();
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cron scheduler timer failures are isolated from the worker", () => {
	it("reports ELOCKED and retries startup recovery even with no active jobs", async () => {
		vi.useFakeTimers();
		const store = fakeStore();
		const error = locked();
		vi.mocked(store.recoverInterruptedDispatches).mockRejectedValueOnce(error);
		const onSchedulerError = vi.fn();
		const runJob = vi.fn(async () => undefined);
		const scheduler = new AgentCronScheduler(store, { runJob, onSchedulerError });
		schedulers.push(scheduler);
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(onSchedulerError).toHaveBeenCalledWith(error);
		expect(store.claimDue).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(999);
		expect(store.recoverInterruptedDispatches).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(store.recoverInterruptedDispatches).toHaveBeenCalledTimes(2);
		expect(store.claimDue).toHaveBeenCalledOnce();
		expect(runJob).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("backs off claim failures instead of spinning on a due job and stop cancels retries", async () => {
		vi.useFakeTimers();
		const store = fakeStore();
		vi.mocked(store.claimDue).mockRejectedValue(locked());
		vi.mocked(store.nextActiveRunAt).mockReturnValue(new Date(0));
		const onSchedulerError = vi.fn();
		const scheduler = new AgentCronScheduler(store, { runJob: async () => undefined, onSchedulerError });
		schedulers.push(scheduler);
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.claimDue).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(999);
		expect(store.claimDue).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(store.claimDue).toHaveBeenCalledTimes(2);
		expect(onSchedulerError).toHaveBeenCalledTimes(2);
		scheduler.stop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(store.claimDue).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not re-arm after an in-flight failure completes following stop", async () => {
		vi.useFakeTimers();
		const store = fakeStore();
		let rejectClaim!: (reason: unknown) => void;
		vi.mocked(store.claimDue).mockImplementation(
			() =>
				new Promise((_, reject) => {
					rejectClaim = reject;
				}),
		);
		const scheduler = new AgentCronScheduler(store, { runJob: async () => undefined, onSchedulerError: vi.fn() });
		schedulers.push(scheduler);
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		scheduler.stop();
		rejectClaim(locked());
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("isolates errors thrown by the scheduler error-report hook", async () => {
		vi.useFakeTimers();
		const store = fakeStore();
		vi.mocked(store.claimDue).mockRejectedValueOnce(locked());
		const onSchedulerError = vi.fn(() => {
			throw new Error("reporter failure");
		});
		const scheduler = new AgentCronScheduler(store, { runJob: async () => undefined, onSchedulerError });
		schedulers.push(scheduler);
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(onSchedulerError).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1000);
		expect(store.claimDue).toHaveBeenCalledTimes(2);
	});

	it("keeps wake inside exponential backoff, caps delay, and resets it after success", async () => {
		vi.useFakeTimers();
		const store = fakeStore();
		vi.mocked(store.claimDue).mockRejectedValue(locked());
		const onSchedulerError = vi.fn();
		const scheduler = new AgentCronScheduler(store, { runJob: async () => undefined, onSchedulerError });
		schedulers.push(scheduler);
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		let attempts = 1;
		for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
			scheduler.wake();
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(store.claimDue).toHaveBeenCalledTimes(attempts);
			await vi.advanceTimersByTimeAsync(1);
			expect(store.claimDue).toHaveBeenCalledTimes(++attempts);
		}
		vi.mocked(store.claimDue).mockResolvedValueOnce([]);
		await vi.advanceTimersByTimeAsync(30000);
		expect(store.claimDue).toHaveBeenCalledTimes(++attempts);
		scheduler.wake();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.claimDue).toHaveBeenCalledTimes(++attempts);
		await vi.advanceTimersByTimeAsync(999);
		expect(store.claimDue).toHaveBeenCalledTimes(attempts);
		await vi.advanceTimersByTimeAsync(1);
		expect(store.claimDue).toHaveBeenCalledTimes(++attempts);
	});

	it("contains accidentally async diagnostic hook rejections", async () => {
		vi.useFakeTimers();
		const store = fakeStore();
		vi.mocked(store.claimDue).mockRejectedValueOnce(locked());
		const onSchedulerError = vi.fn(async () => {
			throw new Error("async reporter failure");
		});
		const scheduler = new AgentCronScheduler(store, { runJob: async () => undefined, onSchedulerError });
		schedulers.push(scheduler);
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(onSchedulerError).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1000);
		expect(store.claimDue).toHaveBeenCalledTimes(2);
	});

	it("an older successful dispatch cannot erase a newer scheduler failure cooldown", async () => {
		vi.useFakeTimers();
		const store = fakeStore();
		const job = { id: "job-overlap", activeSessionId: "active-overlap" };
		vi.mocked(store.claimDue)
			.mockResolvedValueOnce([{ id: "dispatch-overlap", job }] as never)
			.mockRejectedValueOnce(locked());
		vi.spyOn(store, "getClaimedJob").mockReturnValue(job as never);
		vi.spyOn(store, "recordDispatchResult").mockResolvedValue(undefined);
		let finishJob!: () => void;
		const pending = new Promise<void>((resolve) => {
			finishJob = resolve;
		});
		const onSchedulerError = vi.fn();
		const scheduler = new AgentCronScheduler(store, {
			runJob: async () => {
				await pending;
				return undefined;
			},
			onSchedulerError,
		});
		schedulers.push(scheduler);
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.claimDue).toHaveBeenCalledTimes(1);
		scheduler.wake();
		await vi.advanceTimersByTimeAsync(0);
		expect(onSchedulerError).toHaveBeenCalledOnce();
		expect(store.claimDue).toHaveBeenCalledTimes(2);
		finishJob();
		await vi.advanceTimersByTimeAsync(0);
		scheduler.wake();
		await vi.advanceTimersByTimeAsync(999);
		expect(store.claimDue).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(store.claimDue).toHaveBeenCalledTimes(3);
	});

	it("keeps direct runDue callers able to observe rejection", async () => {
		const store = fakeStore();
		const error = locked();
		vi.mocked(store.claimDue).mockRejectedValueOnce(error);
		const scheduler = new AgentCronScheduler(store, { runJob: async () => undefined });
		schedulers.push(scheduler);
		await expect(scheduler.runDue()).rejects.toBe(error);
	});

	it("also catches persistence failure after a successful job and does not blindly rerun it", async () => {
		vi.useFakeTimers();
		const store = fakeStore();
		const job = { id: "job-1", activeSessionId: "active-1" };
		vi.mocked(store.claimDue).mockResolvedValueOnce([{ id: "dispatch-1", job }] as never);
		vi.spyOn(store, "getClaimedJob").mockReturnValue(job as never);
		vi.spyOn(store, "recordDispatchResult").mockRejectedValueOnce(locked());
		const runJob = vi.fn(async () => undefined);
		const onSchedulerError = vi.fn();
		const scheduler = new AgentCronScheduler(store, { runJob, onSchedulerError });
		schedulers.push(scheduler);
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(runJob).toHaveBeenCalledOnce();
		expect(onSchedulerError).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1000);
		expect(runJob).toHaveBeenCalledOnce();
	});
});

describe("one cron store does not contend with its own mutations", () => {
	it("serializes recovery, no-op rebind and claim on the same artifact", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-cron-store-fix-"));
		tempDirs.push(dir);
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact("root", dir);
		let grant!: (release: () => Promise<void>) => void;
		let entered!: () => void;
		const firstEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		mocks.lock.mockImplementationOnce(() => {
			entered();
			return new Promise((resolve) => {
				grant = resolve;
			});
		});
		const recovery = store.recoverSessionArtifact("root");
		await firstEntered;
		const rebind = store.rebindSessionJobs({
			activeSessionId: "root",
			sessionId: "root",
			sessionFile: join(dir, "session.jsonl"),
			cwd: dir,
		});
		const claim = store.claimDue();
		await Promise.resolve();
		await Promise.resolve();
		expect(mocks.lock).toHaveBeenCalledTimes(1);
		grant(async () => {});
		await expect(Promise.all([recovery, rebind, claim])).resolves.toEqual([[], [], []]);
		expect(mocks.lock).toHaveBeenCalledTimes(3);
	});

	it("a failed mutation does not poison later queued mutations", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-cron-queue-recover-"));
		tempDirs.push(dir);
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact("root", dir);
		mocks.lock.mockRejectedValueOnce(Object.assign(new Error("synthetic I/O error"), { code: "EIO" }));
		const first = store.recoverSessionArtifact("root");
		const second = store.recoverSessionArtifact("root");
		await expect(first).rejects.toThrow("synthetic I/O error");
		await expect(second).resolves.toEqual([]);
		expect(mocks.lock).toHaveBeenCalledTimes(2);
	});
});
