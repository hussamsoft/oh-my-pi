import { describe, expect, test } from "bun:test";
import type { VibeWorkerSnapshot } from "@oh-my-pi/pi-coding-agent/vibe/mode-controller";
import { dispatchRpcVibeCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

const worker: VibeWorkerSnapshot = {
	id: "worker-1",
	cli: "good",
	name: "Worker 1",
	state: "idle",
	turnCount: 1,
	queuedMessages: 0,
	outputTail: [],
	lastTurnStatus: "completed",
	createdAt: 1,
	lastActivityAt: 2,
};

function fakeController() {
	const calls: Array<{ method: string; args?: unknown }> = [];
	return {
		calls,
		getState: async () => ({ revision: 1, enabled: false, workers: [] }),
		enter: async (prompt?: string) => {
			calls.push({ method: "enter", args: prompt });
			return { enabled: true as const, accepted: prompt === "direct" };
		},
		exit: async () => {
			calls.push({ method: "exit" });
			return { enabled: false as const, killedWorkers: 2 };
		},
		spawn: async (args: { cli: "fast" | "good"; name?: string; prompt: string }) => {
			calls.push({ method: "spawn", args });
			return { ...worker, ...args, id: "worker-1" };
		},
		send: async (args: { session: string; message: string }) => {
			calls.push({ method: "send", args });
			return { delivery: "started" as const };
		},
		wait: async (args: { sessions?: string[]; timeoutMs?: number }) => {
			calls.push({ method: "wait", args });
			return { settled: [], stillRunning: [], timedOut: true };
		},
		kill: async (input: { session: string }) => {
			calls.push({ method: "kill", args: input.session });
			return { ...worker, state: "dead" as const, lastTurnStatus: "cancelled" as const };
		},
		list: async () => {
			calls.push({ method: "list" });
			return [worker];
		},
	};
}

describe("RPC Vibe command mapping", () => {
	test("maps all eight commands to the shared controller", async () => {
		const controller = fakeController();
		expect(await dispatchRpcVibeCommand(controller, { type: "vibe_status" })).toEqual({ revision: 1, enabled: false, workers: [] });
		expect(await dispatchRpcVibeCommand(controller, { type: "vibe_enter", prompt: "direct" })).toEqual({ enabled: true, accepted: true });
		expect(await dispatchRpcVibeCommand(controller, { type: "vibe_exit" })).toEqual({ enabled: false, killedWorkers: 2 });
		expect(await dispatchRpcVibeCommand(controller, { type: "vibe_spawn", cli: "good", prompt: "work" })).toMatchObject({ id: "worker-1", cli: "good" });
		expect(await dispatchRpcVibeCommand(controller, { type: "vibe_send", session: "worker-1", message: "next" })).toEqual({ delivery: "started" });
		expect(await dispatchRpcVibeCommand(controller, { type: "vibe_wait", sessions: ["worker-1"], timeoutMs: 50 })).toEqual({ settled: [], stillRunning: [], timedOut: true });
		expect(await dispatchRpcVibeCommand(controller, { type: "vibe_kill", session: "worker-1" })).toMatchObject({ state: "dead" });
		expect(await dispatchRpcVibeCommand(controller, { type: "vibe_list" })).toEqual([worker]);
		expect(controller.calls.map(call => call.method)).toEqual(["enter", "exit", "spawn", "send", "wait", "kill", "list"]);
	});

	test("rejects malformed worker payloads before controller dispatch", async () => {
		const controller = fakeController();
		await expect(dispatchRpcVibeCommand(controller, { type: "vibe_send", session: "", message: "next" })).rejects.toThrow("non-empty");
		await expect(dispatchRpcVibeCommand(controller, { type: "vibe_wait", timeoutMs: 0 })).rejects.toThrow("positive");
		expect(controller.calls).toEqual([]);
	});
});
