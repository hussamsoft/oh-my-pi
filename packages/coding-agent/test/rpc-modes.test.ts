import { describe, expect, mock, test } from "bun:test";
import { dispatchRpcModeCommand, toSetModeResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { OmpModeController } from "@oh-my-pi/pi-coding-agent/modes/mode-controller";
import type { RpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

/**
 * A session double for the mode transitions. `enabledTools` is the single source
 * of truth for the toolset, so a transition that forgets to install or restore
 * the mode's tools shows up here as a wrong list.
 */
function makeSession(initialTools: string[] = ["read", "write"]) {
	let enabledTools = [...initialTools];
	let mountedTools = [...initialTools];
	let planState: unknown;
	let goalState: unknown;
	const appendModeChange = mock((_mode: string): string => "entry-1");

	const session = {
		sessionManager: { appendModeChange: appendModeChange as never },
		isStreaming: false,
		goalRuntime: {
			createGoal: async () => ({ enabled: true }),
			resumeGoal: async () => ({ enabled: true }),
		},
		getEnabledToolNames: () => [...enabledTools],
		getMountedXdevToolNames: () => [...mountedTools],
		hasBuiltInTool: (name: string) => name === "write",
		setActiveToolsByName: async (names: string[]) => {
			enabledTools = [...names];
		},
		restoreNonMCPToolPresentation: async (enabled: string[], nonMCPMounted: string[]) => {
			enabledTools = [...enabled];
			mountedTools = [...nonMCPMounted];
		},
		setActiveToolPresentation: async (enabled: string[], mounted: string[]) => {
			enabledTools = [...enabled];
			mountedTools = [...mounted];
		},
		getPlanModeState: () => planState,
		setPlanModeState: (state: unknown) => {
			planState = state;
		},
		setPlanProposalHandler: () => {},
		preparePlanForReview: async () => ({ ok: true }),
		sendPlanModeContext: async () => {},
		getGoalModeState: () => goalState,
		setGoalModeState: (state: unknown) => {
			goalState = state;
		},
		sendGoalModeContext: async () => {},
		abort: async () => {},
		runModeExitTeardown: async (teardown: () => Promise<void>) => teardown(),
	};

	return {
		session: session as never,
		appendModeChange,
		enabledTools: () => enabledTools,
		planState: () => planState,
	};
}

function makeController(initialTools: string[] = ["read", "write"]) {
	const harness = makeSession(initialTools);
	const controller = new OmpModeController({
		session: harness.session,
		resolvePlanFilePath: async () => "PLAN.md",
	});
	return { controller, ...harness };
}

const setMode = (mode: "plan" | "goal" | "loop", paused?: boolean) =>
	({ type: "set_mode", mode, ...(paused === undefined ? {} : { paused }) }) as Extract<
		RpcCommand,
		{ type: "set_mode" }
	>;

describe("RPC mode dispatch", () => {
	test("entering plan installs the plan toolset and reports the new state", async () => {
		const { controller, appendModeChange } = makeController();
		const outcome = await dispatchRpcModeCommand(controller, setMode("plan"));

		expect("conflict" in outcome).toBe(false);
		if ("conflict" in outcome) return;
		expect(outcome.changed).toBe(true);
		expect(outcome.state.mode).toBe("plan");
		expect(outcome.state.planModeEnabled).toBe(true);
		expect(appendModeChange).toHaveBeenCalledTimes(1);
	});

	test("entering goal reports goal mode without disturbing the plan flags", async () => {
		const { controller } = makeController();
		const outcome = await dispatchRpcModeCommand(controller, setMode("goal"));

		expect("conflict" in outcome).toBe(false);
		if ("conflict" in outcome) return;
		expect(outcome.state.mode).toBe("goal");
		expect(outcome.state.goalModeEnabled).toBe(true);
		expect(outcome.state.planModeEnabled).toBe(false);
	});

	test("loop mode is session-only and never journals a mode_change", async () => {
		const { controller, appendModeChange } = makeController();
		const outcome = await dispatchRpcModeCommand(controller, setMode("loop"));

		expect("conflict" in outcome).toBe(false);
		if ("conflict" in outcome) return;
		expect(outcome.state.loopModeEnabled).toBe(true);
		// Loop never reaches the journal, so a resume starts in `none` regardless.
		expect(appendModeChange).not.toHaveBeenCalled();
	});

	test("re-entering the active mode is a no-op rather than a second transition", async () => {
		const { controller, appendModeChange } = makeController();
		await dispatchRpcModeCommand(controller, setMode("plan"));
		appendModeChange.mockClear();

		const again = await dispatchRpcModeCommand(controller, setMode("plan"));
		expect("conflict" in again).toBe(false);
		if ("conflict" in again) return;
		expect(again.changed).toBe(false);
		expect(appendModeChange).not.toHaveBeenCalled();
	});

	test("pausing and resuming plan mode round-trips through the journal", async () => {
		const { controller } = makeController();
		await dispatchRpcModeCommand(controller, setMode("plan"));

		const paused = await dispatchRpcModeCommand(controller, setMode("plan", true));
		expect("conflict" in paused).toBe(false);
		if ("conflict" in paused) return;
		expect(paused.state.mode).toBe("plan_paused");
		expect(paused.state.planModePaused).toBe(true);

		const resumed = await dispatchRpcModeCommand(controller, setMode("plan", false));
		expect("conflict" in resumed).toBe(false);
		if ("conflict" in resumed) return;
		expect(resumed.state.mode).toBe("plan");
		expect(resumed.state.planModePaused).toBe(false);
	});

	test("returns OMP's own guard message verbatim when a second mode is requested", async () => {
		const { controller } = makeController();
		await dispatchRpcModeCommand(controller, setMode("plan"));

		const blocked = await dispatchRpcModeCommand(controller, setMode("goal"));
		// The exact string the TUI shows, not one composed for the protocol.
		expect(blocked).toEqual({ conflict: "Exit plan mode first." });
	});

	test("distinguishes a paused plan session from an active one in the guard", async () => {
		const { controller } = makeController();
		await dispatchRpcModeCommand(controller, setMode("plan"));
		await dispatchRpcModeCommand(controller, setMode("plan", true));

		const blocked = await dispatchRpcModeCommand(controller, setMode("goal"));
		expect(blocked).toEqual({
			conflict: "Plan mode is paused — run /plan again to fully exit.",
		});
	});

	test("exiting plan restores the pre-plan toolset", async () => {
		const { controller, enabledTools } = makeController(["read"]);
		await dispatchRpcModeCommand(controller, setMode("plan"));
		// Plan entry re-activates the built-in `write` tool for plan approval.
		expect(enabledTools()).toContain("write");

		const off = await dispatchRpcModeCommand(controller, setMode("plan", false));
		expect("conflict" in off).toBe(false);
		expect(enabledTools()).not.toContain("write");
	});

	test("maps a blocked transition to a failure carrying OMP's message and mode_conflict", async () => {
		const { controller } = makeController();
		await dispatchRpcModeCommand(controller, setMode("plan"));

		const outcome = await dispatchRpcModeCommand(controller, setMode("goal"));
		const response = toSetModeResponse("req-1", outcome);

		// The dispatcher returns the conflict; this is where it becomes a wire
		// failure. A host reading `success` alone would otherwise be told the
		// agent entered goal mode.
		expect(response).toEqual({
			id: "req-1",
			type: "response",
			command: "set_mode",
			success: false,
			error: "Exit plan mode first.",
			code: "mode_conflict",
		});
	});

	test("maps an applied transition to a success with the post-transition state", async () => {
		const { controller } = makeController();
		const outcome = await dispatchRpcModeCommand(controller, setMode("plan"));
		const response = toSetModeResponse("req-2", outcome);

		expect(response).toMatchObject({
			id: "req-2",
			command: "set_mode",
			success: true,
			data: { mode: "plan", planModeEnabled: true, changed: true, canEnter: true },
		});
	});
});
