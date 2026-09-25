import { describe, expect, test } from "bun:test";
import { all, lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type RpcSetSettingOutcome,
	readRpcSettings,
	writeRpcSetting,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-settings";
import type { RpcSettingEntry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

/** The applied value, or a thrown expectation failure naming the refusal. */
function applied(outcome: RpcSetSettingOutcome): { path: string; value: unknown; revision: number } {
	if (!outcome.ok) throw new Error(`expected success, got ${outcome.code}: ${outcome.message}`);
	return outcome.result;
}

function row(settings: ReadonlyArray<RpcSettingEntry>, path: string): RpcSettingEntry {
	const found = settings.find(entry => entry.path === path);
	if (!found) throw new Error(`no projected row for ${path}`);
	return found;
}

const SECRET = "bearer-omp-do-not-leak";

describe("readRpcSettings", () => {
	test("projects every registered setting exactly once, with a renderable row", () => {
		const settings = Settings.isolated();
		const result = readRpcSettings(settings);

		expect(result.revision).toBe(settings.revision);
		// The whole schema, not just the panel's rows: a host builds its own form, and the
		// registry is the only complete list.
		const projected = result.settings.map(entry => entry.path);
		expect([...projected].sort()).toEqual(
			all()
				.map(setting => setting.id)
				.sort(),
		);
		expect(new Set(projected).size).toBe(projected.length);

		const seen = new Set<string>();
		for (const entry of result.settings) {
			expect(entry.path).not.toBe("");
			expect(seen.has(entry.path)).toBe(false);
			seen.add(entry.path);
			expect(["boolean", "number", "string", "enum", "array", "record"]).toContain(entry.type);
			expect(typeof entry.credential).toBe("boolean");
			// A predicate that failed to serialize would reach a host as `null` and read as
			// "always show"; the row must carry a boolean or nothing.
			expect(entry.condition === undefined || typeof entry.condition === "boolean").toBe(true);
		}
	});

	test("carries the display metadata of a panel setting and no metadata for a bare one", () => {
		const result = readRpcSettings(Settings.isolated());

		const vim = row(result.settings, "tui.vimMode");
		expect(vim).toMatchObject({
			type: "boolean",
			defaultValue: false,
			value: false,
			credential: false,
		});
		expect(vim.description).toBeTypeOf("string");
		expect(vim.description?.length ?? 0).toBeGreaterThan(0);

		// An enum row advertises its values; other types do not invent any.
		const display = row(result.settings, "tui.vimModeDisplay");
		expect(display.enumValues).toEqual(["text", "icon", "none"]);
		expect(row(result.settings, "tui.vimMode").enumValues).toBeUndefined();

		// `auth.broker.token` declares no `ui`, so it has no description — but it is still
		// projected, because a row a host cannot see is a row it cannot prove is safe.
		expect(row(result.settings, "auth.broker.token").description).toBeUndefined();
	});

	test("never serializes a configured credential", () => {
		const settings = Settings.isolated({ "auth.broker.token": SECRET });
		// The store really does hold the secret: this asserts redaction, not an absent value.
		expect(lookup("auth.broker.token")?.layered(settings)).toBe(SECRET);
		const result = readRpcSettings(settings);

		const entry = row(result.settings, "auth.broker.token");
		expect(entry.credential).toBe(true);
		expect(entry.value).toBeNull();
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});
});

describe("writeRpcSetting", () => {
	test("applies a valid value, moves the revision, and is visible in the next projection", () => {
		const settings = Settings.isolated();
		const before = readRpcSettings(settings).revision;

		const result = applied(writeRpcSetting(settings, "tui.vimMode", true));

		expect(result.path).toBe("tui.vimMode");
		expect(result.value).toBe(true);
		expect(result.revision).toBe(before + 1);
		expect(row(readRpcSettings(settings).settings, "tui.vimMode").value).toBe(true);
	});

	test("accepts every type the schema declares", () => {
		const settings = Settings.isolated();

		expect(applied(writeRpcSetting(settings, "tui.vimMode", true)).value).toBe(true);
		expect(applied(writeRpcSetting(settings, "retry.baseDelayMs", 250)).value).toBe(250);
		expect(applied(writeRpcSetting(settings, "tui.vimModeDisplay", "icon")).value).toBe("icon");
	});

	test("rejects an unregistered path without touching the store", () => {
		const settings = Settings.isolated();
		const before = readRpcSettings(settings).revision;

		const outcome = writeRpcSetting(settings, "tui.notASetting", true);

		expect(outcome).toMatchObject({ ok: false, code: "unknown_setting" });
		if (outcome.ok) throw new Error("expected a rejection");
		expect(outcome.message).toContain("tui.notASetting");
		expect(readRpcSettings(settings).revision).toBe(before);
	});

	test("rejects a value the setting does not accept, leaving the value alone", () => {
		const cases: Array<[path: string, value: unknown]> = [
			// A boolean refuses the text the CLI parser would have accepted: a host sends JSON,
			// so a string here is a type error, not a request to parse.
			["tui.vimMode", "yes"],
			["tui.vimMode", {}],
			["tui.vimMode", 1],
			["retry.baseDelayMs", "500"],
			["retry.baseDelayMs", Number.NaN],
			["tui.vimModeDisplay", "fancy"],
			["defaultThinkingLevel", "extreme"],
		];
		for (const [path, value] of cases) {
			const settings = Settings.isolated();
			const before = readRpcSettings(settings).revision;

			const outcome = writeRpcSetting(settings, path, value);

			expect(outcome.ok).toBe(false);
			if (outcome.ok) throw new Error(`expected ${path}=${String(value)} to be rejected`);
			expect(outcome.code).toBe("invalid_payload");
			expect(readRpcSettings(settings).revision).toBe(before);
		}
	});

	test("refuses a credential write and leaves the stored token in place", () => {
		const settings = Settings.isolated({ "auth.broker.token": SECRET });

		const outcome = writeRpcSetting(settings, "auth.broker.token", "rotated");

		expect(outcome).toMatchObject({ ok: false, code: "credential_read_only" });
		if (outcome.ok) throw new Error("expected a rejection");
		expect(outcome.message).not.toContain(SECRET);
		expect(lookup("auth.broker.token")?.layered(settings)).toBe(SECRET);
	});

	test("refuses to clear a credential: `null` is not a way around the redaction", () => {
		const settings = Settings.isolated({ "auth.broker.token": SECRET });

		const outcome = writeRpcSetting(settings, "auth.broker.token", null);

		expect(outcome).toMatchObject({ ok: false, code: "credential_read_only" });
		expect(lookup("auth.broker.token")?.layered(settings)).toBe(SECRET);
	});

	test("treats `null` as unset, restoring the default", () => {
		const settings = Settings.isolated();
		expect(applied(writeRpcSetting(settings, "retry.baseDelayMs", 250)).value).toBe(250);

		const cleared = applied(writeRpcSetting(settings, "retry.baseDelayMs", null));

		expect(cleared.value).toBe(500);
		expect(lookup("retry.baseDelayMs")?.layered(settings)).toBe(500);
		expect(row(readRpcSettings(settings).settings, "retry.baseDelayMs").value).toBe(500);
	});
});
