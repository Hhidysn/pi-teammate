/**
 * pi-teammate：编排器模式。
 *
 * 入口：settings.json 的 defaultTools 里含 +orchestrator（pi-web-gui 选 configured 即可），
 * 或用 `pi --tools read,grep,find,ls,+orchestrator`，或会话内 `/orchestrator on`。
 * 进入条件见 gate.ts 的 shouldEngage：显式 on 直接进；auto 要求「标记活跃且当前没有写工具」（尊重 GUI 预设）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	LOADER_TOOL,
	MODE_ENTRY,
	ORCHESTRATOR_TOOL,
	POLICY_SECTION,
	SUBAGENT_TOOL,
	WRITE_CAPABLE_TOOLS,
	loadConfig,
	type TeammateConfig,
} from "./config.ts";
import { buildPolicy } from "./policy.ts";
import {
	childAllowedTools,
	effectiveKeepTools,
	modeStatusText,
	shouldEngage,
	subagentBlockReason,
	toolBlockReason,
	type ModeState,
} from "./gate.ts";

interface SessionMode {
	mode: ModeState;
	engaged: boolean;
	previousTools: string[];
	policy?: string;
	ceiling?: { dispose(): void };
}

interface CeilingApi {
	registerSubagentCapabilityCeiling(options: {
		sessionId: string;
		source: string;
		ceiling: { allowedTools: string[]; allowedAgents: string[] };
	}): { dispose(): void };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** 读 pi-subagents 的公共能力天花板接口；它按 globalThis 注册表跨包实例共享。 */
async function loadCeilingApi(): Promise<CeilingApi | undefined> {
	const path = join(getAgentDir(), "npm", "node_modules", "pi-subagents", "src", "api", "capability-ceiling.js");
	if (!existsSync(path)) return undefined;
	try {
		const module = (await import(pathToFileURL(path).href)) as Partial<CeilingApi>;
		return typeof module.registerSubagentCapabilityCeiling === "function" ? (module as CeilingApi) : undefined;
	} catch {
		return undefined;
	}
}

/** 从当前分支的最后一个模式条目重建状态（分支切换、resume、reload 都走这里）。 */
function readPersistedMode(ctx: ExtensionContext): { mode?: ModeState; previousTools?: string[] } {
	const entries = ctx.sessionManager.getBranch() as readonly unknown[];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
		if (entry?.type !== "custom" || entry.customType !== MODE_ENTRY) continue;
		const data = (entry.data ?? {}) as { mode?: unknown; previousTools?: unknown };
		const mode = data.mode === "on" || data.mode === "off" || data.mode === "auto" ? data.mode : undefined;
		const previousTools = Array.isArray(data.previousTools)
			? data.previousTools.filter((name): name is string => typeof name === "string")
			: undefined;
		return { mode, previousTools };
	}
	return {};
}

