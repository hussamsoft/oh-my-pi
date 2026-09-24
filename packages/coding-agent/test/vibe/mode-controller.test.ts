import { describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { SessionManager } from "../../src/session/session-manager";
import { VibeModeController, type VibeModeSession } from "../../src/vibe/mode-controller";
import { VibeSessionRegistry, type VibeOwnerScope } from "../../src/vibe/runtime";
import { EventBus } from "../../src/utils/event-bus";
import type { ToolSession } from "../../src/tools";
import type { VibeScreenSnapshot } from "@oh-my-pi/pi-tui/tools/vibe";
import { TempDir } from "@oh-my-pi/pi-utils";

function workerSnapshot(overrides: Partial<VibeScreenSnapshot> = {}): VibeScreenSnapshot {
	return {
		id: "worker-1",
		cli: "fast",
		name: "worker-1",
		state: "running",
		createdAt: 10,
		lastTurnStatus: "running",
		model: "test/model",
		turns: 1,
		queued: 0,
		trace: [],
		outputTail: [],
		lastActivityAt: 10,
		...overrides,
	};
}

function makeHarness(tempDir: TempDir) {
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	const settings = Settings.isolated({});
	const eventBus = new EventBus();
	let snapshot = workerSnapshot();
	const scope: VibeOwnerScope = { ownerId: "Main", parentSessionId: sessionManager.getSessionId(), parentSessionFile: null };
	const registry = {
		ownerScope: vi.fn(() => scope),
		rehydrate: vi.fn(async () => 0),
		screens: vi.fn(() => [snapshot]),
		activateScope: vi.fn(),
		killAll: vi.fn(async () => 2),
		suspendScope: vi.fn(async () => 2),
	} as unknown as VibeSessionRegistry;
	const transition = {
		sessionManager,
		settings,
		isStreaming: false,
		abort: vi.fn(async () => {}),
		getEnabledToolNames: vi.fn(() => ["read", "bash"]),
		hasBuiltInTool: vi.fn((name: string) => name === "todo"),
		activateVibeTools: vi.fn(async () => {}),
		deactivateVibeTools: vi.fn(async () => {}),
		removeVibeToolsPreservingActive: vi.fn(async () => {}),
		setVibeModeState: vi.fn(),
		getVibeModeState: vi.fn<() => { enabled: true } | undefined>(() => undefined),
		sendVibeModeContext: vi.fn(async () => {}),
		runModeExitTeardown: vi.fn(async (teardown: () => Promise<void>) => teardown()),
		getAgentId: () => "Main",
	} satisfies VibeModeSession;
	const toolSession: ToolSession = {
		cwd: tempDir.path(),
		hasUI: false,
		settings,
		sessionManager,
		asyncJobManager: undefined,
		getSessionFile: () => null,
		getSessionId: () => sessionManager.getSessionId(),
		getSessionSpawns: () => null,
		getAgentId: () => "Main",
	};
	return {
		controller: new VibeModeController({ session: transition, toolSession, registry, eventBus }),
		eventBus,
		registry,
		sessionManager,
		transition,
		setSnapshot(next: VibeScreenSnapshot) {
			snapshot = next;
		},
	};
}

describe("VibeModeController", () => {
	it("rehydrates each scope once and accepts entry prompts after installing the exact Vibe surface", async () => {
		const tempDir = TempDir.createSync("@pi-vibe-controller-");
		try {
			const harness = makeHarness(tempDir);
			const accepted = vi.fn(async () => true);
			const controller = new (harness.controller.constructor as typeof VibeModeController)({
				session: harness.transition,
				toolSession: {
					cwd: tempDir.path(),
					hasUI: false,
					settings: harness.transition.settings,
					sessionManager: harness.sessionManager,
					getSessionFile: () => null,
					getSessionSpawns: () => null,
				},
				registry: harness.registry,
				dispatchPrompt: accepted,
			});
			await controller.getState();
			await controller.getState();
			expect(await controller.enter("delegate now")).toEqual({ enabled: true, accepted: true });
			expect(harness.registry.rehydrate).toHaveBeenCalledTimes(1);
			expect(harness.transition.activateVibeTools).toHaveBeenCalledWith(["read", "todo"]);
			expect(accepted).toHaveBeenCalledWith("delegate now");
			controller.dispose();
		} finally {
			tempDir.removeSync();
		}
	});

	it("kills the full scope and restores the exact prior enabled toolset", async () => {
		const tempDir = TempDir.createSync("@pi-vibe-controller-exit-");
		try {
			const harness = makeHarness(tempDir);
			await harness.controller.enter();
			harness.transition.getVibeModeState.mockReturnValue({ enabled: true });
			expect(await harness.controller.exit()).toEqual({ enabled: false, killedWorkers: 2 });
			expect(harness.registry.killAll).toHaveBeenCalledTimes(1);
			expect(harness.transition.deactivateVibeTools).toHaveBeenCalledWith(["read", "bash"]);
			harness.controller.dispose();
		} finally {
			tempDir.removeSync();
		}
	});

	it("emits only canonical changes for identity-safe lifecycle and progress frames", async () => {
		const tempDir = TempDir.createSync("@pi-vibe-controller-events-");
		try {
			const harness = makeHarness(tempDir);
			const states: ReturnType<typeof harness.controller.getState> extends Promise<infer T> ? T[] : never[] = [];
			const controller = new (harness.controller.constructor as typeof VibeModeController)({
				session: harness.transition,
				toolSession: {
					cwd: tempDir.path(),
					hasUI: false,
					settings: harness.transition.settings,
					sessionManager: harness.sessionManager,
					getSessionFile: () => null,
					getSessionSpawns: () => null,
				},
				registry: harness.registry,
				eventBus: harness.eventBus,
				onState: state => {
					states.push(state);
				},
			});
			await controller.getState();
			const initialCount = states.length;
			harness.eventBus.emit("task:subagent:lifecycle", {
				id: "unknown",
				agent: "task",
				agentSource: "bundled",
				status: "started",
				index: 1,
			});
			harness.eventBus.emit("task:subagent:lifecycle", {
				id: "worker-1",
				agent: "task",
				agentSource: "bundled",
				status: "started",
				index: 1,
			});
			harness.eventBus.emit("task:subagent:progress", {
				index: 1,
				agent: "task",
				agentSource: "bundled",
				task: "work",
				progress: {
					index: 1,
					id: "mismatch",
					agent: "task",
					agentSource: "bundled",
					status: "running",
					task: "work",
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 1,
				},
			});
			harness.eventBus.emit("task:subagent:progress", {
				index: 1,
				agent: "task",
				agentSource: "bundled",
				task: "work",
				progress: {
					index: 1,
					id: "unknown",
					agent: "task",
					agentSource: "bundled",
					status: "running",
					task: "work",
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 1,
				},
			});
			harness.setSnapshot(workerSnapshot({ outputTail: ["done"] }));
			harness.eventBus.emit("task:subagent:progress", {
				index: 1,
				agent: "task",
				agentSource: "bundled",
				task: "work",
				progress: {
					index: 1,
					id: "worker-1",
					agent: "task",
					agentSource: "bundled",
					status: "completed",
					task: "work",
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 1,
				},
			});
			expect(states).toHaveLength(initialCount + 1);
			expect(states.at(-1)?.workers[0]?.outputTail).toEqual(["done"]);
			controller.dispose();
		} finally {
			tempDir.removeSync();
		}
	});
});
