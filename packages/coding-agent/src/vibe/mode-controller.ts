import { logger } from "@oh-my-pi/pi-utils";
import type { VibeScreenSnapshot } from "@oh-my-pi/pi-tui/tools/vibe";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload,
} from "../task";
import type { AgentSession } from "../session/agent-session";
import type { ToolSession } from "../tools";
import type { EventBus } from "../utils/event-bus";
import { VibeSessionRegistry, type VibeOwnerScope, type VibeParentSession } from "./runtime";

export interface VibeWorkerSnapshot {
	id: string;
	cli: "fast" | "good";
	name: string;
	state: "initializing" | "running" | "idle" | "dead";
	turnCount: number;
	queuedMessages: number;
	resolvedModel?: string;
	lastActivity?: string;
	currentTool?: string;
	outputTail: string[];
	lastTurnStatus: "running" | "completed" | "failed" | "cancelled" | "idle";
	createdAt: number;
	lastActivityAt: number;
}

export interface VibeModeState {
	revision: number;
	enabled: boolean;
	workers: VibeWorkerSnapshot[];
}

export type VibeStateResult = VibeModeState;
export type VibeEnterResult = { enabled: true; accepted: boolean };
export type VibeExitResult = { enabled: false; killedWorkers: number };
export type VibeSpawnResult = VibeWorkerSnapshot;
export type VibeSendResult = { delivery: "steered" | "started" | "queued" };
export type VibeWaitResult = {
	settled: Array<{
		id: string;
		jobId: string;
		status: "completed" | "failed" | "cancelled";
		resultText: string;
	}>;
	stillRunning: string[];
	timedOut: boolean;
};
export type VibeKillResult = VibeWorkerSnapshot;
export type VibeListResult = VibeWorkerSnapshot[];

export type VibeModeSession = Pick<
	AgentSession,
	| "sessionManager"
	| "settings"
	| "isStreaming"
	| "abort"
	| "getEnabledToolNames"
	| "hasBuiltInTool"
	| "activateVibeTools"
	| "deactivateVibeTools"
	| "removeVibeToolsPreservingActive"
	| "setVibeModeState"
	| "getVibeModeState"
	| "sendVibeModeContext"
	| "runModeExitTeardown"
	| "getAgentId"
>;

export interface VibeModeControllerOptions {
	session: VibeModeSession;
	toolSession: ToolSession;
	registry?: VibeSessionRegistry;
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
	onState?: (state: VibeModeState) => void | Promise<void>;
	onEntered?: () => void | Promise<void>;
	onExited?: (result: VibeExitResult) => void | Promise<void>;
	onBlocked?: (message: string) => void;
	canEnter?: () => true | string;
	dispatchPrompt?: (prompt: string) => Promise<boolean>;
}

function scopeIdentity(scope: VibeOwnerScope): string {
	return `${scope.ownerId}\0${scope.parentSessionId}\0${scope.parentSessionFile ?? ""}`;
}

function sameScope(left: VibeOwnerScope | undefined, right: VibeOwnerScope): boolean {
	return left !== undefined && scopeIdentity(left) === scopeIdentity(right);
}

function persistedToolNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every(name => typeof name === "string")) return undefined;
	return [...(value as string[])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isLifecyclePayload(value: unknown): value is SubagentLifecyclePayload {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.agent === "string" &&
		typeof value.agentSource === "string" &&
		typeof value.index === "number" &&
		(value.status === "started" || value.status === "completed" || value.status === "failed" || value.status === "aborted")
	);
}

function progressIdentity(value: unknown): string | undefined {
	if (!isRecord(value) || !isRecord(value.progress)) return undefined;
	const progressId = value.progress.id;
	if (typeof progressId !== "string" || progressId.length === 0) return undefined;
	if (value.id !== undefined && value.id !== progressId) return undefined;
	return progressId;
}

