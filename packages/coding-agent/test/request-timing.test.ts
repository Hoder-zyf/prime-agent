import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type LogEntry,
	type Message,
	type Model,
	type SimpleStreamOptions,
	setLogSink,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	instrumentConvertToLlm,
	instrumentStreamFn,
	instrumentTransformContext,
	isRequestTimingEnabled,
} from "../src/core/request-timing.js";

const model = {
	id: "bench/bench-model",
	api: "openai-completions",
	provider: "bench",
	baseUrl: "https://bench.test/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.2 },
} as unknown as Model<"openai-completions">;
const PAYLOAD = { messages: [{ role: "user", content: "hello" }] };

function finalMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: "hm" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 800_000,
			output: 12,
			cacheRead: 790_000,
			cacheWrite: 0,
			totalTokens: 800_012,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function createGate() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

type Gates = {
	response: ReturnType<typeof createGate>;
	firstToken: ReturnType<typeof createGate>;
	done: ReturnType<typeof createGate>;
};

/** Scripted provider like the built-in ones: onPayload, TTFB gate, onResponse, start, first token, done. */
function scriptedProvider(gates: Gates, onResponse: boolean): StreamFn {
	return async (_model, _context, options) => {
		const stream = createAssistantMessageEventStream();
		await options?.onPayload?.(PAYLOAD, model);
		void (async () => {
			await gates.response.promise;
			if (onResponse) await options?.onResponse?.({ status: 200, headers: {} }, model);
			const partial = { ...finalMessage() };
			stream.push({ type: "start", partial });
			await gates.firstToken.promise;
			stream.push({ type: "thinking_start", contentIndex: 0, partial });
			await gates.done.promise;
			stream.push({ type: "done", reason: "stop", message: finalMessage() });
		})();
		return stream;
	};
}

async function drain(stream: AssistantMessageEventStream): Promise<void> {
	for await (const _event of stream) {
		// Consume everything the provider emits.
	}
}

/** Drive one request through all three instrumented seams under fake time. */
async function runTimedRequest(streamFn: StreamFn): Promise<AssistantMessageEventStream> {
	const enabled = () => true;
	const transform = instrumentTransformContext(enabled, async (messages) => messages);
	const convert = instrumentConvertToLlm(enabled, (messages) => messages as unknown as Message[]);
	const input = [{ role: "user", content: "hello" } as unknown as AgentMessage];
	const llmMessages = convert(await transform(input));
	return instrumentStreamFn(enabled, streamFn)(model, { systemPrompt: "", messages: llmMessages }, {
		sessionId: "sess-timing",
	} as SimpleStreamOptions);
}

