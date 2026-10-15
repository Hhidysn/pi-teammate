/** 门禁与进入规则的纯函数：不引用宿主 API，便于单测。 */
import {
	ORCHESTRATOR_TOOL,
	ROLE_LABELS,
	SUBAGENT_TOOL,
	defaultAgentDir,
	readWorkflowScriptsDisabled,
	type TeammateConfig,
} from "./config.ts";

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
	"命名 workflow（如 run-ci）会让宿主直接执行命令，编排器模式下已禁用。并行/多步请用一个 workflow 脚本（`subagent({ workflow: true })` + 同一条回复里的 ```js 块，或 `workflow: \"<脚本文件路径>\"`），或退回逐个单发；要跑命令请派 verify 角色。";

/** 文件路径形式的 workflow 脚本（例如 "./flow.js"）没有宿主命令权限，放行；命名资源（如 run-ci）拦下。 */
export function isScriptPath(value: string): boolean {
	return /[\\/]/.test(value) || /\.(js|mjs|cjs|ts|mts)$/i.test(value);
}

/** subagent 参数级准入的配置层：可注入 workflow-scripts 开关，默认读本机/项目配置。 */
export interface SubagentBlockOptions {
	/**
	 * pi-subagents 的 `workflow-scripts` 是否被禁用。禁用时它接受顶层 `tasks`/`chain`，不接受脚本；
	 * 未禁用（默认）时相反。默认读 `~/.pi/agent` 与 cwd 下的 pi-subagents 配置。
	 */
	workflowScriptsDisabled?: boolean;
}

const STRUCTURED_INPUT_REJECTED_REASON =
	"本机 pi-subagents 的 workflow-scripts 未禁用，顶层 tasks/chain 会被拒绝（Legacy top-level chain and parallel inputs were removed）。并行/多步请用 `subagent({ workflow: true })` + 同一条回复里的 ```js 块（形如 `return await runs.all([{ key, agent, task }, …])`），或 `workflow: \"<脚本文件路径>\"`（脚本让 worker 落地）；两种都失败就退回逐个单发。";

const WORKFLOW_SCRIPT_DISABLED_REASON =
	"本机 pi-subagents 已禁用 workflow-scripts：内联脚本（`workflow: true`）与命名 workflow 资源都不可用。并行用 `subagent({ tasks: [{ agent, task }, …] })`，顺序用 `subagent({ chain: [{ agent, task }, …] })`；要跑命令请派 verify 角色。";

/** subagent 的参数级准入：拦命名 workflow 与配置写入类 action，放行派活、查询、等待、续跑。 */
export function subagentBlockReason(
	input: unknown,
	config: TeammateConfig,
	options?: SubagentBlockOptions,
): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as Record<string, unknown>;
	const workflowScriptsDisabled =
		options?.workflowScriptsDisabled ?? readWorkflowScriptsDisabled(defaultAgentDir(), process.cwd());

	const hasStructuredInput = record.tasks !== undefined || record.chain !== undefined;
	const hasWorkflowInput = record.workflow !== undefined;
	// 提前拦下 pi-subagents 注定会拒绝的形态，省掉一轮失败。
	if (workflowScriptsDisabled) {
		if (hasWorkflowInput) return WORKFLOW_SCRIPT_DISABLED_REASON;
	} else if (hasStructuredInput) {
		return STRUCTURED_INPUT_REJECTED_REASON;
	}

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
 * 只读命令白名单（前缀匹配），按组维护。提示词（policy）与拒绝文案都从这份分组生成，
 * 避免出现「…等」这种与实际名单对不上的说法。默认覆盖「git 查看 / 文件查看 / 文本处理 / 导航与系统」，
 * 不放行跑测试与构建。
 * 前缀匹配天然只放行 `git config --get`、`git config --list` 两条 git config 子命令
 * （普通 `git config user.name x` 写操作仍被拦）；`sed` 在名单里，但 `sed -i` 由 BASH_DENY_PATTERNS 挡在前面。
 */
export const BASH_ALLOW_GROUPS: readonly { readonly label: string; readonly prefixes: readonly string[] }[] = [
	{
		label: "git 查看类",
		prefixes: [
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
		],
	},
	{
		label: "文件查看类",
		prefixes: ["ls", "cat", "head", "tail", "wc", "tree", "stat", "file", "du", "df", "bat", "eza"],
	},
	{
		label: "文本处理类",
		prefixes: [
			"rg",
			"grep",
			"find",
			"fd",
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
		],
	},
	{
		label: "导航与系统",
		prefixes: [
			"pwd",
			"cd",
			"echo",
			"which",
			"whereis",
			"type",
			"date",
			"uname",
			"whoami",
			"ps",
			"node --version",
			"python --version",
			"npm list",
			"npm ls",
			"npm view",
			"npm info",
			"npm outdated",
		],
	},
];