export default function piTeammateExtension(pi: ExtensionAPI): void {
	const sessions = new Map<string, SessionMode>();
	let config: TeammateConfig | undefined;
	let warnings: string[] = [];

	function ensureConfig(ctx: ExtensionContext): TeammateConfig {
		if (!config) {
			const loaded = loadConfig(getAgentDir(), ctx.cwd);
			config = loaded.config;
			warnings = loaded.warnings;
			for (const warning of warnings) ctx.ui.notify(`pi-teammate 配置：${warning}`, "warning");
		}
		return config;
	}

	function stateOf(ctx: ExtensionContext): SessionMode {
		const id = ctx.sessionManager.getSessionId();
		let state = sessions.get(id);
		if (!state) {
			state = { mode: "auto", engaged: false, previousTools: [] };
			sessions.set(id, state);
		}
		return state;
	}

	function registeredTools(): string[] {
		return pi.getAllTools().map((tool) => tool.name);
	}

	/** 模式内保留的完整集合：标记 + 白名单（标记留在活跃集里，resume/reload 才能重建模式）。 */
	function keepList(cfg: TeammateConfig): string[] {
		const kept = effectiveKeepTools(registeredTools(), cfg.keepTools, LOADER_TOOL);
		return kept.includes(ORCHESTRATOR_TOOL) ? kept : [ORCHESTRATOR_TOOL, ...kept];
	}

	async function registerCeiling(ctx: ExtensionContext, state: SessionMode, cfg: TeammateConfig): Promise<void> {
		const api = await loadCeilingApi();
		if (!api) {
			ctx.ui.notify(
				"pi-teammate：没找到 pi-subagents 的能力天花板接口，子代理仍可能再往下派发（可给角色档案设 maxSubagentDepth: 1 兜底）。",
				"warning",
			);
			return;
		}
		try {
			state.ceiling = api.registerSubagentCapabilityCeiling({
				sessionId: ctx.sessionManager.getSessionId(),
				source: "pi-teammate",
				ceiling: {
					allowedTools: childAllowedTools(registeredTools()),
					allowedAgents: [...new Set([...Object.values(cfg.roles), ...cfg.helpers])],
				},
			});
		} catch (error) {
			ctx.ui.notify(`pi-teammate：能力天花板注册失败（${errorText(error)}）`, "warning");
		}
	}

	async function engage(ctx: ExtensionContext, state: SessionMode, persist: boolean): Promise<boolean> {
		const cfg = ensureConfig(ctx);
		if (!registeredTools().includes(SUBAGENT_TOOL)) {
			ctx.ui.notify("pi-teammate：没有发现 subagent 工具（pi-subagents 未安装或未加载），编排器模式不开启。", "warning");
			return false;
		}
		if (cfg.keepTools.some((name) => WRITE_CAPABLE_TOOLS.includes(name))) {
			ctx.ui.notify(
				`pi-teammate：白名单里含写工具（${cfg.keepTools.filter((n) => WRITE_CAPABLE_TOOLS.includes(n)).join("、")}），等于放弃「编排器不写代码」的保证。`,
				"warning",
			);
		}
		state.previousTools = pi.getActiveTools();
		const keep = keepList(cfg);
		const referencesDirExists = cfg.referencesDir !== "" && existsSync(cfg.referencesDir);
		state.policy = buildPolicy({ config: cfg, keepTools: keep, referencesDirExists });
		pi.setActiveTools(keep);
		state.engaged = true;
		await registerCeiling(ctx, state, cfg);
		if (persist) pi.appendEntry(MODE_ENTRY, { mode: state.mode, previousTools: state.previousTools });
		const usable = keep.filter((name) => name !== ORCHESTRATOR_TOOL);
		ctx.ui.notify(`编排器模式已开启｜工具(${usable.length})：${usable.join("、")}`);
		return true;
	}

	function disengage(state: SessionMode, persist: boolean): void {
		if (!state.engaged) return;
		state.engaged = false;
		state.policy = undefined;
		state.ceiling?.dispose();
		state.ceiling = undefined;
		const available = new Set(registeredTools());
		const restore = state.previousTools.filter((name) => available.has(name));
		if (restore.length > 0) pi.setActiveTools(restore);
		state.previousTools = [];
		if (persist) pi.appendEntry(MODE_ENTRY, { mode: state.mode });
	}

	function statusText(state: SessionMode, cfg: TeammateConfig): string {
		return modeStatusText({
			engaged: state.engaged,
			mode: state.mode,
			markerActive: pi.getActiveTools().includes(ORCHESTRATOR_TOOL),
			activeTools: pi.getActiveTools(),
			keepTools: keepList(cfg),
			entryBlockingTools: cfg.entryBlockingTools,
		});
	}

	/** 按当前分支重建状态：分支里最后一条 pi-teammate:mode 决定模式，没有条目就是 auto。 */
	function rebuildFromBranch(ctx: ExtensionContext, state: SessionMode): { persistedMode?: ModeState } {
		const persisted = readPersistedMode(ctx);
		state.mode = persisted.mode ?? "auto";
		state.previousTools = persisted.previousTools ?? [];
		state.engaged = false;
		state.policy = undefined;
		state.ceiling?.dispose();
		state.ceiling = undefined;
		return { persistedMode: persisted.mode };
	}

	async function engageIfWanted(ctx: ExtensionContext, state: SessionMode, persist: boolean): Promise<void> {
		if (state.mode === "off") return;
		const cfg = ensureConfig(ctx);
		const active = pi.getActiveTools();
		if (!shouldEngage({
			state: state.mode,
			markerActive: active.includes(ORCHESTRATOR_TOOL),
			activeTools: active,
			entryBlockingTools: cfg.entryBlockingTools,
		})) {
			return;
		}
		await engage(ctx, state, persist);
	}

	/** 处理异常不能让模式静默失败：报一次，带上原始信息。 */
	const reported = new Set<string>();
	async function guarded(label: string, ctx: ExtensionContext, run: () => Promise<void>): Promise<void> {
		try {
			await run();
		} catch (error) {
			const key = `${ctx.sessionManager.getSessionId()}:${label}`;
			if (reported.has(key)) return;
			reported.add(key);
			ctx.ui.notify(`pi-teammate 在 ${label} 里出错：${errorText(error)}`, "error");
		}
	}

	pi.registerTool({
		name: ORCHESTRATOR_TOOL,
		label: "Orchestrator mode",
		description:
			"编排器模式标记。它在活跃工具里只表示这台机器/这个项目使用编排器模式（主代理只派发、不写代码），不是给你调用的工具。",
		promptSnippet: "orchestrator 是模式标记，不要调用",
		parameters: Type.Object({}),
		exposure: "model-only",
		defaultActive: false,
		// 标记本身对模型不可见：声明藏掉，但仍留在活跃集里作为模式依据。
		prepareLoadout: () => ({ hiddenDeclarations: [ORCHESTRATOR_TOOL] }),
		async execute(_toolCallId: string, _args: Record<string, never>, ctx: ExtensionContext) {
			return { content: [{ type: "text" as const, text: statusText(stateOf(ctx), ensureConfig(ctx)) }], details: undefined };
		},
	});

	pi.registerCommand("orchestrator", {
		description: "编排器模式：/orchestrator on|off|status（不带参数则切换）",
		handler: async (args: string, ctx) => {
			const cfg = ensureConfig(ctx);
			const state = stateOf(ctx);
			const action = (args ?? "").trim().toLowerCase();
			if (action === "status") {
				ctx.ui.notify(statusText(state, cfg), "info");
				return;
			}
			const wantOn = action === "on" ? true : action === "off" ? false : !state.engaged;
			if (!wantOn) {
				state.mode = "off";
				disengage(state, true);
				ctx.ui.notify("编排器模式：已关闭，工具集已恢复。", "info");
				return;
			}
			state.mode = "on";
			if (!pi.getActiveTools().includes(ORCHESTRATOR_TOOL)) {
				pi.setActiveTools([...pi.getActiveTools(), ORCHESTRATOR_TOOL]);
			}
			const ok = await engage(ctx, state, true);
			ctx.ui.notify(ok ? statusText(state, cfg) : "编排器模式：开启失败，见上一条提示。", ok ? "info" : "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await guarded("session_start", ctx, async () => {
			ensureConfig(ctx);
			const state = stateOf(ctx);
			const { persistedMode } = rebuildFromBranch(ctx, state);
			await engageIfWanted(ctx, state, persistedMode === undefined);
		});
	});

	// 树导航不发 session_start（pi 只发 session_tree），必须在这里按新分支重建；
	// 否则上一分支的 engaged 标志会泄漏到「开启之前」的分支上。
	pi.on("session_tree", async (_event, ctx) => {
		await guarded("session_tree", ctx, async () => {
			const state = stateOf(ctx);
			const { persistedMode } = rebuildFromBranch(ctx, state);
			await engageIfWanted(ctx, state, persistedMode === undefined);
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await guarded("before_agent_start", ctx, async () => {
			const cfg = ensureConfig(ctx);
			const state = stateOf(ctx);
			if (!state.engaged) {
				const active = pi.getActiveTools();
				const engageNow = shouldEngage({
					state: state.mode,
					markerActive: active.includes(ORCHESTRATOR_TOOL),
					activeTools: active,
					entryBlockingTools: cfg.entryBlockingTools,
				});
				if (!engageNow) return;
				if (!(await engage(ctx, state, true))) return;
			}
			// 逐轮收敛：请求级工具声明 + 活跃集都钉在白名单上，覆盖 pi-subagents 的重放与迟注册工具。
			const keep = keepList(cfg);
			if (!sameList(pi.getActiveTools(), keep)) pi.setActiveTools(keep);
			event.systemPromptOptions.selectedTools = [...keep];
			event.systemPromptOptions.sections[POLICY_SECTION] = state.policy ?? buildPolicy({ config: cfg, keepTools: keep, referencesDirExists: false });
		});
	});

	pi.on("tool_call", async (event, ctx) => {
		const state = stateOf(ctx);
		if (!state.engaged) return;
		const cfg = ensureConfig(ctx);
		const reason = toolBlockReason(event.toolName, keepList(cfg), cfg.roles);
		if (reason) return { block: true, reason };
		if (event.toolName === SUBAGENT_TOOL) {
			const subagentReason = subagentBlockReason(event.input, cfg);
			if (subagentReason) return { block: true, reason: subagentReason };
		}
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		for (const state of sessions.values()) {
			state.ceiling?.dispose();
			state.ceiling = undefined;
		}
		sessions.clear();
	});
}