describe("request timing", () => {
	let entries: LogEntry[];
	const originalEnv = process.env.PI_REQUEST_TIMING;
	beforeEach(() => {
		entries = [];
		setLogSink((entry) => entries.push(entry));
		delete process.env.PI_REQUEST_TIMING;
	});
	afterEach(() => {
		setLogSink(undefined);
		if (originalEnv === undefined) delete process.env.PI_REQUEST_TIMING;
		else process.env.PI_REQUEST_TIMING = originalEnv;
	});
	const timingEntries = () =>
		entries.filter((entry) => entry.component === "coding-agent.request-timing") as Array<Record<string, any>>;

	it("resolves the flag from the settings field or the env override", () => {
		expect(isRequestTimingEnabled(true)).toBe(true);
		delete process.env.PI_REQUEST_TIMING;
		expect(isRequestTimingEnabled(false)).toBe(false);
		process.env.PI_REQUEST_TIMING = "1";
		expect(isRequestTimingEnabled(false)).toBe(true);
		process.env.PI_REQUEST_TIMING = "yes";
		expect(isRequestTimingEnabled(false)).toBe(true);
		process.env.PI_REQUEST_TIMING = "0";
		expect(isRequestTimingEnabled(false)).toBe(false);
	});

	it.each([
		["first-byte from onResponse", true],
		["first-byte from the start event when onResponse is omitted", false],
	])("%s", async (_name, onResponse: boolean) => {
		vi.useFakeTimers();
		try {
			const gates: Gates = { response: createGate(), firstToken: createGate(), done: createGate() };
			const stream = await runTimedRequest(scriptedProvider(gates, onResponse));
			// Attach the rejection handler before advancing timers per the race-test convention.
			const consumed = drain(stream);
			consumed.catch(() => undefined);
			await vi.advanceTimersByTimeAsync(25);
			gates.response.open();
			await vi.advanceTimersByTimeAsync(0); // flush at t=25
			await vi.advanceTimersByTimeAsync(10);
			gates.firstToken.open();
			await vi.advanceTimersByTimeAsync(0); // flush at t=35
			await vi.advanceTimersByTimeAsync(5);
			gates.done.open();
			await consumed;
		} finally {
			vi.useRealTimers();
		}
		const timing = timingEntries();
		expect(timing.map((entry) => entry.phase)).toEqual([
			"prompt-built",
			"request-sent",
			"first-byte",
			"first-token",
			"stream-done",
		]);
		expect(new Set(timing.map((entry) => entry.requestSeq)).size).toBe(1);
		expect(timing.at(-1)).toMatchObject({
			msg: "request timing summary",
			outcome: "done",
			stopReason: "stop",
			sessionId: "sess-timing",
			model: model.id,
			provider: model.provider,
			contextEntries: 1,
			requestBytes: JSON.stringify(PAYLOAD).length,
			usage: { input: 800_000, output: 12, cacheRead: 790_000, cacheWrite: 0 },
			phases: {
				dispatchToPromptBuiltMs: 0,
				promptBuiltToRequestSentMs: 0,
				requestSentToFirstByteMs: 25,
				firstByteToFirstTokenMs: 10,
				firstTokenToStreamDoneMs: 5,
			},
			totalMs: 40,
		});
	});

	it("measures the payload exactly once when enabled and never when disabled", async () => {
		const seenOptions: unknown[] = [];
		const probes: number[] = [];
		const baseStreamFn: StreamFn = async (_model, _context, options) => {
			seenOptions.push(options);
			const probe = {
				toJSON: () => {
					probes.push(1);
					return PAYLOAD;
				},
			};
			await options?.onPayload?.(probe, model);
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: finalMessage() });
			return stream;
		};
		// Disabled: same options object, no serialization, no entries.
		const plainOptions: SimpleStreamOptions = { sessionId: "sess-off" };
		await drain(await instrumentStreamFn(() => false, baseStreamFn)(model, {} as Context, plainOptions));
		expect(seenOptions[0]).toBe(plainOptions);
		expect(probes).toHaveLength(0);
		expect(timingEntries()).toHaveLength(0);
		// Enabled: the payload is serialized once to measure the request body.
		await drain(await instrumentStreamFn(() => true, baseStreamFn)(model, {} as Context, {}));
		expect(probes).toHaveLength(1);
		expect(timingEntries().find((entry) => entry.phase === "request-sent")!.requestBytes).toBe(
			JSON.stringify(PAYLOAD).length,
		);
	});

	it("reports aborted and failed outcomes instead of losing the timeline", async () => {
		// Abort mid-stream: iteration stops before the done event.
		const gates: Gates = { response: createGate(), firstToken: createGate(), done: createGate() };
		const stream = await instrumentStreamFn(() => true, scriptedProvider(gates, true))(model, {} as Context, {});
		const iterator = stream[Symbol.asyncIterator]();
		const consumed = (async () => {
			await iterator.next();
		})();
		consumed.catch(() => undefined);
		gates.response.open();
		await Promise.resolve();
		await iterator.return?.();
		expect(timingEntries().at(-1)).toMatchObject({ phase: "stream-done", outcome: "aborted" });

		// Failure before send (e.g. auth rejected) still emits the summary.
		const failingStreamFn: StreamFn = async () => {
			throw new Error("No API key for provider: bench");
		};
		await expect(instrumentStreamFn(() => true, failingStreamFn)(model, {} as Context, {})).rejects.toThrow(
			"No API key",
		);
		expect(timingEntries().at(-1)).toMatchObject({ phase: "stream-done", outcome: "failed" });
	});
});
