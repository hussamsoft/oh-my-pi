/**
 * `get_settings` / `set_setting` for RPC hosts.
 *
 * The projection walks the *whole* settings registry, not just the rows the terminal settings
 * panel shows: a host renders the same schema, and a credential with no `ui` metadata (every
 * broker token) is precisely the row whose value must be proven to never leave the process. The
 * panel host supplies only the display metadata (`ui.description`, the visibility predicate);
 * the value of every row is read from the {@link Settings} instance the caller passes, so a host
 * driving several scoped sessions reads and writes the session it means rather than the global
 * singleton the panel's own `get`/`set`/`unset` closures are bound to.
 */
import type { SettingsDisplayEntry, SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { orderedSettings } from "../../config/all-settings";
import { type AnySetting, lookup } from "../../config/registry";
import type { Settings } from "../../config/settings";
import { createSettingsHost } from "../../config/settings-ui";
import type { RpcSetSettingResult, RpcSettingEntry, RpcSettingsResult } from "./rpc-types";

/** Machine-readable reason a `set_setting` was refused; mapped to the RPC response `code`. */
export type RpcSettingsErrorCode = "unknown_setting" | "invalid_payload" | "credential_read_only";

/** Result of one `set_setting`: either the applied value, or a reason it was refused. */
export type RpcSetSettingOutcome =
	| { ok: true; result: RpcSetSettingResult }
	| { ok: false; code: RpcSettingsErrorCode; message: string };

function reject(code: RpcSettingsErrorCode, message: string): RpcSetSettingOutcome {
	return { ok: false, code, message };
}

/**
 * One registry row as a host sees it. `configured` is read unconditionally and redacted
 * afterwards on purpose: the redaction is then a visible, testable step rather than an
 * omission that only happens to be correct today.
 */
function project(setting: AnySetting, settings: Settings, display: SettingsDisplayEntry | undefined): RpcSettingEntry {
	const configured = setting.layered(settings);
	return {
		path: setting.id,
		type: setting.type,
		defaultValue: setting.default,
		value: setting.isCredential ? null : configured,
		// Copied: `enumValues` is the registry's array and a host must not be able to mutate it.
		enumValues: setting.enumValues ? [...setting.enumValues] : undefined,
		description: display?.ui?.description,
		credential: setting.isCredential,
		// The predicate, never the function: it serializes to `null` on the wire and a host
		// cannot act on it. Evaluated here, while the row is being built.
		condition: display?.condition?.(),
		ui: display?.ui
			? {
					tab: display.ui.tab,
					group: display.ui.group,
					label: display.ui.label,
					description: display.ui.description,
				}
			: undefined,
	};
}

/**
 * Every registered setting, projected for a host, plus the store revision the rows were read at.
 * `host` defaults to the terminal settings host, which contributes display metadata only.
 */
export function readRpcSettings(settings: Settings, host: SettingsHost = createSettingsHost()): RpcSettingsResult {
	const display = new Map(host.entries.map(entry => [entry.path, entry]));
	const rows: RpcSettingEntry[] = [];
	for (const setting of orderedSettings()) {
		rows.push(project(setting, settings, display.get(setting.id)));
	}
	return { settings: rows, revision: settings.revision };
}

/**
 * Write one setting, or refuse it.
 *
 * `value: null` means unset. No setting accepts `null` — every {@link AnySetting.accepts} branch
 * rejects it — so it is an unambiguous sentinel rather than a value, and without it a host could
 * only ever add a value, never clear one the user set in a previous session.
 *
 * A credential is refused before validation and before the write: {@link AnySetting.assertWritable}
 * checks type, `validate` and `items`, and knows nothing about credentials, so the check is
 * explicit. Refusing first also means a host that tries to clear a credential with `null` is told
 * so instead of silently deleting the user's token.
 */
export function writeRpcSetting(settings: Settings, path: string, value: unknown): RpcSetSettingOutcome {
	const setting = lookup(path);
	if (!setting) return reject("unknown_setting", `Unknown setting: ${path}`);
	if (setting.isCredential) {
		return reject(
			"credential_read_only",
			`${path} is a credential: its value never leaves OMP. Set it through OMP's own login flow, an environment variable, or the config file.`,
		);
	}
	if (value === null) {
		setting.unset(settings);
	} else {
		try {
			// `assertWritable` delegates the type check to `accepts` and adds the schema's own
			// `items` / `validate` messages, so the host gets OMP's wording, not a re-derived one.
			setting.assertWritable(value);
		} catch (error) {
			return reject("invalid_payload", error instanceof Error ? error.message : String(error));
		}
		setting.set(settings, value);
	}
	// The effective value, not the submitted one: `set` normalizes, and another layer (a project
	// config, an environment variable) may still win. The host re-renders from this one field.
	return { ok: true, result: { path, value: setting.layered(settings), revision: settings.revision } };
}
