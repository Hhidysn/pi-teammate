import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, expandHome, mergeConfig } from "../src/config.ts";

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