/** 默认只读名单 = 上面四组展开；准入判定与 policy 文案同源。 */
export const DEFAULT_BASH_ALLOW: readonly string[] = BASH_ALLOW_GROUPS.flatMap((group) => group.prefixes);

/**
 * 无论如何都拒的模式：写入、破坏性操作、命令替换。与 pi 自带 plan-mode 的 DESTRUCTIVE_PATTERNS 对齐。
 * 注意：这些模式跑在**原始命令串**上（不做引号感知）——引号内的 `>`、反引号同样会被拦下，这是刻意的保守行为。
 */
const BASH_DENY_PATTERNS: readonly RegExp[] = [
	/[\$`]\s*\(/, // $( ) 与 ` 命令替换
	/[<>]\s*\(/, // <( ) / >( ) 进程替换
	/(^|[^0-9])>{1,2}\s*\S/, // 重定向到文件
	/\|\s*tee\b/,
	/\bsed\s+-i/,
	/\bperl\s+-i/,
	/\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|truncate|dd|ln|shred)\b/,
	/\bgit\s+(add|commit|push|pull|merge|rebase|cherry-pick|revert|tag|init|clone|checkout|switch|reset|clean|apply|restore|rm|mv|stash\s+(pop|drop|clear))\b/,
	/\bgit\s+branch\s+-[dDmM]/,
	/\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|uninstall|update|link|publish)\b/, // 含 yarn/pnpm (add|remove|install|publish)
	/\bpip3?\s+install\b/,
	/\bapt(-get)?\s+(install|remove|purge|upgrade)\b/,
	/\bbrew\s+(install|uninstall|upgrade)\b/,
	/\b(sudo|su)\b/,
	/\b(kill|pkill|killall)\b/,
	/\b(reboot|shutdown)\b/,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/,
	/\bservice\s+\S+\s+(start|stop|restart)\b/,
	/\b(vim|vi|nano|emacs|code|subl)\b/, // 交互式编辑器
	/--(fix|write|output|out-dir|emit)\b/,
];

/**
 * 只在引号外切分 `||`、`&&`、`;`、换行与管道 `|`。
 * 引号内的这些符号是命令参数（`rg -n "a|b" src/`、`grep -E 'x|y'`），不是分段边界。
 * 单引号内不转义；双引号与反引号内 `\` 转义下一个字符。
 */
export function splitCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | "`" | undefined;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (quote !== undefined) {
			current += char;
			if (quote === "'") {
				if (char === "'") quote = undefined;
			} else if (char === "\\" && i + 1 < command.length) {
				current += command[i + 1];
				i++;
			} else if (char === quote) {
				quote = undefined;
			}
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "\\" && i + 1 < command.length) {
			current += char + command[i + 1];
			i++;
			continue;
		}
		const pair = command.slice(i, i + 2);
		if (pair === "||" || pair === "&&") {
			segments.push(current);
			current = "";
			i++;
			continue;
		}
		if (char === ";" || char === "\n" || char === "|") {
			segments.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	segments.push(current);
	return segments.map((segment) => segment.trim()).filter((segment) => segment !== "");
}

/**
 * 只读 bash 准入：先在**原始命令串**上查拒绝模式，再用引号感知分段逐段查只读白名单。
 * 这是启发式，不保证：被放行的命令（以及它们调起的项目脚本）仍可能写文件。
 */
export function bashBlockReason(command: unknown, config: TeammateConfig): string | undefined {
	if (typeof command !== "string" || command.trim() === "") return "空命令。";
	for (const pattern of BASH_DENY_PATTERNS) {
		if (pattern.test(command)) return `命令里含写入/破坏性/命令替换模式（${pattern.source}），编排器模式下已禁用。要看结论请派 verify 角色。`;
	}
	const allowed = [...DEFAULT_BASH_ALLOW, ...config.bashAllow];
	const groups = BASH_ALLOW_GROUPS.map((group) => group.label).join("、");
	for (const segment of splitCommandSegments(command)) {
		const ok = allowed.some((prefix) => segment === prefix || segment.startsWith(`${prefix} `));
		if (!ok) {
			return `「${segment}」不在只读白名单里。只读命令分四组：${groups}（完整前缀见 README「只读 bash」或配置 bashAllow）。编排器只能看（git 历史/diff、列目录、读文件、搜索）；命令被拦时不要反复重试或换写法绕过，改用等价的白名单命令，或派 verify / worker。`;
		}
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
