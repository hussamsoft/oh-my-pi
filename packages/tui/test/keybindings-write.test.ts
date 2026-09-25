import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { type KeybindingsConfig, setKeybindings } from "@oh-my-pi/pi-tui";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

async function makeAgentDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybinding-write-"));
}

async function writeYaml(agentDir: string, config: KeybindingsConfig): Promise<void> {
	await Bun.write(path.join(agentDir, "keybindings.yml"), YAML.stringify(config, null, 2));
}

describe("KeybindingsManager.setKeybinding", () => {
	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("persists a rebind and a fresh manager sees it after reload", async () => {
		const agentDir = await makeAgentDir();
		try {
			await writeYaml(agentDir, { "app.model.select": "ctrl+y" });
			const manager = KeybindingsManager.create(agentDir);
			expect(manager.getKeys("app.model.select")).toEqual(["ctrl+y"]);

			const result = manager.setKeybinding("app.model.select", "alt+y");
			expect(result.persisted).toBe(true);
			expect(result.path).toBe(path.join(agentDir, "keybindings.yml"));
			expect(manager.getKeys("app.model.select")).toEqual(["alt+y"]);

			// Round-trip through the real loader: a write that only updated the
			// in-memory map would not survive a new manager.
			const onDisk = YAML.parse(await Bun.file(result.path!).text()) as KeybindingsConfig;
			expect(onDisk["app.model.select"]).toBe("alt+y");
			const reloaded = KeybindingsManager.create(agentDir);
			expect(reloaded.getKeys("app.model.select")).toEqual(["alt+y"]);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("keeps other user overrides when one id is rebound", async () => {
		const agentDir = await makeAgentDir();
		try {
			await writeYaml(agentDir, { "app.model.select": "ctrl+y", "app.session.fork": "ctrl+b" });
			const manager = KeybindingsManager.create(agentDir);

			manager.setKeybinding("app.model.select", "alt+y");

			const onDisk = YAML.parse(await Bun.file(path.join(agentDir, "keybindings.yml")).text()) as KeybindingsConfig;
			expect(onDisk["app.session.fork"]).toBe("ctrl+b");
			expect(KeybindingsManager.create(agentDir).getKeys("app.session.fork")).toEqual(["ctrl+b"]);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("does not bake inherited bindings into a named profile's file", async () => {
		const root = await makeAgentDir();
		const parentDir = path.join(root, "parent");
		const childDir = path.join(root, "child");
		try {
			await writeYaml(parentDir, {
				"app.session.fork": "ctrl+b",
				"app.model.select": "ctrl+y",
			});
			await writeYaml(childDir, { "app.model.select": "alt+p" });

			const manager = KeybindingsManager.create(childDir, { inheritedAgentDir: parentDir });
			// Both layers are visible for reads.
			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+b"]);
			expect(manager.getKeys("app.model.select")).toEqual(["alt+p"]);

			manager.setKeybinding("app.model.select", "alt+y");

			// The child file records only the child's own binding. Writing the
			// merged set would pin the parent's `app.session.fork` as a child
			// override, so unsetting it in the parent would stop taking effect.
			const onDisk = YAML.parse(await Bun.file(path.join(childDir, "keybindings.yml")).text()) as KeybindingsConfig;
			expect(onDisk).toEqual({ "app.model.select": "alt+y" });
			expect(onDisk).not.toHaveProperty("app.session.fork");

			// And the parent still supplies the key the child does not override.
			const reloaded = KeybindingsManager.create(childDir, { inheritedAgentDir: parentDir });
			expect(reloaded.getKeys("app.session.fork")).toEqual(["ctrl+b"]);
		} finally {
			await removeWithRetries(root);
		}
	});

	it("reports session-only for an in-memory manager and writes nothing", async () => {
		const manager = KeybindingsManager.inMemory();
		const result = manager.setKeybinding("app.model.select", "alt+y");
		expect(result).toEqual({ persisted: false, path: undefined });
		expect(manager.getConfigPath()).toBeUndefined();
		expect(manager.getKeys("app.model.select")).toEqual(["alt+y"]);
	});
});
