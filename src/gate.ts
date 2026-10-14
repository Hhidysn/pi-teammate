/** 门禁与进入规则的纯函数：不引用宿主 API，便于单测。 */
import { ORCHESTRATOR_TOOL, ROLE_LABELS, SUBAGENT_TOOL, type TeammateConfig } from "./config.ts";

export type ModeState = "auto" | "on" | "off";

export interface EngageInput {
	state: ModeState;
	markerActive: boolean;
	activeTools: readonly string[];
	writeCapableTools: readonly string[];
}

/**
 * E2 进入规则：显式 on 直接进；off 不进；auto 要求「标记活跃」且「当前没有写工具」。
 * 后半句是尊重宿主预设：用户在 GUI 里选 full/default（带 bash/edit/write）就是想要普通会话。
 */
export function shouldEngage(input: EngageInput): boolean {
	if (input.state === "on") return true;
	if (input.state === "off") return false;
	if (!input.markerActive) return false;
	return !input.activeTools.some((name) => input.writeCapableTools.includes(name));
}

/** 模式内实际保留的工具：白名单 ∩ 已注册，保持白名单顺序；加载器追加在末尾避免抖动。 */
export function effectiveKeepTools(
	registered: Iterable<string>,
	keepTools: readonly string[],
	loaderTool: string,
): string[] {
	const available = new Set(registered);
	const kept = keepTools.filter((name) => available.has(name));
	if (available.has(loaderTool) && !kept.includes(loaderTool)) kept.push(loaderTool);
	return kept;
}

/** 白名单外的工具调用一律拦下，并给出该派给谁。 */
export function toolBlockReason(
	toolName: string,
	keepTools: readonly string[],
	roles: Record<string, string>,
): string | undefined {
	if (keepTools.includes(toolName)) return undefined;
	if (toolName === ORCHESTRATOR_TOOL) {
		return "编排器模式已开启：orchestrator 只是模式标记，不是给你调用的工具。要用普通会话请让用户选 full/default 预设或执行 /orchestrator off。";
	}
	const fleet = Object.entries(roles)
		.map(([role, agent]) => `${ROLE_LABELS[role] ?? role}→${agent}`)
		.join("、");
	return `编排器模式已开启，${toolName} 不在允许的工具里。你不能自己改代码、跑命令或写文件：请派子代理执行（${fleet}）。`;
}

export const NAMED_WORKFLOW_REASON =
	"命名 workflow 会让宿主直接执行命令（如 run-ci 的 npm test），编排器模式下已禁用。要跑测试或 CI 请派 verify 角色，由它执行并交回命令、退出码与原始输出位置。";

/** subagent 的参数级准入：拦命名 workflow 与配置写入类 action，放行派活、查询、等待、续跑。 */
export function subagentBlockReason(input: unknown, config: TeammateConfig): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as Record<string, unknown>;
	if (typeof record.workflow === "string" && !config.allowNamedWorkflows) return NAMED_WORKFLOW_REASON;
	if (typeof record.action === "string" && config.blockedSubagentActions.includes(record.action)) {
		return `subagent 的 ${record.action} 会写宿主配置或计划表，不属于派活范围，编排器模式下已禁用。`;
	}
	return undefined;
}

/** 模式状态文案：没进模式时直接给原因，省得再去猜哪一步拦住的。 */
export function modeStatusText(input: {
	engaged: boolean;
	mode: ModeState;
	markerActive: boolean;
	activeTools: readonly string[];
	keepTools: readonly string[];
	writeCapableTools: readonly string[];
}): string {
	const switchHint = "开关：/orchestrator on|off。";
	if (input.engaged) {
		const usable = input.keepTools.filter((name) => name !== ORCHESTRATOR_TOOL);
		return `编排器模式：开启（模式=${input.mode}）。${switchHint}\n工具（${usable.length}）：${usable.join("、")}`;
	}
	let why: string;
	if (input.mode === "off") why = "本次会话被 /orchestrator off 关掉了";
	else if (!input.markerActive) {
		why = "标记未激活：settings.json 的 defaultTools 里没有 +orchestrator，或宿主预设把它剔掉了";
	} else {
		const blocking = input.writeCapableTools.filter((name) => input.activeTools.includes(name));
		why =
			blocking.length > 0
				? `这些写工具还活跃：${blocking.join("、")}（想用编排器模式就在 GUI 里选 configured/read-only，或执行 /orchestrator on）`
				: "启动时没能开启，见会话开头 pi-teammate 的提示";
	}
	return `编排器模式：关闭（模式=${input.mode}）。${switchHint}\n原因：${why}`;
}

/** 子代理不允许再派发：能力天花板里剔掉这些名字。 */
export const CHILD_DENIED_TOOLS: readonly string[] = [
	SUBAGENT_TOOL,
	"subagents_enable",
	"subagent_supervisor",
	"bg_wait",
	ORCHESTRATOR_TOOL,
];

/** 子代理工具并集 = 当前注册的工具里剔掉「派发与管理」类。 */
export function childAllowedTools(registered: Iterable<string>): string[] {
	const denied = new Set(CHILD_DENIED_TOOLS);
	return [...registered].filter((name) => !denied.has(name));
}
