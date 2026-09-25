import { describe, expect, mock, test } from "bun:test";
import { normalizeSlashCommandName, runRpcSlashCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-slash";
import type { SlashCommandExecutor } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-slash";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { AcpBuiltinSlashCommandResult } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

type ExecuteImpl = (
	text: string,
	runtime: SlashCommandRuntime,
) => AcpBuiltinSlashCommandResult | Promise<AcpBuiltinSlashCommandResult>;

/**
 * The minimum `SlashCommandRuntime`. Only `output` is reachable on the paths
 * this module drives, so it is the only member given behaviour; the rest are
 * placeholders, which keeps the test honest about what a host actually provides.
 */
function makeRuntime() {
	const streamed: string[] = [];
	const runtime = {
		session: {} as never,
		sessionManager: {} as never,
		settings: {} as never,
		cwd: "/tmp",
		output: (text: string) => {
			streamed.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	} satisfies SlashCommandRuntime;
	return { runtime, streamed };
}

/** An executor double that records the exact text it was handed. */
function spyExecute(impl: ExecuteImpl) {
	const calls: Array<{ text: string; runtime: SlashCommandRuntime }> = [];
	const execute: SlashCommandExecutor = async (text, runtime) => {
		calls.push({ text, runtime });
		return await impl(text, runtime);
	};
	return { calls, execute, text: (index = 0) => calls[index]?.text };
}

const consumed: ExecuteImpl = () => ({ consumed: true });

describe("runRpcSlashCommand", () => {
	test("rejects an unknown name with a machine-readable code", async () => {
		const { runtime } = makeRuntime();
		const result = await runRpcSlashCommand("definitely-not-a-command", undefined, runtime);
		expect(result).toEqual({
			ok: false,
			code: "unknown_command",
			error: "Unknown slash command: /definitely-not-a-command",
		});
	});

	test("rejects an empty name before touching the registry", async () => {
		const { runtime } = makeRuntime();
		const lookup = mock((_name: string) => undefined);
		const result = await runRpcSlashCommand("/", undefined, runtime, { lookup });
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.code).toBe("invalid_command");
		expect(lookup).not.toHaveBeenCalled();
	});

	// The load-bearing case: /git, /settings, /setup, /hotkeys and ~40 others
	// have no `handle`, so the ACP executor returns `false` for them. A host
	// still has to learn they exist.
	test("a handleTui-only command returns an overlay and never reaches the executor", async () => {
		const { runtime, streamed } = makeRuntime();
		const spec = lookupBuiltinSlashCommand("git");
		expect(spec?.handle).toBeUndefined();
		expect(spec?.handleTui).toBeDefined();

		const spy = spyExecute(() => false);
		const result = await runRpcSlashCommand("git", undefined, runtime, { execute: spy.execute });

		expect(result).toEqual({ ok: true, data: { outcome: "overlay", overlay: "git" } });
		expect(spy.calls).toHaveLength(0);
		expect(streamed).toEqual([]);
	});

	test("the overlay name is canonical, not the requested alias", async () => {
		const { runtime } = makeRuntime();
		const result = await runRpcSlashCommand("rewind", undefined, runtime);
		expect(result.ok && result.data).toEqual({ outcome: "overlay", overlay: "branch" });
	});

	test("every handleTui-only builtin answers with an overlay, not an error", async () => {
		const tuiOnly = ["settings", "setup", "hotkeys", "git", "plan", "queue", "exit", "quit"];
		for (const name of tuiOnly) {
			const { runtime } = makeRuntime();
			expect(lookupBuiltinSlashCommand(name)?.handle).toBeUndefined();
			const result = await runRpcSlashCommand(name, undefined, runtime);
			expect(result.ok).toBe(true);
			expect(result.ok && result.data.outcome).toBe("overlay");
		}
	});

	test("a spec with `handle` is executed, not reported as an overlay", async () => {
		const { runtime } = makeRuntime();
		// /model carries both handlers; the text one must win headlessly.
		expect(lookupBuiltinSlashCommand("model")?.handle).toBeDefined();

		const spy = spyExecute(consumed);
		const result = await runRpcSlashCommand("model", undefined, runtime, { execute: spy.execute });
		expect(spy.calls).toHaveLength(1);
		expect(result.ok && result.data.outcome).toBe("consumed");
	});

	test("consumed maps the handler output into the result and streams it", async () => {
		const { runtime, streamed } = makeRuntime();
		const spy = spyExecute(async (_text, rt) => {
			await rt.output("first line");
			await rt.output("second line");
			return { consumed: true as const, agentInvoked: true };
		});
		const result = await runRpcSlashCommand("changelog", undefined, runtime, { execute: spy.execute });
		expect(result).toEqual({
			ok: true,
			data: { outcome: "consumed", agentInvoked: true, output: "first line\nsecond line" },
		});
		// Streamed to the caller's sink, never to stdout.
		expect(streamed).toEqual(["first line", "second line"]);
	});

	test("a `{ prompt }` result becomes the prompt outcome", async () => {
		const { runtime } = makeRuntime();
		const spy = spyExecute(() => ({ prompt: "do the thing" }));
		const result = await runRpcSlashCommand("force", "read the file", runtime, { execute: spy.execute });
		expect(result).toEqual({ ok: true, data: { outcome: "prompt", prompt: "do the thing" } });
	});

	test("an executor that declines a spec it was given is reported, not swallowed", async () => {
		const { runtime } = makeRuntime();
		const spy = spyExecute(() => false);
		const result = await runRpcSlashCommand("changelog", undefined, runtime, { execute: spy.execute });
		expect(result).toEqual({
			ok: false,
			code: "not_executable",
			error: "Slash command /changelog was resolved but not executed",
		});
		expect(spy.calls).toHaveLength(1);
	});

	test("a spec with neither handler is reported rather than silently overlaid", async () => {
		const { runtime } = makeRuntime();
		const lookup = mock((_name: string) => ({ name: "ghost", description: "" }));
		const result = await runRpcSlashCommand("ghost", undefined, runtime, { lookup });
		expect(result).toEqual({
			ok: false,
			code: "not_executable",
			error: "Slash command /ghost has no handler",
		});
	});

	test("a handler that throws becomes a typed rejection carrying its message", async () => {
		const { runtime } = makeRuntime();
		const spy = spyExecute(() => {
			throw new Error("boom");
		});
		const result = await runRpcSlashCommand("changelog", undefined, runtime, { execute: spy.execute });
		expect(result).toEqual({ ok: false, code: "command_failed", error: "boom" });
	});

	test("a non-Error throw is stringified rather than lost", async () => {
		const { runtime } = makeRuntime();
		const spy = spyExecute(() => {
			throw "just a string";
		});
		const result = await runRpcSlashCommand("changelog", undefined, runtime, { execute: spy.execute });
		expect(result.ok === false && result.error).toBe("just a string");
	});

	describe("name normalisation", () => {
		test("a leading slash is optional and changes nothing", async () => {
			const withSlash = spyExecute(consumed);
			const withoutSlash = spyExecute(consumed);
			const { runtime } = makeRuntime();

			const a = await runRpcSlashCommand("/changelog", undefined, runtime, { execute: withSlash.execute });
			const b = await runRpcSlashCommand("changelog", undefined, runtime, { execute: withoutSlash.execute });

			expect(a).toEqual(b);
			expect(withSlash.text()).toBe(withoutSlash.text());
		});

		test("surrounding whitespace and a doubled slash are tolerated", async () => {
			const { runtime } = makeRuntime();
			const spy = spyExecute(consumed);
			await runRpcSlashCommand("  //changelog  ", undefined, runtime, { execute: spy.execute });
			expect(spy.text()).toBe("/changelog");
		});

		test("args are appended to the command text", async () => {
			const { runtime } = makeRuntime();
			const spy = spyExecute(consumed);
			await runRpcSlashCommand("switch", "gpt-5", runtime, { execute: spy.execute });
			expect(spy.text()).toBe("/switch gpt-5");
		});

		test("args written inline in the name are not dropped", async () => {
			const { runtime } = makeRuntime();
			const spy = spyExecute(consumed);
			await runRpcSlashCommand("/switch gpt-5", undefined, runtime, { execute: spy.execute });
			expect(spy.text()).toBe("/switch gpt-5");
		});

		test("the canonical name is sent, so an alias runs its own handler", async () => {
			const { runtime } = makeRuntime();
			const spy = spyExecute(consumed);
			await runRpcSlashCommand("models", undefined, runtime, { execute: spy.execute });
			expect(spy.text()).toBe("/model");
		});

		test("inline and explicit args are concatenated, not overwritten", async () => {
			const { runtime } = makeRuntime();
			const spy = spyExecute(consumed);
			await runRpcSlashCommand("/switch gpt-5", "high", runtime, { execute: spy.execute });
			expect(spy.text()).toBe("/switch gpt-5 high");
		});

		test("the handler receives a runtime that is not the caller's object", async () => {
			const { runtime } = makeRuntime();
			const spy = spyExecute(consumed);
			await runRpcSlashCommand("changelog", undefined, runtime, { execute: spy.execute });
			const seen = spy.calls[0]!.runtime;
			expect(seen).not.toBe(runtime);
			expect(seen.session).toBe(runtime.session);
			// Only `output` is replaced; the rest is passed through untouched.
			expect(seen.settings).toBe(runtime.settings);
			expect(seen.output).not.toBe(runtime.output);
		});
	});
});

describe("normalizeSlashCommandName", () => {
	const cases: Array<[string, { name: string; inlineArgs: string } | null]> = [
		["git", { name: "git", inlineArgs: "" }],
		["/git", { name: "git", inlineArgs: "" }],
		["  /git  ", { name: "git", inlineArgs: "" }],
		["//git", { name: "git", inlineArgs: "" }],
		["git HEAD~1", { name: "git", inlineArgs: "HEAD~1" }],
		["/git HEAD~1", { name: "git", inlineArgs: "HEAD~1" }],
		// The text dispatchers split on `:` too; the host must agree with them.
		["git:HEAD", { name: "git", inlineArgs: "HEAD" }],
		["/", null],
		["", null],
		["   ", null],
	];

	for (const [input, expected] of cases) {
		test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
			expect(normalizeSlashCommandName(input)).toEqual(expected);
		});
	}
});
