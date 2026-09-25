import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type KeybindingsConfig, setKeybindings } from "@oh-my-pi/pi-tui";
import type { KeyId } from "@oh-my-pi/pi-tui/keybindings";
import { KEYBINDINGS, KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import {
	getRpcKeybindings,
	parseKeyChord,
	parseKeyChordList,
	setRpcKeybinding,
	splitKeyChordList,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-keybindings";

async function makeAgentDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-keybindings-"));
}

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
});

describe("parseKeyChord", () => {
	const cases: Array<{ input: string; ok: boolean; chord?: KeyId }> = [
		// Valid unmodified keys.
		{ input: "a", ok: true, chord: "a" },
		{ input: "z", ok: true, chord: "z" },
		{ input: "7", ok: true, chord: "7" },
		{ input: "escape", ok: true, chord: "escape" },
		{ input: "enter", ok: true, chord: "enter" },
		{ input: "backspace", ok: true, chord: "backspace" },
		{ input: "f5", ok: true, chord: "f5" },
		{ input: "up", ok: true, chord: "up" },
		{ input: "]", ok: true, chord: "]" },
		// Valid modified chords, including OMP's own non-canonical default spelling.
		{ input: "ctrl+c", ok: true, chord: "ctrl+c" },
		{ input: "shift+ctrl+p", ok: true, chord: "ctrl+shift+p" },
		{ input: "ctrl+shift+p", ok: true, chord: "ctrl+shift+p" },
		{ input: "alt+super+backspace", ok: true, chord: "alt+super+backspace" },
		{ input: "Ctrl+Shift+P", ok: true, chord: "ctrl+shift+p" },
		{ input: "ESC", ok: true, chord: "escape" },
		{ input: "Return", ok: true, chord: "enter" },
		// A capital base letter is a real shift, matching what OMP matches on.
		{ input: "Ctrl+C", ok: true, chord: "ctrl+shift+c" },
		// Rejected: empty, whitespace, trailing separator, unknown modifier,
		// unknown base key, modifiers with no key.
		{ input: "", ok: false },
		{ input: " ", ok: false },
		{ input: "ctrl+ c", ok: false },
		{ input: "ctrl+", ok: false },
		{ input: "+", ok: false },
		{ input: "hyper+c", ok: false },
		{ input: "c+hyper", ok: false },
		{ input: "ctrl+nope", ok: false },
		{ input: "f13", ok: false },
		{ input: "ctrl", ok: false },
		{ input: "ctrl+shift", ok: false },
		{ input: "ctrl+ctrl+a", ok: false },
	];

	for (const { input, ok, chord } of cases) {
		it(`${ok ? "accepts" : "rejects"} ${JSON.stringify(input)}`, () => {
			const parsed = parseKeyChord(input);
			expect(parsed.ok).toBe(ok);
			if (ok) expect(parsed.ok ? parsed.chord : undefined).toBe(chord);
			else expect(parsed.ok === false && parsed.reason.length > 0).toBe(true);
		});
	}
});

describe("parseKeyChordList / splitKeyChordList", () => {
	it("splits on the same separator getRpcKeybindings emits", () => {
		expect(splitKeyChordList("ctrl+q/ctrl+enter")).toEqual(["ctrl+q", "ctrl+enter"]);
		// A `/` after a `+` is the literal base key, not a separator.
		expect(splitKeyChordList("ctrl+/")).toEqual(["ctrl+/"]);
		expect(splitKeyChordList("/")).toEqual(["/"]);
	});

	it("parses a multi-chord binding into canonical order", () => {
		const parsed = parseKeyChordList("f5/alt+r");
		expect(parsed.ok).toBe(true);
		expect(parsed.ok && parsed.chords).toEqual(["f5", "alt+r"]);
	});

	it("collapses duplicate chords the way the manager does", () => {
		const parsed = parseKeyChordList("ctrl+y/ctrl+y");
		expect(parsed.ok && parsed.chords).toEqual(["ctrl+y"]);
	});

	it("rejects an empty list — the caller owns the unbind spelling", () => {
		const parsed = parseKeyChordList("");
		expect(parsed.ok).toBe(false);
	});

	it("propagates the reason from the offending chord", () => {
		const parsed = parseKeyChordList("ctrl+y/hyper+z");
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.reason).toContain("hyper");
	});
});

describe("getRpcKeybindings", () => {
	it("projects every KEYBINDINGS entry with id, keys, description and action", () => {
		const result = getRpcKeybindings(KeybindingsManager.inMemory());
		expect(result.keybindings.length).toBe(Object.keys(KEYBINDINGS).length);
		expect(result.configPath).toBeUndefined();

		for (const entry of result.keybindings) {
			expect(Object.hasOwn(KEYBINDINGS, entry.id)).toBe(true);
			expect(entry.action).toBe(entry.id);
			expect(typeof entry.keys).toBe("string");
		}
		const byId = new Map(result.keybindings.map(e => [e.id, e]));
		expect(byId.get("app.interrupt")).toEqual({
			id: "app.interrupt",
			keys: "escape",
			action: "app.interrupt",
			description: "Interrupt current operation",
		});
		// Multi-chord default keeps the `/`-joined machine form, not "F5/Alt+R".
		expect(byId.get("app.retry")?.keys).toBe("f5/alt+r");
		// An intentionally unbound action reports an empty binding, not a default.
		expect(byId.get("app.session.fork")?.keys).toBe("");
	});

	it("emits the value a host can hand straight back to setRpcKeybinding", () => {
		const manager = KeybindingsManager.inMemory();
		const entry = getRpcKeybindings(manager).keybindings.find(e => e.id === "app.message.followUp")!;
		expect(entry.keys).toBe("ctrl+q/ctrl+enter");
		const written = setRpcKeybinding(manager, entry.id, entry.keys);
		expect(written.ok).toBe(true);
		expect(written.ok && written.result.keys).toBe(entry.keys);
	});

	it("reports a user override, not the default", () => {
		const manager = KeybindingsManager.inMemory({ "app.model.select": "ctrl+y" });
		const entry = getRpcKeybindings(manager).keybindings.find(e => e.id === "app.model.select")!;
		expect(entry.keys).toBe("ctrl+y");
	});

	it("omits configPath when a write would not be persisted", async () => {
		const agentDir = await makeAgentDir();
		try {
			expect(getRpcKeybindings(KeybindingsManager.create(agentDir)).configPath).toBe(
				path.join(agentDir, "keybindings.yml"),
			);
			expect("configPath" in getRpcKeybindings(KeybindingsManager.inMemory())).toBe(false);
		} finally {
			await removeWithRetries(agentDir);
		}
	});
});

