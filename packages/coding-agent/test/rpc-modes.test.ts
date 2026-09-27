import { describe, expect, mock, test } from "bun:test";
import {
	describeModes,
	dispatchRpcGoalAction,
	dispatchRpcModeCommand,
	nextModeTransition,
	toSetModeResponse,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
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
	let lastCreateGoalInput: { objective: string; tokenBudget?: number } | undefined;
	const goalActionCalls: string[] = [];
	const appendModeChange = mock((_mode: string): string => "entry-1");

	const session = {
		sessionManager: { appendModeChange: appendModeChange as never },
		isStreaming: false,
		goalRuntime: {
			createGoal: async (input: { objective: string; tokenBudget?: number }) => {
				lastCreateGoalInput = input;
				return { enabled: true, goal: { objective: input.objective, tokenBudget: input.tokenBudget } };
			},
			resumeGoal: async () => {
				goalActionCalls.push("resume");
				const goal = (goalState as { goal?: unknown } | undefined)?.goal ?? {
					id: "goal-1",
					objective: "x",
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: 0,
				};
				const state = { enabled: true, mode: "active", goal: { ...(goal as object), status: "active" } };
				// Mirrors GoalRuntime.#commitState -> host.setState: the runtime, not
				// the controller, owns the session goal state on a resume.
				goalState = state;
				return state;
			},
			pauseGoal: async () => {
				goalActionCalls.push("pause");
				const goal = (goalState as { goal?: unknown } | undefined)?.goal;
				if (!goal) return undefined;
				const state = { enabled: false, mode: "active", goal: { ...(goal as object), status: "paused" } };
				goalState = state;
				return state;
			},
			dropGoal: async () => {
				goalActionCalls.push("drop");
				goalState = undefined;
				return undefined;
			},
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
		lastCreateGoalInput: () => lastCreateGoalInput,
		goalActionCalls,
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
	({
		type: "set_mode",
		mode,
		...(paused === undefined ? {} : { paused }),
	}) as Extract<RpcCommand, { type: "set_mode" }>;

/** Unwraps the conflict arm so a blocked transition fails the assertions below it. */
async function applied(controller: OmpModeController, command: Extract<RpcCommand, { type: "set_mode" }>) {
	const outcome = await dispatchRpcModeCommand(controller, command);
	if ("conflict" in outcome) throw new Error(`unexpected conflict: ${outcome.conflict}`);
	return outcome;
}
describe("nextModeTransition", () => {
	test("a no-arg set_mode walks the same cycle the TUI does", () => {
		// Outside -> enter, in -> pause, paused -> off. This is the order
		// handlePlanModeCommand uses, so a host badge and the terminal badge agree.
		expect(nextModeTransition(false, false, undefined)).toBe("enter");
		expect(nextModeTransition(true, false, undefined)).toBe("pause");
		expect(nextModeTransition(true, true, undefined)).toBe("disable");
	});

	test("an explicit paused target is a state, not a toggle", () => {
		// `paused: false` on a session already in that state is a no-op. Read as a
		// delta it would let a host that re-sends its desired state turn the mode
		// off underneath itself.
		expect(nextModeTransition(true, false, false)).toBe("none");
		expect(nextModeTransition(true, true, true)).toBe("none");
		expect(nextModeTransition(true, false, true)).toBe("pause");
		expect(nextModeTransition(true, true, false)).toBe("reactivate");
	});

	test("asking for a paused mode from outside enters straight into it", () => {
		// Entering and then pausing separately would leave an unpaused turn behind
		// that the host never asked for.
		expect(nextModeTransition(false, false, true)).toBe("enter-paused");
		expect(nextModeTransition(false, false, false)).toBe("enter");
	});
});

describe("RPC mode dispatch", () => {
	test("entering plan installs the plan toolset and reports the new state", async () => {
		const { controller, appendModeChange } = makeController();
		const outcome = await applied(controller, setMode("plan"));

		expect(outcome.changed).toBe(true);
		expect(outcome.state.mode).toBe("plan");
		expect(outcome.state.planModeEnabled).toBe(true);
		expect(appendModeChange).toHaveBeenCalledTimes(1);
	});

	test("entering goal reports goal mode without disturbing the plan flags", async () => {
		const { controller } = makeController();
		const outcome = await applied(controller, setMode("goal"));

		expect(outcome.state.mode).toBe("goal");
		expect(outcome.state.goalModeEnabled).toBe(true);
		expect(outcome.state.planModeEnabled).toBe(false);
	});

	test("loop mode is session-only and never journals a mode_change", async () => {
		const { controller, appendModeChange } = makeController();
		const outcome = await applied(controller, setMode("loop"));

		expect(outcome.state.loopModeEnabled).toBe(true);
		// Loop never reaches the journal, so a resume starts in `none` regardless.
		expect(appendModeChange).not.toHaveBeenCalled();
	});

	test("no-arg set_mode walks plan from inactive through active to paused to off", async () => {
		const { controller } = makeController();

		expect((await applied(controller, setMode("plan"))).state.mode).toBe("plan");
		expect((await applied(controller, setMode("plan"))).state.mode).toBe("plan_paused");

		const off = await applied(controller, setMode("plan"));
		expect(off.state.mode).toBe("none");
		expect(off.state.planModeEnabled).toBe(false);
	});

	test("an already-active plan is left alone rather than cycled", async () => {
		const { controller, appendModeChange } = makeController();
		await applied(controller, setMode("plan"));
		appendModeChange.mockClear();

		// `paused: false` names the state the session is already in, so it must
		// not be read as a request to toggle. Reading it as a delta would let a
		// host that re-sends its desired state turn the mode off underneath itself.
		const again = await applied(controller, setMode("plan", false));
		expect(again.changed).toBe(false);
		expect(again.state.mode).toBe("plan");
		expect(appendModeChange).not.toHaveBeenCalled();
	});

	test("disabling plan restores the pre-plan toolset", async () => {
		const { controller, enabledTools } = makeController(["read"]);
		await applied(controller, setMode("plan"));
		// Plan entry re-activates the built-in `write` tool for plan approval.
		expect(enabledTools()).toContain("write");

		await applied(controller, setMode("plan", true));
		await applied(controller, setMode("plan"));

		expect(enabledTools()).not.toContain("write");
	});

	test("reactivating a paused plan reinstalls the plan toolset", async () => {
		const { controller, enabledTools } = makeController(["read"]);
		await applied(controller, setMode("plan", true));
		// Pausing hands the working toolset back, which is the point of pausing.
		expect(enabledTools()).not.toContain("write");

		await applied(controller, setMode("plan", false));

		// Reactivating has to exit before entering: entering alone would leave the
		// session holding the plan toolset next to the restored working model.
		expect(enabledTools()).toContain("write");
	});

	test("goal mode pauses and reactivates through the same mapping", async () => {
		const { controller } = makeController();
		await applied(controller, setMode("goal"));

		expect((await applied(controller, setMode("goal", true))).state.mode).toBe("goal_paused");
		expect((await applied(controller, setMode("goal", false))).state.mode).toBe("goal");
	});

	test("returns OMP's own guard message verbatim when a second mode is requested", async () => {
		const { controller } = makeController();
		await applied(controller, setMode("plan"));

		// The exact string the TUI shows, not one composed for the protocol.
		expect(await dispatchRpcModeCommand(controller, setMode("goal"))).toEqual({
			conflict: "Exit plan mode first.",
		});
	});

	test("distinguishes a paused plan session from an active one in the guard", async () => {
		const { controller } = makeController();
		await applied(controller, setMode("plan", true));

		expect(await dispatchRpcModeCommand(controller, setMode("goal"))).toEqual({
			conflict: "Plan mode is paused — run /plan again to fully exit.",
		});
	});

	test("maps a blocked transition to a failure carrying OMP's message and mode_conflict", async () => {
		const { controller } = makeController();
		await applied(controller, setMode("plan"));

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
		const response = toSetModeResponse("req-2", await dispatchRpcModeCommand(controller, setMode("plan")));

		expect(response).toMatchObject({
			id: "req-2",
			command: "set_mode",
			success: true,
			data: { mode: "plan", planModeEnabled: true, changed: true, canEnter: true },
		});
	});

	test("entering goal with an objective and token budget reaches the goal runtime", async () => {
		const { controller, lastCreateGoalInput } = makeController();
		await applied(controller, {
			type: "set_mode",
			mode: "goal",
			objective: "ship the thing",
			tokenBudget: 50_000,
		} as Extract<RpcCommand, { type: "set_mode" }>);

		expect(lastCreateGoalInput()).toEqual({ objective: "ship the thing", tokenBudget: 50_000 });
	});

	test("entering loop with raw args parses the limit onto the controller", async () => {
		const { controller } = makeController();
		await applied(controller, {
			type: "set_mode",
			mode: "loop",
			args: "5 fix the failing tests",
		} as Extract<RpcCommand, { type: "set_mode" }>);

		expect(controller.loopModeEnabled).toBe(true);
		expect(controller.loopLimit).toMatchObject({ kind: "iterations", initial: 5, remaining: 5 });
	});

	test("describeModes surfaces the active goal and loop objects, not just the flags", async () => {
		const { controller } = makeController();
		await applied(controller, {
			type: "set_mode",
			mode: "goal",
			objective: "ship the thing",
		} as Extract<RpcCommand, { type: "set_mode" }>);

		const described = describeModes(controller.snapshot(), true);
		expect(described.goal).toMatchObject({ objective: "ship the thing", tokenBudget: undefined });
	});

	test("describeModes reports loop as null once disabled", async () => {
		const { controller } = makeController();
		expect(describeModes(controller.snapshot(), true).loop).toBeNull();

		await applied(controller, setMode("loop"));
		const described = describeModes(controller.snapshot(), true);
		expect(described.loop).toMatchObject({ state: "running" });
	});
});

describe("dispatchRpcGoalAction", () => {
	test("pause, resume, and drop each reach exactly the matching goal runtime method", async () => {
		const { controller, session, goalActionCalls } = makeController();

		await dispatchRpcGoalAction(controller, session, "pause");
		await dispatchRpcGoalAction(controller, session, "resume");
		await dispatchRpcGoalAction(controller, session, "drop");

		expect(goalActionCalls).toEqual(["pause", "resume", "drop"]);
	});

	test("pause flips the controller flags and hands the working toolset back", async () => {
		const { controller, session, enabledTools } = makeController();
		await applied(controller, {
			type: "set_mode",
			mode: "goal",
			objective: "ship the thing",
		} as Extract<RpcCommand, { type: "set_mode" }>);
		expect(enabledTools()).toContain("goal");

		const result = await dispatchRpcGoalAction(controller, session, "pause");

		// Regression: dispatchRpcGoalAction used to call the goal runtime
		// directly (or only adoptGoalState) without exiting the controller's
		// goal mode, so goalModeEnabled stayed true, the derived `mode` stayed
		// "goal", canEnter("goal") stayed blocked, and — the subtler half — the
		// `goal` tool stayed armed while the client was told the goal was off.
		expect(controller.goalModeEnabled).toBe(false);
		expect(controller.goalModePaused).toBe(true);
		expect(controller.mode).toBe("goal_paused");
		expect(result.mode).toBe("goal_paused");
		expect(result.goal).toMatchObject({ status: "paused" });
		expect(enabledTools()).not.toContain("goal");
	});

	test("resume re-arms the goal tool and flips the flags back to active", async () => {
		const { controller, session, enabledTools } = makeController();
		await applied(controller, {
			type: "set_mode",
			mode: "goal",
			objective: "ship the thing",
		} as Extract<RpcCommand, { type: "set_mode" }>);
		await dispatchRpcGoalAction(controller, session, "pause");
		expect(enabledTools()).not.toContain("goal");

		const result = await dispatchRpcGoalAction(controller, session, "resume");

		// Resume has to re-arm the goal tool pause handed back — a bare
		// goalRuntime.resumeGoal() + adoptGoalState would revive the goal object
		// while the agent silently lost the ability to call `goal`.
		expect(controller.goalModeEnabled).toBe(true);
		expect(controller.goalModePaused).toBe(false);
		expect(controller.mode).toBe("goal");
		expect(result.goal).toMatchObject({ status: "active" });
		expect(enabledTools()).toContain("goal");
	});

	test("drop clears both flags and the goal, and restores the pre-goal toolset", async () => {
		const { controller, session, enabledTools } = makeController(["read"]);
		await applied(controller, {
			type: "set_mode",
			mode: "goal",
			objective: "ship the thing",
		} as Extract<RpcCommand, { type: "set_mode" }>);
		expect(enabledTools()).toContain("goal");

		const result = await dispatchRpcGoalAction(controller, session, "drop");

		expect(controller.goalModeEnabled).toBe(false);
		expect(controller.goalModePaused).toBe(false);
		expect(controller.mode).toBe("none");
		expect(result.goal).toBeNull();
		expect(enabledTools()).not.toContain("goal");
	});
});
