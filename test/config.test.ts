import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig, expandHome, mergeConfig, readWorkflowScriptsDisabled } from "../src/config.ts";

test("默认白名单与写工具判定", () => {
	const config = defaultConfig();
	assert.ok(config.keepTools.includes("read"));
	assert.ok(config.keepTools.includes("subagent"));
	assert.ok(!config.keepTools.includes("bash"));
	assert.ok(!config.keepTools.includes("edit"));
	assert.deepEqual(config.entryBlockingTools, ["edit", "write"]);
	assert.equal(config.allowNamedWorkflows, false);
});

test("roles 逐键覆盖、helpers 整体替换并参与", () => {
	const warnings: string[] = [];
	const config = mergeConfig(
		defaultConfig(),
		{ keepTools: ["read"], roles: { verify: "my-verifier" }, helpers: ["council-gpt", "council-deepseek"] },
		warnings,
		"测试",
	);
	assert.deepEqual(config.keepTools, ["read"]);
	assert.equal(config.roles.verify, "my-verifier");
	assert.equal(config.roles.implement, "worker", "没点到的角色保持默认");
	assert.deepEqual(config.helpers, ["council-gpt", "council-deepseek"]);
	assert.deepEqual(warnings, []);
});

test("helpers 可以为空（不打算用额外协助者）", () => {
	const warnings: string[] = [];
	const config = mergeConfig(defaultConfig(), { helpers: [] }, warnings, "测试");
	assert.deepEqual(config.helpers, []);
	assert.deepEqual(warnings, []);
});

test("非法与未知字段都会告警，不静默吞掉", () => {
	const warnings: string[] = [];
	const config = mergeConfig(defaultConfig(), { keepTools: [], nope: 1, allowNamedWorkflows: "yes" }, warnings, "测试");
	assert.ok(config.keepTools.length > 0, "空数组视为无效，保持默认");
	assert.equal(config.allowNamedWorkflows, false, "非布尔值忽略");
	assert.equal(warnings.length, 3, warnings.join(" / "));
	assert.ok(warnings.some((line) => line.includes("keepTools")));
	assert.ok(warnings.some((line) => line.includes("allowNamedWorkflows")));
	assert.ok(warnings.some((line) => line.includes("nope")));
});

test("~ 展开", () => {
	assert.ok(expandHome("~/.agents/skills").endsWith(".agents/skills") || expandHome("~/.agents/skills").includes("agents"));
	assert.equal(expandHome("C:/tmp/x"), "C:/tmp/x");
});

test("读 pi-subagents 的 workflow-scripts 开关（只认用户级，与运行时一致）", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-teammate-"));
	try {
		const agentDir = join(root, "agent");
		const userPath = join(agentDir, "extensions", "subagent", "config.json");
		mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });

		assert.equal(readWorkflowScriptsDisabled(agentDir), false, "无配置时默认未禁用");
		writeFileSync(userPath, JSON.stringify({ disabledFeatures: ["workflow-scripts"] }));
		assert.equal(readWorkflowScriptsDisabled(agentDir), true, "用户级禁用生效");
		writeFileSync(userPath, JSON.stringify({ disabledFeatures: ["missions"] }));
		assert.equal(readWorkflowScriptsDisabled(agentDir), false, "用户级未含 workflow-scripts 则未禁用");
		writeFileSync(userPath, "{ not json");
		assert.equal(readWorkflowScriptsDisabled(agentDir), false, "坏 JSON 忽略");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目级 pi-subagents 配置不影响判断（与运行时一致）", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-teammate-"));
	try {
		const agentDir = join(root, "agent");
		const cwd = join(root, "proj");
		const projectPath = join(cwd, ".pi", "extensions", "subagent", "config.json");
		mkdirSync(join(cwd, ".pi", "extensions", "subagent"), { recursive: true });

		// 项目级写了禁用，但用户级没有 → 判断不受影响
		writeFileSync(projectPath, JSON.stringify({ disabledFeatures: ["workflow-scripts"] }));
		assert.equal(readWorkflowScriptsDisabled(agentDir), false, "项目级 disabledFeatures 不参与判断");

		// 用户级禁用时结果只由用户级决定
		const userPath = join(agentDir, "extensions", "subagent", "config.json");
		mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });
		writeFileSync(userPath, JSON.stringify({ disabledFeatures: ["workflow-scripts"] }));
		assert.equal(readWorkflowScriptsDisabled(agentDir), true, "结果只由用户级决定");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
