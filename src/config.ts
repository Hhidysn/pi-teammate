/** 配置：默认值、加载与合并。这里不引用宿主 API，便于单测。 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** 模式标记工具：它活跃即表示「这台机器/这个项目想用编排器模式」。 */
export const ORCHESTRATOR_TOOL = "orchestrator";
export const SUBAGENT_TOOL = "subagent";
export const WAIT_TOOL = "bg_wait";
export const SUPERVISOR_TOOL = "subagent_supervisor";
/** pi-subagents 的冷启动加载器。留在白名单里避免与它抢工具声明。 */
export const LOADER_TOOL = "subagents_enable";
/** 会话状态条目类型（分支内按 leaf 重建）。 */
export const MODE_ENTRY = "pi-teammate:mode";
/** 系统提示词里附加的章节名。 */
export const POLICY_SECTION = "pi_teammate";
export const CONFIG_FILE = "pi-teammate.json";

/** 编排器在模式内保留的工具（默认值，可被配置文件整体替换）。 */
export const DEFAULT_KEEP_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"fetch_content",
	"source_check",
	SUBAGENT_TOOL,
	WAIT_TOOL,
	SUPERVISOR_TOOL,
];

/** 这些工具一旦活跃，就说明用户明确要的是普通会话（E2 进入规则）。 */
export const DEFAULT_WRITE_CAPABLE_TOOLS = ["bash", "powershell", "edit", "write"];

/** 角色 → 子代理名。默认映射复用已有 agent 定义，只在配置文件里覆盖。 */
export const DEFAULT_ROLES: Readonly<Record<string, string>> = {
	design: "architect",
	implement: "worker",
	research: "researcher",
	recon: "scout",
	review: "reviewer",
	verify: "verifier",
};

export const ROLE_LABELS: Readonly<Record<string, string>> = {
	design: "架构与任务拆分",
	implement: "执行（改代码）",
	research: "检索外部事实",
	recon: "代码侦察",
	review: "审查",
	verify: "独立验证",
};

export const ROLE_WHEN: Readonly<Record<string, string>> = {
	design: "方案对比、边界与取舍、任务切分、阶段验收目标；需要被否决的备选方案",
	implement: "已批准的切片实现，多文件或机械改动；一次一个写入方",
	research: "版本、API、平台规则等外部事实，或需要一手来源的调研",
	recon: "读代码定位：入口、数据流、风险点、相关文件清单",
	review: "代码或方案的规范、边界、安全与可维护性审查",
	verify: "按验收标准跑检查，给出命令、cwd、退出码与原始输出位置",
};

/** 这些 action 会写宿主的配置文件或计划表，不属派活范围。 */
export const DEFAULT_BLOCKED_SUBAGENT_ACTIONS = [
	"create",
	"update",
	"delete",
	"eject",
	"disable",
	"enable",
	"reset",
	"refine",
	"refine.show",
	"refine.rollback",
	"schedule.create",
	"schedule.update",
	"schedule.delete",
];

export const DEFAULT_REFERENCES_DIR = "~/.agents/skills/i-wish/references";

/** 默认没有额外协助者；用配置文件加（会进子代理允许名单与 policy 文本）。 */
export const DEFAULT_HELPERS: readonly string[] = [];

export interface TeammateConfig {
	/** 模式内保留的工具名（与门禁同源）。 */
	keepTools: string[];
	/** 视为「用户要普通会话」的工具名。 */
	writeCapableTools: string[];
	/** 角色 → 子代理名。 */
	roles: Record<string, string>;
	/** 额外可派的协助者：不进五步流程，但许派（例如 council-gpt / council-deepseek）。 */
	helpers: string[];
	/** i-wish 参考文件目录；为空则不注入 i-wish 相关章节。 */
	referencesDir: string;
	/** 是否放行 subagent 的命名 workflow（会执行宿主命令，默认关）。 */
	allowNamedWorkflows: boolean;
	/** subagent 上被拦的 action。 */
	blockedSubagentActions: string[];
}

