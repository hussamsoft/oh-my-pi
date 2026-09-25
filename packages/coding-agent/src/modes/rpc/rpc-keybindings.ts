import { KEYBINDINGS, KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { type Keybinding, type KeyId, canonicalKeyId } from "@oh-my-pi/pi-tui/keybindings";
import { Key } from "@oh-my-pi/pi-tui/keys";
import type { RpcKeybindingEntry, RpcKeybindingsResult, RpcSetKeybindingResult } from "./rpc-types";

/**
 * Machine-readable projection of the keybindings table for an RPC host.
 *
 * ## Why `getKeys().join("/")` and not `getDisplayString` / `formatKeyHints`
 *
 * `getDisplayString(id)` is exactly `formatKeyHints(getKeys(id))`, and both render
 * *human* labels that are platform-dependent (`Option+Esc` on darwin, `Alt+Esc`
 * elsewhere; `Esc` for both `escape` and `esc`). Neither output is accepted back
 * by `set_keybinding`, and neither is stable across hosts, so a GUI echoing the
 * value it read would write a binding that silently never matches. The wire value
 * is therefore the canonical `KeyId` form OMP itself matches on, joined with the
 * same `/` separator `formatKeyHints` uses — so the multi-chord shape a host sees
 * is identical, only the characters are machine-readable.
 *
 * The same `/` separator means a literal `/` base key is ambiguous in a *list*
 * (`ctrl+/` vs `ctrl+q` + `/ctrl+y`); see {@link splitKeyChordList}.
 */

/** RPC error code for a keybinding write that cannot be applied. */
export type RpcKeybindingErrorCode = "unknown_keybinding" | "invalid_payload";

/** Machine-readable rejection of a `set_keybinding` command. */
export interface RpcKeybindingRejection {
	ok: false;
	code: RpcKeybindingErrorCode;
	message: string;
}

/** Result of applying one `set_keybinding` command. */
export type RpcSetKeybindingOutcome = { ok: true; result: RpcSetKeybindingResult } | RpcKeybindingRejection;

/** Parsed form of one canonical key chord. */
export type KeyChordParseResult = { ok: true; chord: KeyId } | { ok: false; reason: string };

/** Parsed form of a `/`-separated key chord list. */
export type KeyChordListParseResult = { ok: true; chords: KeyId[] } | { ok: false; reason: string };

const MODIFIERS: ReadonlySet<string> = new Set(["ctrl", "shift", "alt", "super"]);

/**
 * Every legal `BaseKey`, derived from the `Key` helper rather than restated, so a
 * symbol or named key added to `@oh-my-pi/pi-tui/keys` is accepted here without
 * a second edit. Letters and digits are types-only members of `BaseKey` and so
 * are not present in `Key`.
 */
const BASE_KEYS: ReadonlySet<string> = new Set([
	...Object.values(Key as Record<string, unknown>)
		.filter((value): value is string => typeof value === "string")
		.map(value => value.toLowerCase()),
	..."abcdefghijklmnopqrstuvwxyz".split(""),
	..."0123456789".split(""),
]);

/**
 * Split a `/`-separated chord list, treating a `/` that directly follows a `+`
 * (or is the whole value) as the literal `/` base key rather than a separator.
 *
 * A `/` that is a *separator* followed by more modifiers is still ambiguous with
 * a base key (`alt+/ctrl+x`), so that spelling is rejected downstream as an
 * unknown modifier; use the canonical `ctrl+/` form instead.
 */
export function splitKeyChordList(value: string): string[] {
	const parts: string[] = [];
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		if (value[i] !== "/") continue;
		if (i === 0 || value[i - 1] === "+") continue;
		parts.push(value.slice(start, i));
		start = i + 1;
	}
	parts.push(value.slice(start));
	return parts;
}

/**
 * Validate one key chord and return its canonical `KeyId`.
 *
 * Accepts any casing and modifier order and normalises through OMP's own
 * `canonicalKeyId` — so `Ctrl+Shift+P`, `shift+ctrl+p` and `ctrl+shift+p` all
 * resolve to `ctrl+shift+p`, and a capital base letter keeps its real meaning
 * (`Ctrl+C` is `ctrl+shift+c`, the same thing OMP matches on).
 */
