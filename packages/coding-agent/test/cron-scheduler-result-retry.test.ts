import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type AgentCronJob, AgentCronJobStore, AgentCronScheduler } from "../src/core/cron-jobs.js";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("retries only the completed dispatch result and permits the next heartbeat interval", async () => {
	const dir = mkdtempSync(join(tmpdir(), "prime-cron-result-retry-"));
	dirs.push(dir);
	const store = new AgentCronJobStore(join(dir, "jobs.json"));
	const start = new Date("2026-01-01T00:00:00Z");
	const job = await store.createHeartbeat({
		activeSessionId: "active",
		sessionId: "session",
		sessionFile: join(dir, "session.jsonl"),
		cwd: dir,
		scheduleText: "every 10s",
		prompt: "synthetic",
		now: start,
	});
	let now = new Date("2026-01-01T00:00:10Z");
	const lockError = Object.assign(new Error("Lock file is already being held"), {
		code: "ELOCKED",
		file: join(dir, "jobs.json"),
	});
	vi.spyOn(store, "recordDispatchResult").mockRejectedValueOnce(lockError);
	const runJob = vi.fn(async () => undefined);
	const scheduler = new AgentCronScheduler(store, { now: () => now, runJob });
	try {
		await expect(scheduler.runDue()).rejects.toBe(lockError);
		expect(runJob).toHaveBeenCalledOnce();
		expect(store.getClaimedJob(job.id)).toBeDefined();
		now = new Date("2026-01-01T00:00:11Z");
		await scheduler.runDue();
		expect(runJob).toHaveBeenCalledOnce();
		expect(store.getClaimedJob(job.id)).toBeUndefined();
		expect(store.list().find((row) => row.id === job.id)?.runCount).toBe(1);
		now = new Date("2026-01-01T00:00:20Z");
		expect(await scheduler.runDue()).toBe(1);
		expect(runJob).toHaveBeenCalledTimes(2);
		expect(store.list().find((row) => row.id === job.id)?.runCount).toBe(2);
	} finally {
		scheduler.stop();
	}
});

it("result retry leaves another still-running dispatch claimed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "prime-cron-targeted-retry-"));
	dirs.push(dir);
	const store = new AgentCronJobStore(join(dir, "jobs.json"));
	const start = new Date("2026-01-01T00:00:00Z");
	const jobs: AgentCronJob[] = [];
	for (const label of ["fast", "slow"])
		jobs.push(
			await store.createHeartbeat({
				activeSessionId: label,
				sessionId: label,
				sessionFile: join(dir, `${label}.jsonl`),
				cwd: dir,
				scheduleText: "every 10s",
				prompt: label,
				now: start,
			}),
		);
	let finishSlow!: () => void;
	const slowWait = new Promise<void>((resolve) => {
		finishSlow = resolve;
	});
	const originalRecord = store.recordDispatchResult.bind(store);
	let markSlowRecorded!: () => void;
	const slowRecorded = new Promise<void>((resolve) => {
		markSlowRecorded = resolve;
	});
	let injected = false;
	vi.spyOn(store, "recordDispatchResult").mockImplementation(async (...args) => {
		if (!injected) {
			injected = true;
			throw Object.assign(new Error("synthetic lock busy"), { code: "ELOCKED" });
		}
		const recorded = await originalRecord(...args);
		if (recorded?.id === jobs[1].id) markSlowRecorded();
		return recorded;
	});
	let now = new Date("2026-01-01T00:00:10Z");
	const runJob = vi.fn(async (job) => {
		if (job.activeSessionId === "slow") await slowWait;
		return undefined;
	});
	const scheduler = new AgentCronScheduler(store, { now: () => now, runJob });
	try {
		await expect(scheduler.runDue()).rejects.toThrow("synthetic lock busy");
		expect(runJob).toHaveBeenCalledTimes(2);
		now = new Date("2026-01-01T00:00:11Z");
		await scheduler.runDue();
		expect(store.getClaimedJob(jobs[0].id)).toBeUndefined();
		expect(store.getClaimedJob(jobs[1].id)).toBeDefined();
		expect(runJob).toHaveBeenCalledTimes(2);
		finishSlow();
		await slowRecorded;
		expect(store.getClaimedJob(jobs[1].id)).toBeUndefined();
		expect(store.list().map((job) => job.runCount)).toEqual([1, 1]);
	} finally {
		finishSlow();
		scheduler.stop();
	}
});
