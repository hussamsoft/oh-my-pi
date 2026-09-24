import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../session/agent-session";
import { isMCPToolName } from "../tools/builtin-names";
import { VIBE_TOOL_NAMES } from "../tools/vibe";

export type ToolSource = "native" | "paseo" | "mcp";

export interface ToolCatalogEntry {
	name: string;
	label: string;
	description: string;
	source: ToolSource;
	enabled: boolean;
	required: boolean;
}

export interface ToolCatalogResult {
	tools: ToolCatalogEntry[];
}

type ToolCatalogSession = Pick<
	AgentSession,
	| "getAllToolInfos"
	| "getEnabledToolNames"
	| "getToolByName"
	| "hasRpcHostTool"
	| "setActiveToolsByName"
	| "getVibeModeState"
	| "refreshRpcHostTools"
>;

type CatalogEntry = ToolCatalogEntry & { mcpServerName?: string };

/** Owns the effective RPC tool selection independently from registry mutation. */
export class ToolCatalogController {
	readonly #session: ToolCatalogSession;
	readonly #nativeAllowlist: ReadonlySet<string> | undefined;
	#selectedHostToolNames = new Set<string>();
	#receivedHostTools = false;

	constructor(session: ToolCatalogSession, options?: { nativeAllowlist?: Iterable<string> }) {
		this.#session = session;
		this.#nativeAllowlist = options?.nativeAllowlist ? new Set(options.nativeAllowlist) : undefined;
	}

	async getCatalog(): Promise<ToolCatalogResult> {
		const entries = this.#catalogEntries();
		const enabledNames = this.#session.getEnabledToolNames();
		const ordered = entries
			.map((entry, catalogIndex) => ({ entry, catalogIndex, enabledIndex: enabledNames.indexOf(entry.name) }))
			.sort((left, right) => {
				if (left.entry.enabled !== right.entry.enabled) return left.entry.enabled ? -1 : 1;
				if (left.entry.enabled && left.enabledIndex !== right.enabledIndex) return left.enabledIndex - right.enabledIndex;
				return left.catalogIndex - right.catalogIndex;
			})
			.map(({ entry }) => {
				const { mcpServerName: _mcpServerName, ...definition } = entry;
				return definition;
			});
		return { tools: ordered };
	}

	async setSelection(enabledTools: string[]): Promise<ToolCatalogResult> {
		const entries = this.#catalogEntries();
		const required = entries.filter(tool => tool.required);
		if (required.some(tool => !enabledTools.includes(tool.name))) {
			return this.getCatalog();
		}

		const selected = new Set(enabledTools);
		const nextNative = new Set<string>();
		for (const tool of entries) {
			if (tool.source === "native" && selected.has(tool.name) && this.#isNativeAllowed(tool.name)) {
				nextNative.add(tool.name);
			}
		}

		const mcpServers = new Set<string>();
		for (const tool of entries) {
			if (tool.source === "mcp" && tool.mcpServerName !== undefined && selected.has(tool.name)) {
				mcpServers.add(tool.mcpServerName);
			}
		}
		for (const tool of entries) {
			if (tool.source === "mcp" && tool.mcpServerName !== undefined && mcpServers.has(tool.mcpServerName)) {
				nextNative.add(tool.name);
			}
		}

		this.#selectedHostToolNames = new Set(
			entries.filter(tool => tool.source === "paseo" && selected.has(tool.name)).map(tool => tool.name),
		);
		const nextEnabled = entries.filter(tool => tool.required || nextNative.has(tool.name) || this.#selectedHostToolNames.has(tool.name));
		await this.#session.setActiveToolsByName(nextEnabled.map(tool => tool.name));
		return this.getCatalog();
	}

	/**
	 * Replaces the host wrappers and reapplies the selected host subset. New host
	 * tools retain the legacy auto-enable behavior only for the first registration.
	 */
	async replaceHostTools(_definitions: RpcHostToolCatalogDefinition[], tools: AgentTool[]): Promise<ToolCatalogResult> {
		const replacingExisting = this.#receivedHostTools;
		this.#receivedHostTools = true;
		await this.#session.refreshRpcHostTools(tools);

		const catalog = this.#catalogEntries();
		const hostNames = new Set(catalog.filter(tool => tool.source === "paseo").map(tool => tool.name));
		if (!replacingExisting && this.#selectedHostToolNames.size === 0) {
			this.#selectedHostToolNames = new Set(
				catalog.filter(tool => tool.source === "paseo" && tool.enabled).map(tool => tool.name),
			);
		} else {
			this.#selectedHostToolNames = new Set([...this.#selectedHostToolNames].filter(name => hostNames.has(name)));
		}

		const enabledHostNames = new Set(catalog.filter(tool => tool.source === "paseo" && tool.enabled).map(tool => tool.name));
		if (
			enabledHostNames.size !== this.#selectedHostToolNames.size ||
			[...enabledHostNames].some(name => !this.#selectedHostToolNames.has(name))
		) {
			const nextEnabled = catalog.filter(tool => {
				if (tool.required || this.#selectedHostToolNames.has(tool.name)) return true;
				return tool.source !== "paseo" && tool.enabled;
			});
			await this.#session.setActiveToolsByName(nextEnabled.map(tool => tool.name));
		}
		return this.getCatalog();
	}

	#isNativeAllowed(name: string): boolean {
		return this.#nativeAllowlist?.has(name) ?? true;
	}


	#catalogEntries(): CatalogEntry[] {
		const enabled = new Set(this.#session.getEnabledToolNames());
		const vibeEnabled = this.#session.getVibeModeState()?.enabled === true;
		const vibeToolNames = new Set<string>(VIBE_TOOL_NAMES);

		return this.#session.getAllToolInfos().flatMap(info => {
			const tool = this.#session.getToolByName(info.name);
			const source = this.#source(info.name, info.sourceInfo.source, tool);
			if (source === "native" && !this.#isNativeAllowed(info.name)) return [];
			const mcpServerName =
				source === "mcp" && tool !== undefined && "mcpServerName" in tool && typeof tool.mcpServerName === "string"
					? tool.mcpServerName
					: undefined;
			const required =
				info.name === "read" ||
				info.name === "todo" ||
				(vibeEnabled && vibeToolNames.has(info.name));
			const entry: CatalogEntry = {
				name: info.name,
				label: tool?.label ?? info.name,
				description: info.description,
				source,
				enabled: enabled.has(info.name),
				required,
				...(mcpServerName !== undefined ? { mcpServerName } : {}),
			};
			return [entry];
		});
	}

	#source(name: string, provenance: string, tool: AgentTool | undefined): ToolSource {
		if (this.#session.hasRpcHostTool(name) || provenance === "sdk") return "paseo";
		if (provenance === "mcp" || isMCPToolName(name) || (tool !== undefined && "mcpServerName" in tool)) return "mcp";
		return "native";
	}
}

export interface RpcHostToolCatalogDefinition {
	name: string;
}