export function parseKeyChord(value: string): KeyChordParseResult {
	if (value.length === 0) return { ok: false, reason: "Key chord is empty" };
	if (/\s/.test(value)) return { ok: false, reason: `Key chord has whitespace: ${JSON.stringify(value)}` };

	const chord = canonicalKeyId(value) as KeyId;
	const separator = chord.lastIndexOf("+");
	const base = separator === -1 ? chord : chord.slice(separator + 1);
	const modifiers = separator === -1 ? [] : chord.slice(0, separator).split("+");

	for (const modifier of modifiers) {
		if (!MODIFIERS.has(modifier)) return { ok: false, reason: `Unknown modifier: ${JSON.stringify(modifier)}` };
	}
	if (new Set(modifiers).size !== modifiers.length) {
		return { ok: false, reason: `Duplicate modifier in ${JSON.stringify(value)}` };
	}
	if (MODIFIERS.has(base)) return { ok: false, reason: `Modifier without a key: ${JSON.stringify(value)}` };
	if (!BASE_KEYS.has(base)) return { ok: false, reason: `Unknown key: ${JSON.stringify(base)}` };
	return { ok: true, chord };
}

/**
 * Validate a `/`-separated chord list. An empty string is *not* a chord list —
 * it is the unbind spelling, handled by the caller, which is why it fails here.
 */
export function parseKeyChordList(value: string): KeyChordListParseResult {
	const parts = splitKeyChordList(value);
	const chords: KeyId[] = [];
	const seen = new Set<KeyId>();
	for (const part of parts) {
		const parsed = parseKeyChord(part);
		if (!parsed.ok) return parsed;
		if (seen.has(parsed.chord)) continue;
		seen.add(parsed.chord);
		chords.push(parsed.chord);
	}
	if (chords.length === 0) return { ok: false, reason: "Key chord list is empty" };
	return { ok: true, chords };
}

/** Canonical `/`-joined wire form of a keybinding's effective chords. */
function chordList(manager: KeybindingsManager, keybinding: Keybinding): string {
	return manager.getKeys(keybinding).join("/");
}

/**
 * Project the whole keybindings table for a host.
 *
 * Reads the manager's *effective* bindings (defaults merged with user overrides,
 * including the fallback-key elision `KeybindingsManager.getKeys` applies), so the
 * table a host renders is the table the running TUI matches on.
 */
export function getRpcKeybindings(manager: KeybindingsManager): RpcKeybindingsResult {
	const definitions = KEYBINDINGS as Record<string, { defaultKeys: KeyId | KeyId[]; description?: string }>;
	const keybindings: RpcKeybindingEntry[] = Object.keys(KEYBINDINGS).map(id => {
		const entry: RpcKeybindingEntry = {
			id,
			keys: chordList(manager, id as Keybinding),
			action: id,
		};
		const description = definitions[id]?.description;
		if (description !== undefined) entry.description = description;
		return entry;
	});
	const configPath = manager.getConfigPath();
	return configPath === undefined ? { keybindings } : { keybindings, configPath };
}

/**
 * Rebind one keybinding id and persist it through the same loader the TUI uses.
 *
 * Rejects an id absent from `KEYBINDINGS` as `unknown_keybinding` and an
 * unparseable chord as `invalid_payload`.
 *
 * **Empty `keys` means unbind.** `setKeybinding` accepts an empty `KeyId[]`
 * (it stores it verbatim, and `#rebuild` treats a present-but-empty override as
 * "no keys" rather than falling back to the default), and `[]` round-trips
 * through `keybindings.yml` — so an empty string clears the binding instead of
 * being rejected or silently writing nothing.
 */
export function setRpcKeybinding(
	manager: KeybindingsManager,
	keybinding: string,
	keys: string,
): RpcSetKeybindingOutcome {
	if (!Object.hasOwn(KEYBINDINGS, keybinding)) {
		return { ok: false, code: "unknown_keybinding", message: `Unknown keybinding: ${keybinding}` };
	}
	if (keys.length > 0 && keys.trim() !== keys) {
		return { ok: false, code: "invalid_payload", message: `Key chord has surrounding whitespace: ${keys}` };
	}

	let chords: KeyId[];
	if (keys.length === 0) {
		chords = [];
	} else {
		const parsed = parseKeyChordList(keys);
		if (!parsed.ok) return { ok: false, code: "invalid_payload", message: parsed.reason };
		chords = parsed.chords;
	}

	// `setKeybinding` keeps a lone chord scalar in the YAML, matching what OMP
	// writes itself; only a real multi-chord binding needs the array form.
	const { persisted, path } = manager.setKeybinding(
		keybinding as Keybinding,
		chords.length === 1 ? chords[0] : chords,
	);
	const result: RpcSetKeybindingResult = {
		keybinding,
		// Echo what the manager actually holds, not what was sent, so a host sees
		// the canonical form it must send back.
		keys: chordList(manager, keybinding as Keybinding),
		persisted,
	};
	if (path !== undefined) result.configPath = path;
	return { ok: true, result };
}
