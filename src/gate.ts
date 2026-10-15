/** 门禁与进入规则的纯函数：不引用宿主 API，便于单测。 */
import { ORCHESTRATOR_TOOL, ROLE_LABELS, SUBAGENT_TOOL, type TeammateConfig } from "./config.ts";

export type ModeState = "auto" | "on" | "off";

export interface EngageInput {
	state: ModeState;
	markerActive: boolean;
	activeTools: readonly string[];
	entryBlockingTools: readonly string[];
}
/**
 * E2 进入规则：显式 on 直接进；off 不进；auto 要求「标记活跃」且「当前没有写工具」。
 * 后半句是尊重宿主预设：用户在 GUI 里选 full/default（带 bash/edit/write）就是想要普通会话。
 */
export function shouldEngage(input: EngageInput): boolean {
	if (input.state === "on") return true;
	if (input.state === "off") return false;
	if (!input.markerActive) return false;
	return !input.activeTools.some((name) => input.entryBlockingTools.includes(name));
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
	"命名 workflow 会让宿主直接执行命令（如 run-ci 的 npm test），编排器模式下已禁用。并行派活请用 tasks、顺序派活用 chain；要跑命令请让 verify 角色去跑并交回命令、退出码与输出位置。";

/** 文件路径形式的 workflow 脚本（例如 "./flow.js"）没有宿主命令权限，放行；命名资源（如 run-ci）拦下。 */
export function isScriptPath(value: string): boolean {
	return /[\\/]/.test(value) || /\.(js|mjs|cjs|ts|mts)$/i.test(value);
}

/** subagent 的参数级准入：拦命名 workflow 与配置写入类 action，放行派活、查询、等待、续跑。 */
export function subagentBlockReason(input: unknown, config: TeammateConfig): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as Record<string, unknown>;
	if (typeof record.workflow === "string" && !config.allowNamedWorkflows && !isScriptPath(record.workflow)) {
		return NAMED_WORKFLOW_REASON;
	}
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
	entryBlockingTools: readonly string[];
}): string {
	const switchHint = "/orchestrator on 可显式开启，off 关闭。";
	if (input.engaged) {
		const usable = input.keepTools.filter((name) => name !== ORCHESTRATOR_TOOL);
		return `编排器模式：开启（${input.mode}）｜工具(${usable.length})：${usable.join("、")}`;
	}
	let why: string;
	if (input.mode === "off") why = "本次会话被 /orchestrator off 关掉了";
	else if (!input.markerActive) why = "标记未激活（defaultTools 里没有 +orchestrator）";
	else {
		const blocking = input.entryBlockingTools.filter((name) => input.activeTools.includes(name));
		why = blocking.length > 0 ? `写文件的工具还活跃（${blocking.join("、")}）：请在 GUI 预设里选 configured/read-only` : "启动失败，见本条之前的提示";
	}
	return `编排器模式：关闭（${input.mode}）｜原因：${why}｜${switchHint}`;
}

/**
 * 只读命令白名单（前缀匹配）。默认覆盖「看代码/看历史/切目录/只读文本处理」，不放行跑测试与构建。
 * 前缀匹配天然只放行这两条 git config 子命令（普通 `git config user.name x` 写操作仍被拦）；
 * `sed` 在名单里，但 `sed -i` 由 BASH_DENY_PATTERNS 挡在前面。
 */
export const DEFAULT_BASH_ALLOW: readonly string[] = [
	"git status",
	"git diff",
	"git log",
	"git show",
	"git ls-files",
	"git ls-remote",
	"git rev-parse",
	"git blame",
	"git branch",
	"git remote",
	"git stash list",
	"git config --get",
	"git config --list",
	"git describe",
	"git shortlog",
	"git reflog",
	"git cat-file",
	"git count-objects",
	"git check-ignore",
	"git hash-object",
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"rg",
	"grep",
	"find",
	"fd",
	"tree",
	"pwd",
	"stat",
	"file",
	"which",
	"cd",
	"echo",
	"sed",
	"awk",
	"sort",
	"uniq",
	"cut",
	"tr",
	"nl",
	"jq",
	"diff",
	"cmp",
	"sha256sum",
	"sha1sum",
	"md5sum",
];

/** 无论如何都拒的模式：写入、破坏性操作、命令替换。 */
const BASH_DENY_PATTERNS: readonly RegExp[] = [
	/[\$`]\s*\(/, // $( ) 与 ` 命令替换
	/[<>]\s*\(/, // <( ) / >( ) 进程替换
	/(^|[^0-9])>{1,2}\s*\S/, // 重定向到文件
	/\|\s*tee\b/,
	/\bsed\s+-i/,
	/\bperl\s+-i/,
	/\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|truncate|dd|ln)\b/,
	/\bgit\s+(add|commit|push|checkout|switch|reset|clean|apply|restore|rm|mv|stash\s+(pop|drop|clear))\b/,
	/\bgit\s+branch\s+-[dDmM]/,
	/\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|uninstall)\b/,
	/\bpip3?\s+install\b/,
	/--(fix|write|output|out-dir|emit)\b/,
];

/**
 * 只读 bash 准入：把命令按 && / || / ; / 换行 / 管道拆段，逐段查拒绝模式与白名单。
 * 这是启发式，不保证：被放行的命令（以及它们调起的项目脚本）仍可能写文件。
 */
export function bashBlockReason(command: unknown, config: TeammateConfig): string | undefined {
	if (typeof command !== "string" || command.trim() === "") return "空命令。";
	for (const pattern of BASH_DENY_PATTERNS) {
		if (pattern.test(command)) return `命令里含写入/破坏性/命令替换模式（${pattern.source}），编排器模式下已禁用。要看结论请派 verify 角色。`;
	}
	const allowed = [...DEFAULT_BASH_ALLOW, ...config.bashAllow];
	const segments = command
		.split(/\|\||&&|;|\n|\|/)
		.map((segment) => segment.trim())
		.filter((segment) => segment !== "");
	for (const segment of segments) {
		const ok = allowed.some((prefix) => segment === prefix || segment.startsWith(`${prefix} `));
		if (!ok) return `「${segment}」不在只读白名单里。编排器只能看（git 历史/diff、列目录、读文件、搜索）；跑测试或改东西请派 verify / worker。`;
	}
	return undefined;
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
