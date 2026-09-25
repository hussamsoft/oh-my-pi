/**
 * `run_slash_command` for RPC mode.
 *
 * The whole point of this module is that a host can reach *every* builtin slash
 * command, including the ones only a terminal UI could ever drive. The ACP
 * executor cannot do that job on its own: `executeAcpBuiltinSlashCommand` hard
 * -returns `false` for a spec that only has `handleTui`, because it has no way
 * to synthesise an `InteractiveModeContext`. Dropping those names on the floor
 * would make `/git`, `/settings`, `/setup` and friends invisible to a GUI, so
 * this dispatcher recognises them and hands the host an overlay descriptor
 * instead of pretending they do not exist.
 *
 * Two invariants worth stating because they are easy to break:
 *
 * 1. The overlay branch never calls the executor. A `handleTui` handler
 *    dereferences `runtime.ctx` and would either throw or, worse, half-render
 *    against a context the RPC host never built. `handleTui` is also given no
 *    path to the JSON channel, so running it would be invisible to the client.
 * 2. Command output is buffered, never written to stdout. In RPC mode stdout
 *    *is* the JSON channel — a bare string there corrupts the frame stream.
 *    Output is forwarded to the caller's `runtime.output` (so a host can still
 *    stream it) and accumulated for the `consumed` result. A caller that wants
 *    collection only passes a no-op `output`.
 */

import type { AcpBuiltinSlashCommandResult } from "../../slash-commands/acp-builtins";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { type SlashCommandSpec, lookupBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import type { SlashCommandRuntime } from "../../slash-commands/types";
import type { RpcSlashCommandResult } from "./rpc-types";

/** Machine-readable rejection reason; the RPC layer turns this into `RpcResponse.code`. */
export type RpcSlashCommandErrorCode =
	/** The name was empty (or nothing but a separator) once normalised. */
	| "invalid_command"
	/** No builtin — and no alias — carries that name. */
	| "unknown_command"
	/**
	 * The name resolved, but nothing could run it here: either the spec carries
	 * neither `handle` nor `handleTui` (a registry invariant violation), or the
	 * executor declined a spec that does have a `handle`. The latter means the
	 * name we looked up and the text we handed the executor disagree, so it is
	 * reported rather than papered over as a no-op.
	 */
	| "not_executable"
	/** The handler threw. `error` carries its message. */
	| "command_failed";

/** Success carries the wire result; failure carries a code the host can branch on. */
export type RunRpcSlashCommandResult =
	| { ok: true; data: RpcSlashCommandResult }
	| { ok: false; code: RpcSlashCommandErrorCode; error: string };

/** Signature of `executeAcpBuiltinSlashCommand`, named so callers can type their own doubles. */
export type SlashCommandExecutor = (
	text: string,
	runtime: SlashCommandRuntime,
) => Promise<AcpBuiltinSlashCommandResult>;

/** Injection seams. Defaults are the real registry and the real ACP executor. */
export interface RunRpcSlashCommandOverrides {
	lookup?: (name: string) => SlashCommandSpec | undefined;
	execute?: SlashCommandExecutor;
}

/**
 * Strip a leading `/` (hosts send both `git` and `/git`) and re-parse through
 * the same helper the text dispatchers use, so a name split by whitespace or
 * `:` is cut at exactly the point every other slash entry point cuts it.
 *
 * Returns the parsed name plus the arguments the host supplied inline
 * (`"git HEAD"`), or `null` when nothing is left to look up.
 */
export function normalizeSlashCommandName(command: string): { name: string; inlineArgs: string } | null {
	const parsed = parseSlashCommand(`/${command.trim().replace(/^\/+/, "")}`);
	if (!parsed) return null;
	return { name: parsed.name, inlineArgs: parsed.args };
}

/**
 * Run one builtin slash command for an RPC host.
 *
 * @param command Command name, with or without the leading `/`.
 * @param args Arguments after the name, or `undefined`. Arguments written
 *   inline in `command` are kept and prepended, so neither spelling loses data.
 * @param runtime Text-mode runtime. Its `output` is wrapped, never called with
 *   anything that could reach stdout on its own.
 */
export async function runRpcSlashCommand(
	command: string,
	args: string | undefined,
	runtime: SlashCommandRuntime,
	overrides: RunRpcSlashCommandOverrides = {},
): Promise<RunRpcSlashCommandResult> {
	const lookup = overrides.lookup ?? lookupBuiltinSlashCommand;
	const execute = overrides.execute ?? executeAcpBuiltinSlashCommand;

	const normalized = normalizeSlashCommandName(command);
	if (!normalized) return { ok: false, code: "invalid_command", error: "Slash command name is empty" };

	const spec = lookup(normalized.name);
	if (!spec) {
		return { ok: false, code: "unknown_command", error: `Unknown slash command: /${normalized.name}` };
	}

	// Overlay path. A spec with `handle` is runnable headlessly and takes
	// precedence — `handleTui` is the TUI's override of a command that already
	// works without a terminal.
	if (!spec.handle && spec.handleTui) {
		// `spec.name`, not the requested string, so an alias answers with the
		// canonical name a host can key its surfaces off (`providers` → `setup`).
		return { ok: true, data: { outcome: "overlay", overlay: spec.name } };
	}

	const explicitArgs = args?.trim() ?? "";
	if (!spec.handle) {
		return {
			ok: false,
			code: "not_executable",
			error: `Slash command /${spec.name} has no handler`,
		};
	}

	const mergedArgs = [normalized.inlineArgs, explicitArgs].filter(Boolean).join(" ");
	const text = mergedArgs ? `/${spec.name} ${mergedArgs}` : `/${spec.name}`;

	const chunks: string[] = [];
	const capturing: SlashCommandRuntime = {
		...runtime,
		output: async (text: string) => {
			chunks.push(text);
			await runtime.output(text);
		},
	};

	try {
		const result = await execute(text, capturing);
		if (result === false) {
			// Unreachable through the real executor: we only get here with a
			// `handle`, and we pass the canonical name the registry resolved.
			// Reachable when the two disagree, which is worth surfacing instead
			// of reporting a silent no-op the host would read as "done".
			return {
				ok: false,
				code: "not_executable",
				error: `Slash command /${spec.name} was resolved but not executed`,
			};
		}
		if ("prompt" in result) return { ok: true, data: { outcome: "prompt", prompt: result.prompt } };
		return {
			ok: true,
			data: { outcome: "consumed", agentInvoked: result.agentInvoked, output: chunks.join("\n") },
		};
	} catch (err) {
		return {
			ok: false,
			code: "command_failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
