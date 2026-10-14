import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.ts";
import {
	childAllowedTools,
	effectiveKeepTools,
	modeStatusText,
	shouldEngage,
	subagentBlockReason,
	toolBlockReason,
} from "../src/gate.ts";

const WRITE = ["bash", "powershell", "edit", "write"];
const READONLY = ["read", "grep", "find", "ls"];
const ORCH = "orchestrator";

test("E2：auto 只在「标记活跃且没有写工具」时进入", () => {
	assert.equal(
		shouldEngage({ state: "auto", markerActive: true, activeTools: [ORCH, ...READONLY], writeCapableTools: WRITE }),
		true,
	);
	assert.equal(
		shouldEngage({ state: "auto", markerActive: true, activeTools: [ORCH, ...READONLY, "bash"], writeCapableTools: WRITE }),
		false,
		"GUI 选了 full/default（有写工具）时不进入，尊重用户的预设",
	);
	assert.equal(shouldEngage({ state: "auto", markerActive: false, activeTools: [...READONLY], writeCapableTools: WRITE }), false);
});

test("on/off 覆盖 auto", () => {
	assert.equal(shouldEngage({ state: "on", markerActive: false, activeTools: ["bash"], writeCapableTools: WRITE }), true);
	assert.equal(shouldEngage({ state: "off", markerActive: true, activeTools: [...READONLY], writeCapableTools: WRITE }), false);
});

test("白名单取交集、保持顺序，并追加加载器避免与 pi-subagents 抢声明", () => {
	const registered = ["read", "bash", "subagent", "subagents_enable", "web_search"];
	const keep = effectiveKeepTools(registered, ["read", "grep", "web_search", "subagent"], "subagents_enable");
	assert.deepEqual(keep, ["read", "web_search", "subagent", "subagents_enable"]);
});

test("白名单外的工具被拦下，并给出该派给谁", () => {
	const roles = defaultConfig().roles;
	const message = toolBlockReason("bash", ["read", "subagent"], roles);
	assert.ok(message && message.includes("bash"));
	assert.ok(message.includes("architect") && message.includes("worker"));
	assert.equal(toolBlockReason("subagent", ["read", "subagent"], roles), undefined, "白名单内的工具放行");
	assert.ok(toolBlockReason(ORCH, ["read", "subagent"], roles)?.includes("模式标记"));
});

test("subagent：拦命名 workflow 与配置写入 action，放行派活与内联脚本", () => {
	const config = defaultConfig();
	assert.ok(subagentBlockReason({ workflow: "run-ci", args: { command: "npm test" } }, config)?.includes("命名 workflow"));
	assert.ok(subagentBlockReason({ action: "config.update" }, config) === undefined);
	assert.ok(subagentBlockReason({ action: "update" }, config)?.includes("update"));
	assert.equal(subagentBlockReason({ agent: "worker", task: "改这个" }, config), undefined);
	assert.equal(subagentBlockReason({ workflow: true }, config), undefined, "内联脚本没有宿主命令权限，放行");
	assert.equal(subagentBlockReason({ tasks: [{ agent: "worker", task: "x" }] }, config), undefined);
	assert.equal(subagentBlockReason({ action: "list" }, config), undefined);
});

test("状态文案：开启时列工具，关闭时给得出原因", () => {
	const base = {
		mode: "auto" as const,
		keepTools: ["orchestrator", "read", "subagent"],
		writeCapableTools: ["bash", "edit", "write"],
	};
	const on = modeStatusText({ ...base, engaged: true, markerActive: true, activeTools: base.keepTools });
	assert.ok(on.includes("工具（2）：read、subagent"), on);
	const blocked = modeStatusText({ ...base, engaged: false, markerActive: true, activeTools: ["read", "bash", "write"] });
	assert.ok(blocked.includes("这些写工具还活跃：bash、write"), blocked);
	const noMarker = modeStatusText({ ...base, engaged: false, markerActive: false, activeTools: ["read"] });
	assert.ok(noMarker.includes("标记未激活"), noMarker);
	const turnedOff = modeStatusText({ ...base, mode: "off", engaged: false, markerActive: true, activeTools: ["read"] });
	assert.ok(turnedOff.includes("/orchestrator off 关掉了"), turnedOff);
});

test("子代理工具并集剔除派发与管理类工具（禁止再往下派）", () => {
	const allowed = childAllowedTools(["read", "bash", "subagent", "subagents_enable", "subagent_supervisor", "bg_wait", "orchestrator"]);
	assert.deepEqual(allowed, ["read", "bash"]);
});
