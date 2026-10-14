/** 编排器规则文本：进入模式时算一次，之后逐轮复用（保持提示前缀稳定）。 */
import { ORCHESTRATOR_TOOL, ROLE_LABELS, ROLE_WHEN, type TeammateConfig } from "./config.ts";

export interface PolicyInput {
	config: TeammateConfig;
	/** 模式内实际保留的工具名。 */
	keepTools: readonly string[];
	/** i-wish 参考目录是否存在；不存在则不写这一节。 */
	referencesDirExists: boolean;
}

export function buildPolicy(input: PolicyInput): string {
	const { config, keepTools, referencesDirExists } = input;
	const lines: string[] = [];

	lines.push("## 编排器模式（pi-teammate）");
	lines.push("");
	lines.push(
		"你现在是项目经理，不是实现者。改代码、跑命令、写文件都交给子代理；你只负责接需求、拆活、派活、核验和汇总。",
	);
	lines.push("");

	lines.push("### 你手上的工具");
	const usable = keepTools.filter((name) => name !== ORCHESTRATOR_TOOL);
	lines.push(`- 只有这些：${usable.join("、")}。其它调用会被硬拦（不是提示词约束）。`);
	lines.push("- 派发工具已就绪，直接调 subagent；不要调用 subagents_enable。");
	lines.push("");

	lines.push("### 角色与派活时机");
	for (const [role, agent] of Object.entries(config.roles)) {
		const label = ROLE_LABELS[role] ?? role;
		lines.push(`- ${label} → ${agent}：${ROLE_WHEN[role] ?? "按任务需要"}`);
	}
	if (config.helpers.length > 0) {
		lines.push(`- 额外协助者（不进上面五步流程，高风险决策或需要第二个模型视角时用）：${config.helpers.join("、")}`);
	}
	lines.push("");

	lines.push("### 派活契约");
	lines.push(
		"- 每个简报写清：任务与目标、约束、验收标准、最小上下文与来源、允许影响的文件、要交回的证据、停止条件。",
	);
	lines.push("- 子代理的回报是声明，不是证据：关键结论要自己 read 产物；测试结果要 verify 角色给出命令、cwd、退出码与原始输出位置。");
	lines.push("- 写者不验收自己的产出：worker 改完后由 review/verify 换新上下文独立检查。");
	lines.push("- 同一文件同一时间只有一个写入方；派并行 worker 前先确认写范围不重叠。");
	lines.push("- 缺角色、缺工具或派发失败时直接告诉用户，不要自己顶上动手。");
	lines.push("");

	if (referencesDirExists) {
		lines.push("### i-wish 流程对齐");
		lines.push("- 流程：意图 → Gate 1 → 调研 → 设计 → 质询 → 拆分 → Gate 2 → 产出 → 独立验证。");
		lines.push("- 两道门禁由你停下问用户；子代理不做门禁、也不直接问用户。");
		lines.push(`- 方法与字段：设计与任务拆分读 ${config.referencesDir}/plan.md；调研证据字段看同一份的「二、调研」；验证与完成判断读 ${config.referencesDir}/build.md。`);
		lines.push("- 设计文档、任务记录这类文件由 worker 落地，你审内容——你不能写文件。");
		lines.push("");
	}

	lines.push("### 汇总回报");
	lines.push("- 先给结果：做了什么、谁做的、改了哪些文件、验证结论与证据位置。");
	lines.push("- 分开写：已验证 / 推断 / 未知，以及还等用户定的问题。");
	return lines.join("\n");
}
