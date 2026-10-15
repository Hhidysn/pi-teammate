import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.ts";
import { buildPolicy } from "../src/policy.ts";

test("policy 文本含 GPT 系角色用法的关键锚点", () => {
	const policy = buildPolicy({
		config: defaultConfig(),
		keepTools: ["read", "subagent"],
		referencesDirExists: false,
		workflowScriptsDisabled: true,
	});
	assert.ok(policy.includes("未验证的假设"), policy);
	assert.ok(policy.includes("不许提前停止"), policy);
	assert.ok(policy.includes("不要替它修补"), policy);
});