export interface LoadedConfig {
	config: TeammateConfig;
	warnings: string[];
	/** 实际读到配置的文件路径，用于启动提示。 */
	sources: string[];
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

export function defaultConfig(): TeammateConfig {
	return {
		keepTools: [...DEFAULT_KEEP_TOOLS],
		writeCapableTools: [...DEFAULT_WRITE_CAPABLE_TOOLS],
		roles: { ...DEFAULT_ROLES },
		helpers: [...DEFAULT_HELPERS],
		referencesDir: DEFAULT_REFERENCES_DIR,
		allowNamedWorkflows: false,
		blockedSubagentActions: [...DEFAULT_BLOCKED_SUBAGENT_ACTIONS],
	};
}

interface FieldOptions {
	/** 是否允许空数组（例如「不拦任何 action」）。 */
	allowEmpty?: boolean;
}

/** 读字符串数组字段：类型或内容不对就告警并保留原值，不静默吞掉。 */
function readStringArray(
	raw: Record<string, unknown>,
	key: string,
	where: string,
	warnings: string[],
	options: FieldOptions = {},
): string[] | undefined {
	if (!Object.hasOwn(raw, key)) return undefined;
	const value = raw[key];
	const items = Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
		: undefined;
	if (items === undefined || (items.length === 0 && !options.allowEmpty)) {
		warnings.push(`${where}: ${key} 必须是字符串数组${options.allowEmpty ? "" : "（至少一项）"}，已忽略`);
		return undefined;
	}
	return items;
}

function readStringRecord(
	raw: Record<string, unknown>,
	key: string,
	where: string,
	warnings: string[],
): Record<string, string> | undefined {
	if (!Object.hasOwn(raw, key)) return undefined;
	const value = raw[key];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		warnings.push(`${where}: ${key} 必须是「名字 → 名字」的对象，已忽略`);
		return undefined;
	}
	const invalid = Object.entries(value).filter(([, item]) => typeof item !== "string" || item.trim() === "");
	if (invalid.length > 0) {
		warnings.push(`${where}: ${key} 里这些键的值不是非空字符串，已忽略：${invalid.map(([name]) => name).join("、")}`);
	}
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "",
	);
	return Object.fromEntries(entries);
}

function readBoolean(raw: Record<string, unknown>, key: string, where: string, warnings: string[]): boolean | undefined {
	if (!Object.hasOwn(raw, key)) return undefined;
	const value = raw[key];
	if (typeof value !== "boolean") {
		warnings.push(`${where}: ${key} 必须是 true 或 false，已忽略`);
		return undefined;
	}
	return value;
}

/** 合并一份配置覆盖；数组整体替换，roles 逐键覆盖。 */
export function mergeConfig(
	base: TeammateConfig,
	override: unknown,
	warnings: string[],
	where: string,
): TeammateConfig {
	if (typeof override !== "object" || override === null || Array.isArray(override)) {
		warnings.push(`${where}: 配置必须是对象，已忽略`);
		return base;
	}
	const raw = override as Record<string, unknown>;
	const next: TeammateConfig = { ...base, roles: { ...base.roles } };

	const keepTools = readStringArray(raw, "keepTools", where, warnings);
	if (keepTools) next.keepTools = keepTools;
	const writeCapable = readStringArray(raw, "writeCapableTools", where, warnings);
	if (writeCapable) next.writeCapableTools = writeCapable;
	const roles = readStringRecord(raw, "roles", where, warnings);
	if (roles) next.roles = { ...base.roles, ...roles };
	const helpers = readStringArray(raw, "helpers", where, warnings, { allowEmpty: true });
	if (helpers) next.helpers = helpers;
	const blocked = readStringArray(raw, "blockedSubagentActions", where, warnings, { allowEmpty: true });
	if (blocked) next.blockedSubagentActions = blocked;
	const allowNamedWorkflows = readBoolean(raw, "allowNamedWorkflows", where, warnings);
	if (allowNamedWorkflows !== undefined) next.allowNamedWorkflows = allowNamedWorkflows;
	if (Object.hasOwn(raw, "referencesDir")) {
		const value = raw.referencesDir;
		if (typeof value === "string") next.referencesDir = value;
		else warnings.push(`${where}: referencesDir 必须是字符串路径，已忽略`);
	}

	const known = new Set([
		"keepTools",
		"writeCapableTools",
		"roles",
		"helpers",
		"blockedSubagentActions",
		"referencesDir",
		"allowNamedWorkflows",
	]);
	for (const key of Object.keys(raw)) if (!known.has(key)) warnings.push(`${where}: 未知字段 ${key}，已忽略`);
	return next;
}

function readJsonFile(path: string, warnings: string[], sources: string[]): unknown {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		sources.push(path);
		return parsed;
	} catch (error) {
		warnings.push(`${path}: 读取失败（${error instanceof Error ? error.message : String(error)}），已忽略`);
		return undefined;
	}
}

/**
 * 读两份覆盖：用户级 `<agentDir>/pi-teammate.json`，项目级 `<cwd>/.pi/pi-teammate.json`（后者优先）。
 * 配置文件只读，不写回。
 */
export function loadConfig(agentDir: string, cwd: string): LoadedConfig {
	const warnings: string[] = [];
	const sources: string[] = [];
	let config = defaultConfig();
	const userOverride = readJsonFile(join(agentDir, CONFIG_FILE), warnings, sources);
	if (userOverride !== undefined) config = mergeConfig(config, userOverride, warnings, "用户配置");
	const projectOverride = readJsonFile(join(cwd, ".pi", CONFIG_FILE), warnings, sources);
	if (projectOverride !== undefined) config = mergeConfig(config, projectOverride, warnings, "项目配置");
	config.referencesDir = config.referencesDir.trim() === "" ? "" : expandHome(config.referencesDir);
	if (config.referencesDir !== "" && !isAbsolute(config.referencesDir)) {
		warnings.push(`referencesDir 不是绝对路径（${config.referencesDir}），已忽略`);
		config.referencesDir = "";
	}
	return { config, warnings, sources };
}
