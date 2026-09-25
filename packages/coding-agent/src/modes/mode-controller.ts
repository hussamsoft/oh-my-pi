import { isMCPToolName } from "../tools/builtin-names";
import { createLoopLimitRuntime, describeLoopLimit, describeLoopLimitRuntime, parseLoopArgs } from "./loop-limit";
import { describeLoopCondition } from "./loop-condition";
import type { LoopConditionConfig, LoopLimitRuntime } from "@oh-my-pi/pi-tui/status-line/loop";
import type { Model } from "@oh-my-pi/pi-ai";
import type { PlanModeState } from "../plan-mode/state";
import type { GoalModeState } from "../goals/state";
import type { PlanProposalHandler } from "../tools/resolve";
import type { GoalRuntime } from "../goals/runtime";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

/**
 * The modes a session can be in. `loop` is deliberately session-only: it is never
 * journalled, so a resume starts in `none` even when the user left a loop running.
 */
export type OmpModeName = "none" | "plan" | "plan_paused" | "goal" | "goal_paused" | "loop";

/** One state snapshot, as published over RPC and as rendered by the TUI. */
export interface OmpModeState {
	mode: OmpModeName;
	planModeEnabled: boolean;
	planModePaused: boolean;
	goalModeEnabled: boolean;
	goalModePaused: boolean;
	loopModeEnabled: boolean;
	loopModePaused: boolean;
	planFilePath: string | undefined;
	advisorEnabled: boolean;
	prewalkArmed: boolean;
	fastModeEnabled: boolean;
	hideThinking: boolean;
}

/** The session surface the transitions need. Kept narrow so the TUI can pass itself. */
export interface OmpModeSession {
	readonly sessionManager: { appendModeChange(mode: string, data?: Record<string, unknown>): string };
	readonly isStreaming: boolean;
	readonly goalRuntime: GoalRuntime;
	getEnabledToolNames(): string[];
	getMountedXdevToolNames(): string[];
	hasBuiltInTool(name: string): boolean;
	setActiveToolsByName(toolNames: string[]): Promise<void>;
	restoreNonMCPToolPresentation(nonMCPToolNames: string[], nonMCPMountedToolNames: string[]): Promise<void>;
	setActiveToolPresentation(enabled: string[], mounted: string[]): Promise<void>;
	getPlanModeState(): PlanModeState | undefined;
	setPlanModeState(state: PlanModeState | undefined): void;
	setPlanProposalHandler(handler: PlanProposalHandler | null): void;
	preparePlanForReview(title: string): ReturnType<PlanProposalHandler>;
	/** Opens plan review for an approved plan. Supplied by the TUI; a headless
	 * RPC host has no review surface, so the handler is absent. */
	onPlanProposal?: PlanProposalHandler;
	sendPlanModeContext(options: { deliverAs: "steer" }): Promise<void>;
	getGoalModeState(): GoalModeState | undefined;
	setGoalModeState(state: GoalModeState | undefined): void;
	sendGoalModeContext(options: { deliverAs: "steer" }): Promise<void>;
	/** Aborts the streaming turn. The reason becomes the user-interrupt flag, which
	 * also suppresses the advisor auto-resume. */
	abort?(options?: {
		goalReason?: "interrupted" | "internal";
		reason?: string;
		preserveCompaction?: boolean;
	}): Promise<void>;
	runModeExitTeardown(teardown: () => Promise<void>): Promise<void>;
}

/**
 * Host-supplied pieces that are genuinely presentation or model-policy, not mode
 * state. A headless RPC host passes nothing; the TUI passes all of them.
 */
