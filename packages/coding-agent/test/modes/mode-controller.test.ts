import { describe, expect, it, vi } from "bun:test";
import { OmpModeController, type OmpModeSession } from "../../src/modes/mode-controller";
import { USER_INTERRUPT_LABEL } from "../../src/session/messages";
import type { PlanModeState } from "../../src/plan-mode/state";
import type { GoalModeState } from "../../src/goals/state";
/**
 * A session double for the mode transitions. `enabledTools` is the single source
 * of truth for the toolset, so a transition that forgets to install or restore
 * the mode's tools shows up here as a wrong list.
 */
function makeSession(overrides: Partial<Record<string, unknown>> = {}) {
	const sessionManager = { appendModeChange: vi.fn(() => "entry-1") };
	let enabledTools = ["read", "write"];
	let mountedTools = ["read", "write"];
	let planState: PlanModeState | undefined;
	let goalState: GoalModeState | undefined;
	let proposalHandler: ((title: string) => Promise<unknown>) | null = null;

	const session = {
		sessionManager,
		isStreaming: false,
		goalRuntime: {
			createGoal: vi.fn(async () => ({ enabled: true }) as unknown as GoalModeState),
			resumeGoal: vi.fn(async () => ({ enabled: true }) as unknown as GoalModeState),
		},
		getEnabledToolNames: () => [...enabledTools],
		getMountedXdevToolNames: () => [...mountedTools],
		hasBuiltInTool: (name: string) => name === "write",
		setActiveToolsByName: vi.fn(async (names: string[]) => {
			enabledTools = [...names];
		}),
		restoreNonMCPToolPresentation: vi.fn(async (nonMCP: string[], nonMCPMounted: string[]) => {
			enabledTools = [...nonMCP];
			mountedTools = [...nonMCPMounted];
		}),
		setActiveToolPresentation: vi.fn(async (next: string[], nextMounted: string[]) => {
			enabledTools = [...next];
			mountedTools = [...nextMounted];
		}),
		getPlanModeState: () => planState,
		setPlanModeState: (state: PlanModeState | undefined) => {
			planState = state;
		},
		setPlanProposalHandler: (handler: ((title: string) => Promise<unknown>) | null) => {
			proposalHandler = handler;
		},
		preparePlanForReview: vi.fn(async () => ({ ok: true })),
		sendPlanModeContext: vi.fn(async () => {}),
		getGoalModeState: () => goalState,
		setGoalModeState: (state: GoalModeState | undefined) => {
			goalState = state;
		},
		sendGoalModeContext: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		runModeExitTeardown: vi.fn(async (teardown: () => Promise<void>) => teardown()),
		...overrides,
	} as unknown as OmpModeSession & { enabledTools: () => string[] };

	return {
		session,
		appendModeChange: session.sessionManager.appendModeChange as ReturnType<typeof vi.fn>,
		setEnabledTools: (names: string[]) => {
			enabledTools = [...names];
		},
		planState: () => planState,
		goalState: () => goalState,
		proposalHandler: () => proposalHandler,
	};
}

function makeController(session: OmpModeSession, options: Record<string, unknown> = {}) {
	return new OmpModeController({
		session,
		resolvePlanFilePath: async () => "PLAN.md",
		onStatus: vi.fn(),
		onWarning: vi.fn(),
		...options,
	});
}

describe("OmpModeController", () => {
	it("journals one mode_change and installs the plan toolset on entry", async () => {
		const harness = makeSession();
		const controller = makeController(harness.session);

		await controller.enterPlan({ planFilePath: "PLAN.md" });

		expect(controller.mode).toBe("plan");
		expect(harness.appendModeChange).toHaveBeenCalledTimes(1);
		expect(harness.appendModeChange).toHaveBeenCalledWith("plan", { planFilePath: "PLAN.md" });
		// `write` is re-activated for plan approval even when it was not enabled.
		expect(harness.session.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(harness.planState()?.enabled).toBe(true);
		// Plan approval must stay wired: without a proposal handler the agent can
		// draft a plan but never submit it.
		expect(harness.proposalHandler()).toBeDefined();
	});

	it("restores the previous toolset and journals none on plan exit", async () => {
		const harness = makeSession();
		const controller = makeController(harness.session);
		await controller.enterPlan({ planFilePath: "PLAN.md" });
		harness.appendModeChange.mockClear();

		harness.setEnabledTools(["read", "write", "extra"]);
		await controller.exitPlan();

		expect(controller.mode).toBe("none");
		expect(harness.appendModeChange).toHaveBeenCalledWith("none");
		expect(harness.session.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(harness.planState()).toBeUndefined();
	});

	it("aborts a mid-turn plan exit with the user-interrupt reason", async () => {
		const harness = makeSession();
		const streaming = { ...harness.session, isStreaming: true } as OmpModeSession;
		const controller = makeController(streaming);
		await controller.enterPlan({ planFilePath: "PLAN.md" });

		await controller.exitPlan({ interruptActiveTurn: true });

		// `agent-session` only sets the UserInterrupt flag (and suppresses the
		// advisor auto-resume) when the reason matches, so a bare abort would
		// leave an interrupted turn eligible for auto-resume.
		expect(harness.session.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
	});

	it("keeps the goal tool out of the restore set after a guided interview", async () => {
		const harness = makeSession();
		const controller = makeController(harness.session);

		// The interview exposes `goal` without entering goal mode, so the baseline
		// is recorded up front.
		harness.setEnabledTools(["read", "write"]);
		controller.recordGoalToolBaseline();
		harness.setEnabledTools(["read", "write", "goal"]);

		await controller.enterGoal({ objective: "ship it" });
		await controller.exitGoal();

		// Entering goal re-reads a toolset that already contains `goal`; if it
		// overwrote the baseline the goal tool would survive the exit.
		expect(harness.session.getEnabledToolNames()).not.toContain("goal");
	});

	it("refuses a second mode with the shared guard message", async () => {
		const harness = makeSession();
		const controller = makeController(harness.session);
		await controller.enterPlan({ planFilePath: "PLAN.md" });

		expect(controller.canEnter("goal")).toBe("Exit plan mode first.");
		expect(await controller.enterGoal({ objective: "x" })).toBe(false);
		expect(controller.mode).toBe("plan");
	});

	it("distinguishes a paused plan from an active one in the guard", async () => {
		const harness = makeSession();
		const controller = makeController(harness.session);
		await controller.enterPlan({ planFilePath: "PLAN.md" });
		await controller.exitPlan({ paused: true });

		expect(controller.mode).toBe("plan_paused");
		expect(controller.canEnter("goal")).toBe("Plan mode is paused — run /plan again to fully exit.");
	});
});
