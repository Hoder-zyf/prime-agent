import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { formatSessionsTable } from "../src/cli/sessions-table-format.js";
import type { SessionActivity, SessionLifecycle, SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

const NOW_MS = Date.parse("2026-05-29T12:00:00.000Z");
const HEADER = ["name", "status", "activity", "last heard", "error", "usage"];
const DEFAULT_MODIFIED = "2026-05-29T10:00:00.000Z";

describe("formatSessionsTable", () => {
	it("renders the header only for an empty roster", () => {
		expectTable([], []);
	});

	it("shows a streaming agent as running with a thinking detail", () => {
		expectTable(
			[
				makeSummary({
					id: "stream",
					activeSessionId: "active-stream",
					activity: "working",
					streaming: true,
				}),
			],
			[["stream", "running", "thinking", "2h", "", ""]],
		);
	});

	it("marks agents that are running tools or bash", () => {
		expectTable(
			[
				makeSummary({
					id: "tools",
					activeSessionId: "active-tools",
					activity: "working",
					streaming: true,
					runningTools: true,
				}),
				makeSummary({ id: "bash", activeSessionId: "active-bash", activity: "working", bash: true }),
				makeSummary({
					id: "compact",
					activeSessionId: "active-compact",
					activity: "working",
					compacting: true,
				}),
			],
			[
				["tools", "running", "running tools", "2h", "", ""],
				["bash", "running", "running bash", "2h", "", ""],
				["compact", "running", "compacting", "2h", "", ""],
			],
		);
	});

	it("falls back to the roster status when no exception mark is set", () => {
		expectTable(
			[
				makeSummary({
					id: "idle-agent",
					activeSessionId: "active-idle",
					activity: "idle",
					taskState: "completed",
				}),
				makeSummary({ id: "saved-agent", activity: "idle", rosterStatus: "inactive" }),
			],
			[
				["idle-agent", "idle", "completed", "2h", "", ""],
				["saved-agent", "inactive", "", "2h", "", ""],
			],
		);
	});

	it("shows exceptional status labels instead of the plain roster status", () => {
		expectTable(
			[
				makeSummary({
					id: "queued-agent",
					activeSessionId: "active-queued",
					activity: "working",
					statusLabel: "queued",
				}),
				makeSummary({
					id: "recovering-agent",
					activeSessionId: "active-recovering",
					activity: "idle",
					statusLabel: "recovering",
				}),
				makeSummary({
					id: "failed-agent",
					activeSessionId: "active-failed",
					activity: "idle",
					statusLabel: "failed",
				}),
			],
			[
				["failed-agent", "failed", "", "2h", "worker failed", ""],
				["recovering-agent", "recovering", "", "2h", "", ""],
				["queued-agent", "queued", "classifying", "2h", "", ""],
			],
		);
	});

	it("reports a failed worker state as both activity and last error", () => {
		expectTable(
			[
				makeSummary({
					id: "crashed-agent",
					activeSessionId: "active-crashed",
					activity: "idle",
					workerState: "failed",
				}),
			],
			[["crashed-agent", "idle", "failed", "2h", "worker failed", ""]],
		);
	});

	it("prefers the latest error diagnostic over the worker mark and fallback notice", () => {
		expectTable(
			[
				makeSummary({
					id: "broken-agent",
					activeSessionId: "active-broken",
					activity: "idle",
					workerState: "failed",
					modelFallbackMessage: "No models available",
					diagnostics: [
						{ type: "warning", message: "skill path missing" },
						{ type: "error", message: 'Extension "./ext" error: bad config' },
					],
				}),
			],
			[["broken-agent", "idle", "failed", "2h", 'Extension "./ext" error: bad config', ""]],
		);
	});

	it("falls back to the model notice only when no error diagnostic exists", () => {
		expectTable(
			[
				makeSummary({
					id: "model-agent",
					activeSessionId: "active-model",
					activity: "idle",
					modelFallbackMessage: "Could not restore model anthropic/old-model",
				}),
			],
			[["model-agent", "idle", "", "2h", "Could not restore model anthropic/old-model", ""]],
		);
	});

	it("uses worker staleness when reported and the modified age otherwise", () => {
		expectTable(
			[
				makeSummary({
					id: "stale-agent",
					activeSessionId: "active-stale",
					activity: "working",
					lastHeardFromAt: "2026-05-29T11:50:00.000Z",
					modified: "2026-05-29T10:00:00.000Z",
				}),
				makeSummary({
					id: "fresh-agent",
					activeSessionId: "active-fresh",
					activity: "working",
					streaming: true,
				}),
			],
			[
				["stale-agent", "running", "classifying", "10m", "", ""],
				["fresh-agent", "running", "thinking", "2h", "", ""],
			],
		);
	});

	it("appends the recap to the activity detail and truncates long cells", () => {
		expectTable(
			[
				makeSummary({
					id: "busy-agent",
					activeSessionId: "active-busy",
					activity: "working",
					streaming: true,
					runningTools: true,
					summary: "a".repeat(100),
				}),
			],
			[["busy-agent", "running", `running tools · ${"a".repeat(43)}…`, "2h", "", ""]],
		);
	});

	it("formats usage compactly and leaves the cell empty without usage", () => {
		expectTable(
			[
				makeSummary({
					id: "spending-agent",
					activeSessionId: "active-spending",
					activity: "idle",
					usage: { inputTokens: 1234, outputTokens: 567, cost: 0.4234 },
				}),
				makeSummary({
					id: "fleet-agent",
					activeSessionId: "active-fleet",
					activity: "idle",
					usage: { inputTokens: 1_626_400_000, outputTokens: 2_100_000, cost: 382.85 },
				}),
				makeSummary({ id: "free-agent", activeSessionId: "active-free", activity: "idle" }),
			],
			[
				["spending-agent", "idle", "", "2h", "", "1.2k/567 $0.42"],
				["fleet-agent", "idle", "", "2h", "", "1.6b/2.1m $382.85"],
				["free-agent", "idle", "", "2h", "", ""],
			],
		);
	});

	it("sorts failures first, then running, then idle, then the rest", () => {
		expectTable(
			[
				makeSummary({ id: "plain-saved", activity: "idle", rosterStatus: "inactive" }),
				makeSummary({ id: "worker", activeSessionId: "active-worker", activity: "working", streaming: true }),
				makeSummary({
					id: "crashed",
					activeSessionId: "active-crashed",
					activity: "idle",
					statusLabel: "failed",
				}),
				makeSummary({
					id: "sleeper",
					activeSessionId: "active-sleeper",
					activity: "idle",
					taskState: "completed",
				}),
			],
			[
				["crashed", "failed", "", "2h", "worker failed", ""],
				["worker", "running", "thinking", "2h", "", ""],
				["sleeper", "idle", "completed", "2h", "", ""],
				["plain-saved", "inactive", "", "2h", "", ""],
			],
		);
	});

	it("marks archived rows from --all as archived", () => {
		expectTable(
			[makeSummary({ id: "archived-agent", activity: "idle", lifecycle: "archived", rosterStatus: "inactive" })],
			[["archived-agent", "inactive", "archived", "2h", "", ""]],
		);
	});

	it("falls back to the compact display id for unnamed agents", () => {
		expectTable(
			[
				makeSummary({
					id: "019e71ec-e08a-75a9-b573-fc10e9f8380f",
					activeSessionId: "active-unnamed",
					activity: "idle",
					unnamed: true,
				}),
			],
			[["fc10e9f8380f", "idle", "", "2h", "", ""]],
		);
	});

	it("renders a heartbeating idle agent with its registered heartbeat", () => {
		expectTable(
			[
				makeSummary({
					id: "heartbeat-agent",
					activeSessionId: "active-heartbeat",
					activity: "idle",
					hasActiveHeartbeat: true,
				}),
			],
			[["heartbeat-agent", "idle", "heartbeat", "2h", "", ""]],
		);
	});

	it("mirrors the remaining activity detail branches of the agents-view label", () => {
		expectTable(
			[
				makeSummary({
					id: "action-agent",
					activeSessionId: "active-action",
					activity: "working",
					sessionActions: {
						queuedCount: 0,
						steering: [],
						followUps: [],
						active: { kind: "session_command", phase: "running", label: "Sending to worker" },
					},
				}),
				makeSummary({
					id: "kind-agent",
					activeSessionId: "active-kind",
					activity: "working",
					sessionActions: {
						queuedCount: 0,
						steering: [],
						followUps: [],
						active: { kind: "session_command", phase: "preparing" },
					},
				}),
				makeSummary({
					id: "queued-actions",
					activeSessionId: "active-queued-actions",
					activity: "idle",
					sessionActions: { queuedCount: 2, steering: [], followUps: [] },
				}),
				makeSummary({
					id: "starting-agent",
					activeSessionId: "active-starting",
					activity: "working",
					workerState: "starting",
				}),
				makeSummary({
					id: "stopping-agent",
					activeSessionId: "active-stopping",
					activity: "idle",
					workerState: "stopping",
				}),
				makeSummary({
					id: "replied-subagent",
					activeSessionId: "active-replied",
					activity: "idle",
					runtimeKind: "subagent",
					repliedSinceTask: true,
				}),
			],
			[
				["action-agent", "running", "Sending to worker", "2h", "", ""],
				["kind-agent", "running", "session command", "2h", "", ""],
				["starting-agent", "running", "starting", "2h", "", ""],
				["queued-actions", "idle", "2 queued", "2h", "", ""],
				["stopping-agent", "idle", "stopping", "2h", "", ""],
				["replied-subagent", "idle", "replied", "2h", "", ""],
			],
		);
	});
});

/** Assert the exact rendered table against the expected cell values. */
function expectTable(sessions: SessionSummary[], expectedRows: string[][]): void {
	const rendered = stripAnsi(formatSessionsTable(sessions, NOW_MS));
	const widths = HEADER.map((headerCell, index) =>
		Math.max(headerCell.length, ...expectedRows.map((row) => row[index]!.length)),
	);
	const pad = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  ");
	expect(rendered.split("\n")).toEqual([pad(HEADER), ...expectedRows.map((row) => pad(row))]);
}

interface SummaryOptions {
	id: string;
	activeSessionId?: string;
	activity: SessionActivity;
	lifecycle?: SessionLifecycle;
	streaming?: boolean;
	runningTools?: boolean;
	bash?: boolean;
	compacting?: boolean;
	statusLabel?: SessionSummary["statusLabel"];
	workerState?: SessionSummary["workerState"];
	lastHeardFromAt?: string;
	modified?: string;
	taskState?: SessionSummary["taskState"];
	rosterStatus?: SessionSummary["rosterStatus"];
	summary?: string;
	usage?: SessionSummary["usage"];
	diagnostics?: SessionSummary["diagnostics"];
	modelFallbackMessage?: string;
	hasActiveHeartbeat?: boolean;
	sessionActions?: SessionSummary["sessionActions"];
	runtimeKind?: SessionSummary["runtimeKind"];
	repliedSinceTask?: boolean;
	unnamed?: boolean;
}

function makeSummary(options: SummaryOptions): SessionSummary {
	return {
		id: options.id,
		lifecycle: options.lifecycle ?? "live",
		activity: options.activity,
		isSessionActive: options.activity === "working",
		...(options.activeSessionId ? { activeSessionId: options.activeSessionId } : {}),
		sessionId: `session-${options.id}`,
		...(options.unnamed ? {} : { sessionName: options.id }),
		cwd: "/tmp/project",
		isStreaming: options.streaming ?? false,
		isCompacting: options.compacting ?? false,
		...(options.runningTools !== undefined ? { isRunningTools: options.runningTools } : {}),
		...(options.bash !== undefined ? { isBashRunning: options.bash } : {}),
		...(options.runtimeKind ? { runtimeKind: options.runtimeKind } : {}),
		...(options.repliedSinceTask ? { repliedSinceTask: true } : {}),
		attachedClients: 0,
		messageCount: 2,
		sessionActions: options.sessionActions ?? { queuedCount: 0, steering: [], followUps: [] },
		modified: options.modified ?? DEFAULT_MODIFIED,
		...(options.statusLabel ? { statusLabel: options.statusLabel } : {}),
		...(options.workerState ? { workerState: options.workerState } : {}),
		...(options.lastHeardFromAt ? { lastHeardFromAt: options.lastHeardFromAt } : {}),
		...(options.taskState ? { taskState: options.taskState } : {}),
		...(options.rosterStatus ? { rosterStatus: options.rosterStatus } : {}),
		...(options.summary !== undefined ? { summary: options.summary } : {}),
		...(options.usage ? { usage: options.usage } : {}),
		...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
		...(options.modelFallbackMessage ? { modelFallbackMessage: options.modelFallbackMessage } : {}),
		...(options.hasActiveHeartbeat ? { hasActiveHeartbeat: true } : {}),
	};
}