export interface OmpModeControllerOptions {
	session: OmpModeSession;
	/** Whether another mode currently blocks entry, and why. Defaults to none. */
	isVibeEnabled?(): boolean;
	/** Resolves the plan file path when the caller does not supply one. */
	resolvePlanFilePath?(): Promise<string>;
	/** Applies the plan-role model. Skipped when the host preserves the restored model. */
	applyPlanModeModel?(): Promise<void>;
	/** The model the session is on right now, for the plan-exit rollback. */
	capturePlanModelState?(): { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	/** Restores the model recorded before plan mode. */
	restorePlanPreviousModel?(previous: { model: Model; thinkingLevel?: ConfiguredThinkingLevel }): Promise<void>;
	/** True while the journal records a pre-plan model that the exit must restore. */
	planPreviousModelState?(): { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	/** Drops a queued plan-model switch, so leaving plan mode cannot land the plan model. */
	clearPendingPlanModelSwitch?(): void;
	/** Suppresses the next turn's cache-miss marker; the prompt changed. */
	invalidatePromptCache?(): void;
	/** TUI status line. */
	onStatus?(message: string): void;
	onWarning?(message: string): void;
	onError?(message: string): void;
	onModeChanged?(state: OmpModeState): void;
	/** Cancels a pending loop auto-resubmit / condition evaluation. */
	cancelLoopAutoSubmit?(): void;
	abortLoopCondition?(): void;
	/** Creates the loop limit runtime for parsed `/loop` args. */
	createLoopLimit?: (limit: unknown) => LoopLimitRuntime | undefined;
	/** Resets goal-continuation bookkeeping owned by the host. */
	resetGoalContinuation?(): void;
}

/**
 * The single owner of plan, goal and loop mode.
 *
 * `InteractiveMode` and RPC mode both drive mode changes through this class, so a
 * host can never journal a `mode_change` that the session's tools, model and mode
 * state do not actually reflect. The guard that rejects a second mode lives here
 * too, which is why the old copy-pasted "Exit plan mode first." literals are gone.
 */
export class OmpModeController {
	readonly #session: OmpModeSession;
	readonly #options: OmpModeControllerOptions;

	planModeEnabled = false;
	planModePaused = false;
	planModePlanFilePath: string | undefined = undefined;
	goalModeEnabled = false;
	goalModePaused = false;
	loopModeEnabled = false;
	loopModePaused = false;
	loopPrompt: string | undefined = undefined;
	loopLimit: LoopLimitRuntime | undefined = undefined;
	loopCondition: LoopConditionConfig | undefined = undefined;

	planModePreviousToolPresentation: { enabled: string[]; mounted: string[] } | undefined;
	planModeHasEntered = false;
	goalModePreviousTools: string[] | undefined;

	constructor(options: OmpModeControllerOptions) {
		this.#session = options.session;
		this.#options = options;
	}

	/** The current mode, derived from the flags rather than stored separately. */
	get mode(): OmpModeName {
		if (this.planModePaused) return "plan_paused";
		if (this.planModeEnabled) return "plan";
		if (this.goalModePaused) return "goal_paused";
		if (this.goalModeEnabled) return "goal";
		if (this.loopModeEnabled) return "loop";
		return "none";
	}

	/**
	 * Why `target` cannot be entered right now, or `true` when it can. The single
	 * source for every "Exit <mode> mode first." message in the tree.
	 */
	canEnter(target: "plan" | "goal" | "loop" | "vibe"): true | string {
		if (target === "plan") {
			if (this.goalModeEnabled || this.goalModePaused) return "Exit goal mode first.";
			if (this.#isVibeEnabled()) return "Exit vibe mode first.";
			return true;
		}
		if (target === "goal") {
			if (this.planModeEnabled) return "Exit plan mode first.";
			if (this.planModePaused) return "Plan mode is paused — run /plan again to fully exit.";
			if (this.#isVibeEnabled()) return "Exit vibe mode first.";
			return true;
		}
		if (target === "vibe") {
			if (this.planModeEnabled) return "Exit plan mode first.";
			if (this.planModePaused) return "Plan mode is paused — run /plan again to fully exit.";
			if (this.goalModeEnabled || this.goalModePaused) return "Exit goal mode first.";
			return true;
		}
		// Loop mode composes with the persisted modes: it is a turn-level repeat
		// policy, not a session mode, and the reset path guards it separately.
		return true;
	}

	#isVibeEnabled(): boolean {
		return this.#options.isVibeEnabled?.() ?? false;
	}

	snapshot(overrides: Partial<OmpModeState> = {}): OmpModeState {
		return {
			mode: this.mode,
			planModeEnabled: this.planModeEnabled,
			planModePaused: this.planModePaused,
			goalModeEnabled: this.goalModeEnabled,
			goalModePaused: this.goalModePaused,
			loopModeEnabled: this.loopModeEnabled,
			loopModePaused: this.loopModePaused,
			planFilePath: this.planModePlanFilePath,
			advisorEnabled: false,
			prewalkArmed: false,
			fastModeEnabled: false,
			hideThinking: false,
			...overrides,
		};
	}

	#changed(): void {
		this.#options.onModeChanged?.(this.snapshot());
	}

	#warn(message: string): void {
		this.#options.onWarning?.(message);
	}

	// ---------------------------------------------------------------- plan

	async enterPlan(options: {
		planFilePath?: string;
		workflow?: "parallel" | "iterative";
		preserveRestoredModel?: boolean;
	}): Promise<boolean> {
		if (this.planModeEnabled) return false;
		const blocked = this.canEnter("plan");
		if (blocked !== true) {
			this.#warn(blocked);
			return false;
		}
		this.planModePaused = false;
		const planFilePath = options.planFilePath ?? (await this.#options.resolvePlanFilePath?.());
		if (planFilePath === undefined) return false;

		const previousTools = this.#session.getEnabledToolNames();
		const previousMountedTools = this.#session.getMountedXdevToolNames();
		// `plan-mode-active.md` instructs the agent to draft the plan file with
		// `write` and refine it with `edit`, and plan approval is a `write` to
		// `xd://propose`. Both must be active or the agent falls back to `edit` on a
		// non-existent file and stalls, and cannot submit the plan. Only re-activate
		// `write` when the registry entry is the built-in write tool (issue #3165):
		// a shadowing extension named `write` must stay inactive, because plan mode's
		// read-only guarantee relies on the built-in write/edit guard.
		const planAugmentations: string[] = [];
		if (this.#session.hasBuiltInTool("write")) planAugmentations.push("write");
		const planTools = [...new Set([...previousTools, ...planAugmentations])];

		this.planModePreviousToolPresentation = {
			enabled: previousTools.filter(name => !isMCPToolName(name)),
			mounted: previousMountedTools.filter(name => !isMCPToolName(name)),
		};
		this.planModePlanFilePath = planFilePath;
		this.planModeEnabled = true;
		// Plan mode state must land before the tool partition: under Code Mode the
		// direct surface keeps `write` only while a transport needs it.
		const previousState = this.#session.getPlanModeState();
		this.#session.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: options.workflow ?? "parallel",
			reentry: this.planModeHasEntered,
		});
		try {
			await this.#session.setActiveToolsByName(planTools);
		} catch (error) {
			this.#session.setPlanModeState(previousState);
			this.planModeEnabled = false;
			throw error;
		}
		this.#session.setPlanProposalHandler(title => this.#session.preparePlanForReview(title));
		if (this.#session.isStreaming) {
			await this.#session.sendPlanModeContext({ deliverAs: "steer" });
		}
		this.planModeHasEntered = true;
		if (!options.preserveRestoredModel) {
			await this.#options.applyPlanModeModel?.();
		}
		this.#options.invalidatePromptCache?.();
		this.#session.sessionManager.appendModeChange("plan", { planFilePath });
		this.#changed();
		this.#options.onStatus?.(`Plan mode enabled. Plan file: ${planFilePath}`);
		return true;
	}

	async exitPlan(options?: {
		silent?: boolean;
		paused?: boolean;
		deferModelRestore?: boolean;
		interruptActiveTurn?: boolean;
	}): Promise<boolean> {
		if (!this.planModeEnabled) return false;
		if (options?.interruptActiveTurn && this.#session.isStreaming) {
			await this.#session.runModeExitTeardown(async () => {
				await this.#session.abort?.({ reason: USER_INTERRUPT_LABEL });
				await this.#teardownPlan(options);
			});
			return true;
		}
		await this.#teardownPlan(options);
		return true;
	}

	async #teardownPlan(options?: { silent?: boolean; paused?: boolean; deferModelRestore?: boolean }): Promise<void> {
		const planState = this.#session.getPlanModeState();
		const planTools = this.#session.getEnabledToolNames();
		const planMountedTools = this.#session.getMountedXdevToolNames();
		// Captured so a failed tool or model restore can roll the model back too:
		// leaving the previous model in place while the plan toolset is restored
		// would strand the session on the plan role after plan mode ended.
		const planModelState = this.#options.capturePlanModelState?.();
		this.#session.setPlanModeState(undefined);
		try {
			const previous = this.planModePreviousToolPresentation;
			if (previous) {
				await this.#session.restoreNonMCPToolPresentation(previous.enabled, previous.mounted);
			}
			const previousModel = this.#options.planPreviousModelState?.();
			if (previousModel && !options?.deferModelRestore) {
				await this.#options.restorePlanPreviousModel?.(previousModel);
			}
			// A plan-role model queued on entry (because the session was streaming)
			// must be dropped now: flushing it on the next turn would land the
			// session on the plan model after the user exited (issue #816).
			if (previousModel) this.#options.clearPendingPlanModelSwitch?.();
		} catch (error) {
			this.#session.setPlanModeState(planState);
			if (planModelState) {
				try {
					await this.#options.restorePlanPreviousModel?.(planModelState);
				} catch {
					// Best effort: the tool restore below is the observable contract.
				}
			}
			const enabled = this.#session.getEnabledToolNames();
			const mounted = this.#session.getMountedXdevToolNames();
			if (
				enabled.length !== planTools.length ||
				enabled.some((name, index) => name !== planTools[index]) ||
				mounted.length !== planMountedTools.length ||
				mounted.some((name, index) => name !== planMountedTools[index])
			) {
				await this.#session.setActiveToolPresentation(planTools, planMountedTools);
			}
			throw error;
		}
		this.#session.setPlanProposalHandler?.(null);
		this.planModeEnabled = false;
		this.planModePaused = options?.paused ?? false;
		this.planModePlanFilePath = undefined;
		this.planModePreviousToolPresentation = undefined;
		this.#options.invalidatePromptCache?.();
		this.#changed();
		const paused = options?.paused ?? false;
		this.#session.sessionManager.appendModeChange(paused ? "plan_paused" : "none");
		if (!options?.silent) {
			this.#options.onStatus?.(paused ? "Plan mode paused." : "Plan mode disabled.");
		}
	}

	// ---------------------------------------------------------------- goal

	async enterGoal(options: { objective?: string; resume?: boolean; silent?: boolean }): Promise<boolean> {
		if (this.goalModeEnabled) return false;
		const blocked = this.canEnter("goal");
		if (blocked !== true) {
			this.#warn(blocked);
			return false;
		}
		// The guided-goal interview records the baseline before adding the goal tool,
		// then a tool-driven create reaches this method later. Adopting an existing
		// baseline keeps the goal tool out of the restore set; overwriting it here
		// would snapshot a set that already contains goal and leak the tool on exit.
		const previousTools = this.#session.getEnabledToolNames().filter(name => name !== "goal");
		this.goalModePreviousTools ??= previousTools;
		const goalTools = [...new Set([...previousTools, "goal"])];
		this.goalModePaused = false;
		const state = options.resume
			? await this.#session.goalRuntime.resumeGoal()
			: await this.#session.goalRuntime.createGoal({ objective: options.objective ?? "" });
		await this.#session.setActiveToolsByName(goalTools);
		this.#session.setGoalModeState(state);
		this.goalModeEnabled = true;
		this.#options.resetGoalContinuation?.();
		if (this.#session.isStreaming) {
			await this.#session.sendGoalModeContext({ deliverAs: "steer" });
		}
		this.#changed();
		if (!options.silent) {
			this.#options.onStatus?.(options.resume ? "Goal mode resumed." : "Goal mode enabled.");
		}
		return true;
	}

	async exitGoal(options?: {
		silent?: boolean;
		paused?: boolean;
		reason?: "completed" | "paused" | "dropped";
	}): Promise<boolean> {
		const previousTools = this.goalModePreviousTools;
		if (this.goalModeEnabled && previousTools) {
			await this.#session.setActiveToolsByName(previousTools);
		}
		if (options?.reason === "completed") {
			this.#session.setGoalModeState(undefined);
			this.#session.sessionManager.appendModeChange("none");
		}
		this.goalModeEnabled = false;
		this.goalModePaused = options?.paused ?? false;
		this.goalModePreviousTools = undefined;
		this.#options.resetGoalContinuation?.();
		this.#changed();
		if (!options?.silent) {
			if (options?.reason === "completed") this.#options.onStatus?.("Goal mode completed.");
			else if (options?.reason === "dropped") this.#options.onStatus?.("Goal dropped.");
			else if (options?.paused) this.#options.onStatus?.("Goal mode paused.");
			else this.#options.onStatus?.("Goal mode disabled.");
		}
		return true;
	}

	// ---------------------------------------------------------------- loop

	/** Handles `/loop` text. Returns the inline prompt to submit, if any. */
	handleLoopCommand(args = ""): string | undefined {
		if (this.loopModeEnabled) {
			this.disableLoopMode();
			return undefined;
		}
		const parsed = parseLoopArgs(args);
		if (typeof parsed === "string") {
			this.#options.onError?.(parsed);
			return undefined;
		}
		this.loopModeEnabled = true;
		this.loopModePaused = false;
		this.loopPrompt = undefined;
		this.loopLimit = (this.#options.createLoopLimit ?? createLoopLimitRuntime)(parsed.limit);
		this.loopCondition = parsed.condition;
		this.#changed();
		const limitSuffix = parsed.limit ? ` Limited to ${describeLoopLimit(parsed.limit)}.` : "";
		const remainingSuffix = this.loopLimit ? ` ${describeLoopLimitRuntime(this.loopLimit)}.` : "";
		const conditionSuffix = parsed.condition ? ` Continuing ${describeLoopCondition(parsed.condition)}.` : "";
		const tail = parsed.prompt ? "Repeating it after each turn." : "Your next prompt will repeat after each turn.";
		this.#options.onStatus?.(
			`Loop mode enabled.${limitSuffix}${remainingSuffix}${conditionSuffix} ${tail} Esc suspends the ongoing loop; /loop again to disable.`,
		);
		return parsed.prompt;
	}

	/**
	 * Drops every transient mode flag before a session restore, restoring the
	 * tool presentation each mode captured on entry. Does not journal a
	 * `mode_change`: the caller reconciles against the journal afterwards.
	 */
	async clearTransientState(): Promise<void> {
		if (this.planModeEnabled || this.planModePaused) {
			this.#session.setPlanModeState(undefined);
			try {
				const previous = this.planModePreviousToolPresentation;
				if (previous) {
					await this.#session.restoreNonMCPToolPresentation(previous.enabled, previous.mounted);
				}
			} finally {
				this.#session.setPlanProposalHandler?.(null);
				this.planModeEnabled = false;
				this.planModePaused = false;
				this.planModePlanFilePath = undefined;
				this.planModePreviousToolPresentation = undefined;
				this.#changed();
			}
		}
		if (this.goalModeEnabled || this.goalModePaused) {
			if (this.goalModePreviousTools !== undefined) {
				await this.#session.setActiveToolsByName(this.goalModePreviousTools);
			}
			this.#session.setGoalModeState(undefined);
			this.goalModeEnabled = false;
			this.goalModePaused = false;
			this.goalModePreviousTools = undefined;
			this.#options.resetGoalContinuation?.();
			this.#changed();
		}
	}

	/**
	 * Re-arms the `goal` tool after a resume. `sdk.ts` excludes `goal` from the
	 * initial active tool set unconditionally, so a restored goal cannot be
	 * completed, resumed or dropped without this.
	 */
	/**
	 * Records the pre-interview toolset for the guided-goal flow, which exposes the
	 * goal tool without entering goal mode so the agent can interview first.
	 */
	recordGoalToolBaseline(): string[] {
		this.goalModePreviousTools ??= this.#session.getEnabledToolNames().filter(name => name !== "goal");
		return this.goalModePreviousTools;
	}

	async rearmGoalTool(): Promise<void> {
		const previousTools = this.#session.getEnabledToolNames().filter(name => name !== "goal");
		this.goalModePreviousTools = previousTools;
		await this.#session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
	}

	/** Marks a resumed goal's enabled/paused flags without re-running the entry. */
	adoptGoalState(enabled: boolean, paused: boolean, state: GoalModeState): void {
		this.goalModeEnabled = enabled;
		this.goalModePaused = paused;
		this.#session.setGoalModeState(state);
		this.#changed();
	}

	/** Marks a journal-recorded plan_paused session, which has no live tools to re-arm. */
	adoptPausedPlan(): void {
		this.planModePaused = true;
		this.planModeHasEntered = true;
		this.#changed();
	}

	setLoopPrompt(prompt: string): void {
		if (!this.loopModeEnabled) return;
		this.#options.abortLoopCondition?.();
		this.loopPrompt = prompt;
		this.loopModePaused = false;
		this.#changed();
	}

	pauseLoop(): void {
		this.loopPrompt = undefined;
		this.loopModePaused = true;
		this.#options.cancelLoopAutoSubmit?.();
		this.#options.abortLoopCondition?.();
		this.#changed();
	}

	disableLoopMode(message = "Loop mode disabled."): void {
		const wasEnabled = this.loopModeEnabled;
		this.loopModeEnabled = false;
		this.loopModePaused = false;
		this.loopPrompt = undefined;
		this.loopLimit = undefined;
		this.loopCondition = undefined;
		this.#options.cancelLoopAutoSubmit?.();
		this.#options.abortLoopCondition?.();
		this.#changed();
		if (wasEnabled) this.#options.onStatus?.(message);
	}
}