/** Shared owner of the Vibe mode transition and its canonical worker state. */
export class VibeModeController {
	readonly #session: VibeModeSession;
	readonly #toolSession: ToolSession;
	readonly #registry: VibeSessionRegistry;
	readonly #options: VibeModeControllerOptions;
	readonly #eventBus: EventBus | undefined;
	readonly #subagentEventBus: EventBus | undefined;
	readonly #unsubscribers: Array<() => void> = [];
	readonly #rehydratedScopes = new Set<string>();
	readonly #activeLifecycleIds = new Set<string>();
	#enabled = false;
	#previousTools: string[] | undefined;
	#ownerScope: VibeOwnerScope | undefined;
	#entry: Promise<VibeEnterResult> | undefined;
	#scopeSuspendedForSwitch = false;
	#revision = 0;
	#workers: VibeWorkerSnapshot[] = [];
	#lastEmitted?: string;

	constructor(options: VibeModeControllerOptions) {
		this.#options = options;
		this.#session = options.session;
		this.#toolSession = options.toolSession;
		this.#registry = options.registry ?? VibeSessionRegistry.global();
		this.#eventBus = options.eventBus ?? options.toolSession.eventBus;
		this.#subagentEventBus = options.subagentEventBus ?? options.toolSession.subagentEventBus;
		this.#subscribe(TASK_SUBAGENT_LIFECYCLE_CHANNEL, value => this.#handleLifecycle(value));
		this.#subscribe(TASK_SUBAGENT_PROGRESS_CHANNEL, value => this.#handleProgress(value));
	}


	get isEnabled(): boolean {
		return this.#enabled;
	}
	get isEntering(): boolean {
		return this.#entry !== undefined;
	}

	#subscribe(channel: string, handler: (value: unknown) => void): void {
		const seen = new WeakSet<object>();
		const dedupe = (value: unknown): void => {
			if (isRecord(value)) {
				if (seen.has(value)) return;
				seen.add(value);
			}
			handler(value);
		};
		for (const bus of new Set([this.#eventBus, this.#subagentEventBus])) {
			if (bus) this.#unsubscribers.push(bus.on(channel, dedupe));
		}
	}

	#parentSession(): ToolSession & VibeParentSession {
		return {
			...this.#toolSession,
			sessionManager: this.#session.sessionManager,
			getSessionFile: () => this.#session.sessionManager.getSessionFile() ?? null,
			getSessionId: () => this.#session.sessionManager.getSessionId(),
			getAgentId: () => this.#session.getAgentId() ?? null,
			getActiveModelString: () => this.#toolSession.getActiveModelString?.(),
			getModelString: () => this.#toolSession.getModelString?.(),
		};
	}

