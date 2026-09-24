import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ToolInfo } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ToolCatalogController } from "@oh-my-pi/pi-coding-agent/vibe/tool-catalog";
import type { TSchema } from "@oh-my-pi/pi-ai";

type FakeSession = ConstructorParameters<typeof ToolCatalogController>[0] & {
	enabled: string[];
	hostNames: Set<string>;
};

function tool(name: string, _source: "builtin" | "sdk" | "mcp", mcpServerName?: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: {} as TSchema,
		strict: true,
		concurrency: "shared",
		execute: async () => ({ content: [], details: {} }),
		...(mcpServerName !== undefined ? { mcpServerName } : {}),
	};
}

function fakeSession(): FakeSession {
	const tools = new Map<string, AgentTool>([
		["read", tool("read", "builtin")],
		["bash", tool("bash", "builtin")],
		["todo", tool("todo", "builtin")],
		["host_a", tool("host_a", "sdk")],
		["host_b", tool("host_b", "sdk")],
		["mcp_a1", tool("mcp_a1", "mcp", "alpha")],
		["mcp_a2", tool("mcp_a2", "mcp", "alpha")],
		["mcp_b1", tool("mcp_b1", "mcp", "beta")],
	]);
	const hostNames = new Set<string>();
	const session = {
		enabled: ["read", "todo", "bash", "host_a", "host_b", "mcp_a1", "mcp_a2", "mcp_b1"],
		hostNames,
		getAllToolInfos: () =>
			[...tools].map(([name, value]) => ({
				name,
				description: value.description,
				parameters: value.parameters,
				sourceInfo: { path: `<test:${name}>`, source: value.name.startsWith("host") ? "sdk" : value.name.startsWith("mcp") ? "mcp" : "builtin", scope: "temporary", origin: "top-level" },
			} satisfies ToolInfo)),
		getEnabledToolNames: () => [...session.enabled],
		getToolByName: (name: string) => tools.get(name),
		hasRpcHostTool: (name: string) => hostNames.has(name),
		setActiveToolsByName: async (names: string[]) => {
			session.enabled = [...names];
		},
		getVibeModeState: () => undefined,
		refreshRpcHostTools: async (incoming: AgentTool[]) => {
			for (const name of hostNames) tools.delete(name);
			hostNames.clear();
			for (const value of incoming) {
				tools.set(value.name, value);
				hostNames.add(value.name);
			}
			session.enabled.push(...incoming.map(value => value.name));
		},
	};
	return session as FakeSession;
}

describe("ToolCatalogController", () => {
	test("refuses a selection that omits required tools", async () => {
		const session = fakeSession();
		const controller = new ToolCatalogController(session);
		const result = await controller.setSelection(["bash", "host_a"]);
		expect(result.tools.filter(item => item.enabled).map(item => item.name)).toEqual(session.enabled);
	});

	test("selects a host subset and removes stale host wrappers on replacement", async () => {
		const session = fakeSession();
		const controller = new ToolCatalogController(session);
		await controller.replaceHostTools([{ name: "host_a" }, { name: "host_b" }], [tool("host_a", "sdk"), tool("host_b", "sdk")]);
		await controller.setSelection(["read", "todo", "host_b"]);
		expect(session.enabled).toEqual(["read", "todo", "host_b"]);
		await controller.replaceHostTools([{ name: "host_a" }], [tool("host_a", "sdk")]);
		expect(session.enabled).toEqual(["read", "todo"]);
	});

	test("selecting one MCP tool enables its whole server group", async () => {
		const session = fakeSession();
		const controller = new ToolCatalogController(session);
		await controller.setSelection(["read", "todo", "mcp_a2"]);
		expect(session.enabled).toEqual(["read", "todo", "mcp_a1", "mcp_a2"]);
	});
});