describe("setRpcKeybinding", () => {
	it("rejects an id that is not in KEYBINDINGS", () => {
		const result = setRpcKeybinding(KeybindingsManager.inMemory(), "app.does.not.exist", "ctrl+x");
		expect(result).toMatchObject({ ok: false, code: "unknown_keybinding" });
		// A prototype key must not slip through `in`.
		const inherited = setRpcKeybinding(KeybindingsManager.inMemory(), "toString", "ctrl+x");
		expect(inherited).toMatchObject({ ok: false, code: "unknown_keybinding" });
	});

	it.each([
		["unknown modifier", "hyper+c"],
		["unknown base key", "ctrl+nope"],
		["trailing separator", "ctrl+"],
		["modifiers only", "ctrl+shift"],
		["inner whitespace", "ctrl+ c"],
		["surrounding whitespace", " ctrl+c "],
	])("rejects %s as invalid_payload", (_label, keys) => {
		const result = setRpcKeybinding(KeybindingsManager.inMemory(), "app.model.select", keys);
		expect(result).toMatchObject({ ok: false, code: "invalid_payload" });
	});

	it("round-trips a rebind through a real file-backed manager", async () => {
		const agentDir = await makeAgentDir();
		try {
			await Bun.write(
				path.join(agentDir, "keybindings.yml"),
				YAML.stringify({ "app.model.select": "ctrl+y", "app.session.fork": "ctrl+b" }, null, 2),
			);
			const manager = KeybindingsManager.create(agentDir);

			const written = setRpcKeybinding(manager, "app.model.select", "alt+y");
			expect(written.ok).toBe(true);
			if (!written.ok) throw new Error("unreachable");
			expect(written.result).toEqual({
				keybinding: "app.model.select",
				keys: "alt+y",
				persisted: true,
				configPath: path.join(agentDir, "keybindings.yml"),
			});

			// A write that only updated the in-memory map would not survive.
			const onDisk = YAML.parse(await Bun.file(written.result.configPath!).text()) as KeybindingsConfig;
			expect(onDisk["app.model.select"]).toBe("alt+y");
			expect(KeybindingsManager.create(agentDir).getKeys("app.model.select")).toEqual(["alt+y"]);
			// The sibling override survives the write.
			expect(KeybindingsManager.create(agentDir).getKeys("app.session.fork")).toEqual(["ctrl+b"]);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("persists a multi-chord rebind as a YAML list and reads it back", async () => {
		const agentDir = await makeAgentDir();
		try {
			const manager = KeybindingsManager.create(agentDir);
			const written = setRpcKeybinding(manager, "app.retry", "ctrl+y/alt+y");
			expect(written.ok).toBe(true);
			if (!written.ok) throw new Error("unreachable");

			const onDisk = YAML.parse(await Bun.file(path.join(agentDir, "keybindings.yml")).text()) as KeybindingsConfig;
			expect(onDisk["app.retry"]).toEqual(["ctrl+y", "alt+y"]);
			expect(KeybindingsManager.create(agentDir).getKeys("app.retry")).toEqual(["ctrl+y", "alt+y"]);
			expect(written.result.keys).toBe("ctrl+y/alt+y");
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("treats an empty keys string as unbind and persists it", async () => {
		const agentDir = await makeAgentDir();
		try {
			const manager = KeybindingsManager.create(agentDir);
			const unbound = setRpcKeybinding(manager, "app.model.select", "");
			expect(unbound.ok).toBe(true);
			if (!unbound.ok) throw new Error("unreachable");
			expect(unbound.result).toEqual({
				keybinding: "app.model.select",
				keys: "",
				persisted: true,
				configPath: path.join(agentDir, "keybindings.yml"),
			});
			// The default (alt+m) is gone, not silently restored.
			expect(manager.getKeys("app.model.select")).toEqual([]);
			expect(KeybindingsManager.create(agentDir).getKeys("app.model.select")).toEqual([]);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("reports a session-only change for an in-memory manager", () => {
		const manager = KeybindingsManager.inMemory();
		const result = setRpcKeybinding(manager, "app.model.select", "alt+y");
		expect(result).toEqual({
			ok: true,
			result: { keybinding: "app.model.select", keys: "alt+y", persisted: false },
		});
		expect("configPath" in (result.ok ? result.result : {})).toBe(false);
		expect(manager.getKeys("app.model.select")).toEqual(["alt+y"]);
	});

	it("rejects an invalid payload before touching the manager", () => {
		const manager = KeybindingsManager.inMemory();
		const before = manager.getKeys("app.model.select");
		expect(setRpcKeybinding(manager, "app.model.select", "ctrl+").ok).toBe(false);
		expect(manager.getKeys("app.model.select")).toEqual(before);
	});
});