	#currentScope(): VibeOwnerScope {
		return this.#registry.ownerScope(this.#parentSession());
	}

	#toSnapshot(screen: VibeScreenSnapshot): VibeWorkerSnapshot {
		return {
			id: screen.id,
			cli: screen.cli,
			name: screen.name ?? screen.id,
			state: screen.state === "starting" ? "initializing" : screen.state,
			turnCount: screen.turns,
			queuedMessages: screen.queued,
			resolvedModel: screen.model,
			lastActivity: screen.lastActivity,
			currentTool: screen.currentTool,
			outputTail: [...screen.outputTail],
			lastTurnStatus: screen.lastTurnStatus ?? (screen.turns > 0 ? "completed" : "idle"),
			createdAt: screen.createdAt ?? screen.lastActivityAt,
			lastActivityAt: screen.lastActivityAt,
		};
	}

	#snapshot(id: string): VibeWorkerSnapshot {
		const snapshot = this.#registry.screens(this.#parentSession(), [id])[0];
		if (!snapshot) throw new Error(`Unknown vibe session "${id}".`);
		return this.#toSnapshot(snapshot);
	}

	#readWorkers(): VibeWorkerSnapshot[] {
		return this.#registry.screens(this.#parentSession()).map(screen => this.#toSnapshot(screen));
	}

	#state(): VibeModeState {
		return { revision: this.#revision, enabled: this.#enabled, workers: this.#workers.map(worker => ({ ...worker })) };
	}

	#emitStateIfChanged(): void {
		const workers = this.#readWorkers();
		const fingerprint = JSON.stringify({ enabled: this.#enabled, workers });
		this.#workers = workers;
		if (fingerprint === this.#lastEmitted) return;
		this.#lastEmitted = fingerprint;
		this.#revision++;
		const state = this.#state();
		void Promise.resolve(this.#options.onState?.(state)).catch(error => {
			logger.warn("Vibe state callback failed", { error: error instanceof Error ? error.message : String(error) });
		});
	}

	#handleLifecycle(value: unknown): void {
		if (!isLifecyclePayload(value)) return;
		if (!this.#workers.some(worker => worker.id === value.id)) return;
		if (value.status === "started") this.#activeLifecycleIds.add(value.id);
		else this.#activeLifecycleIds.delete(value.id);
		this.#emitStateIfChanged();
	}

	#handleProgress(value: unknown): void {
		const id = progressIdentity(value);
		if (!id || !this.#activeLifecycleIds.has(id)) return;
		if (!this.#workers.some(worker => worker.id === id)) return;
		if (!isRecord(value) || typeof value.agent !== "string" || typeof value.agentSource !== "string") return;
		this.#emitStateIfChanged();
	}

	async #restorePersistedMode(): Promise<void> {
		const mode = this.#session.sessionManager.buildSessionContext().mode;
		if (mode === "vibe") {
			this.#ownerScope ??= this.#currentScope();
			this.#enabled = true;
			if (!this.#session.getVibeModeState()?.enabled) {
				const previousTools = this.#session.getEnabledToolNames();
				const baseTools = ["read"];
				if (this.#session.hasBuiltInTool("todo")) baseTools.push("todo");
				await this.#session.activateVibeTools(baseTools);
				this.#previousTools = previousTools;
				this.#session.setVibeModeState({ enabled: true });
				if (this.#session.isStreaming) await this.#session.sendVibeModeContext({ deliverAs: "steer" });
			}
		} else if (mode === "none" || mode === "plan" || mode === "plan_paused" || mode === "goal" || mode === "goal_paused") {
			this.#enabled = false;
		}
	}

	async getState(): Promise<VibeStateResult> {
		const scope = this.#currentScope();
		const identity = scopeIdentity(scope);
		if (!this.#rehydratedScopes.has(identity)) {
			this.#rehydratedScopes.add(identity);
			await this.#registry.rehydrate(this.#parentSession());
		}
		await this.#restorePersistedMode();
		this.#emitStateIfChanged();
		return this.#state();
	}

	async list(): Promise<VibeListResult> {
		this.#workers = this.#readWorkers();
		return this.#workers.map(worker => ({ ...worker }));
	}

	async #enter(prompt: string | undefined, options?: { persistModeChange?: boolean; previousTools?: string[] }): Promise<VibeEnterResult> {
		if (this.#entry) {
			await this.#entry;
			const accepted = prompt !== undefined && this.#options.dispatchPrompt ? await this.#options.dispatchPrompt(prompt) : false;
			return { enabled: true, accepted };
		}
		const entry = this.#enterLocked(prompt, options);
		this.#entry = entry;
		try {
			return await entry;
		} finally {
			if (this.#entry === entry) this.#entry = undefined;
		}
	}

	async #enterLocked(
		prompt: string | undefined,
		options?: { persistModeChange?: boolean; previousTools?: string[] },
	): Promise<VibeEnterResult> {
		const blocked = this.#options.canEnter?.();
		if (typeof blocked === "string") {
			this.#options.onBlocked?.(blocked);
			throw new Error(blocked);
		}
		if (this.#enabled && this.#session.getVibeModeState()?.enabled) {
			const accepted = prompt !== undefined && this.#options.dispatchPrompt ? await this.#options.dispatchPrompt(prompt) : false;
			return { enabled: true, accepted };
		}
		const scope = this.#currentScope();
		this.#registry.activateScope(scope);
		const previousTools = options?.previousTools ?? this.#session.getEnabledToolNames();
		const baseTools = ["read"];
		if (this.#session.hasBuiltInTool("todo")) baseTools.push("todo");
		await this.#session.activateVibeTools(baseTools);
		this.#previousTools = previousTools;
		this.#ownerScope = scope;
		this.#enabled = true;
		this.#rehydratedScopes.add(scopeIdentity(scope));
		this.#activeLifecycleIds.clear();
		this.#session.setVibeModeState({ enabled: true });
		if (this.#session.isStreaming) await this.#session.sendVibeModeContext({ deliverAs: "steer" });
		if (options?.persistModeChange !== false) {
			this.#session.sessionManager.appendModeChange("vibe", { previousTools });
		}
		this.#emitStateIfChanged();
		await this.#options.onEntered?.();
		const accepted = prompt !== undefined && this.#options.dispatchPrompt ? await this.#options.dispatchPrompt(prompt) : false;
		return { enabled: true, accepted };
	}

	async enter(prompt?: string): Promise<VibeEnterResult> {
		return this.#enter(prompt);
	}

	async exit(): Promise<VibeExitResult> {
		if (!this.#enabled) return { enabled: false, killedWorkers: 0 };
		let killedWorkers = 0;
		const scope = this.#ownerScope;
		await this.#session.runModeExitTeardown(async () => {
			if (this.#session.isStreaming) await this.#session.abort();
			killedWorkers = await this.#registry.killAll(this.#parentSession(), scope);
			await this.#session.deactivateVibeTools(this.#previousTools ?? []);
			this.#session.setVibeModeState(undefined);
		});
		this.#enabled = false;
		this.#previousTools = undefined;
		this.#ownerScope = undefined;
		this.#activeLifecycleIds.clear();
		this.#emitStateIfChanged();
		const result = { enabled: false, killedWorkers } as const;
		await this.#options.onExited?.(result);
		return result;
	}

	async spawn(args: { cli: "fast" | "good"; name?: string; prompt: string }): Promise<VibeSpawnResult> {
		await this.getState();
		const outcome = await this.#registry.spawn(this.#toolSession, args);
		this.#activeLifecycleIds.add(outcome.id);
		this.#emitStateIfChanged();
		return this.#snapshot(outcome.id);
	}

	async send(args: { session: string; message: string }): Promise<VibeSendResult> {
		const outcome = await this.#registry.send(this.#toolSession, args);
		if (outcome.mode === "turn") this.#activeLifecycleIds.add(outcome.id);
		this.#emitStateIfChanged();
		return { delivery: outcome.mode === "turn" ? "started" : outcome.mode };
	}

	async wait(input: { sessions?: string[]; timeoutMs?: number }): Promise<VibeWaitResult> {
		const result = await this.#registry.wait(this.#toolSession, input);
		this.#emitStateIfChanged();
		return result;
	}

	async kill(input: { session: string }): Promise<VibeKillResult> {
		await this.#registry.kill(this.#toolSession, input.session);
		this.#activeLifecycleIds.delete(input.session);
		this.#emitStateIfChanged();
		return this.#snapshot(input.session);
	}

	async suspendForSessionSwitch(): Promise<void> {
		if (!this.#enabled || !this.#ownerScope) return;
		await this.#registry.suspendScope(this.#ownerScope, this.#toolSession.asyncJobManager);
		this.#scopeSuspendedForSwitch = true;
	}

	async reconcileSession(sessionContext: { mode: string; modeData?: unknown }): Promise<void> {
		const scopeSuspended = this.#scopeSuspendedForSwitch;
		this.#scopeSuspendedForSwitch = false;
		const targetScope = this.#currentScope();
		const preserve = this.#enabled && sessionContext.mode === "vibe" && sameScope(this.#ownerScope, targetScope);
		const toolsetLostToTeardown = this.#enabled && !preserve;
		if (this.#enabled && !preserve) {
			const oldScope = this.#ownerScope;
			await this.#session.removeVibeToolsPreservingActive();
			this.#session.setVibeModeState(undefined);
			this.#enabled = false;
			this.#previousTools = undefined;
			this.#ownerScope = undefined;
			this.#activeLifecycleIds.clear();
			if (oldScope && !scopeSuspended) await this.#registry.suspendScope(oldScope, this.#toolSession.asyncJobManager);
			this.#emitStateIfChanged();
		}
		if (sessionContext.mode === "vibe") this.#rehydratedScopes.delete(scopeIdentity(targetScope));
		await this.getState();
		if (sessionContext.mode === "vibe" && !preserve && toolsetLostToTeardown) {
			const previousTools = persistedToolNames(isRecord(sessionContext.modeData) ? sessionContext.modeData.previousTools : undefined);
			if (previousTools !== undefined) this.#previousTools = previousTools;
		}
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
	}
}
