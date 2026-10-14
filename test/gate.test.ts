import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.ts";
import {
	bashBlockReason,
	childAllowedTools,
	effectiveKeepTools,
	modeStatusText,
	shouldEngage,
	subagentBlockReason,
	toolBlockReason,
} from "../src/gate.ts";

const WRITE = ["edit", "write"];
const READONLY = ["read", "grep", "find", "ls"];
const ORCH = "orchestrator";

test("E2：auto 只在「标记活跃且没有文件写工具」时进入", () => {
	assert.equal(
		shouldEngage({ state: "auto", markerActive: true, activeTools: [ORCH, ...READONLY], entryBlockingTools: WRITE }),
		true,
	);
	assert.equal(
		shouldEngage({ state: "auto", markerActive: true, activeTools: [ORCH, ...READONLY, "bash"], entryBlockingTools: WRITE }),
		true,
		"宿主塞进来的 shell 单独活跃时不拦进入，模式会把它收敛掉",
	);
	assert.equal(
		shouldEngage({ state: "auto", markerActive: true, activeTools: [ORCH, ...READONLY, "bash", "edit"], entryBlockingTools: WRITE }),
		false,
		"GUI 选了 full/default（带 edit/write）时不进入，尊重用户的预设",
	);
	assert.equal(shouldEngage({ state: "auto", markerActive: false, activeTools: [...READONLY], entryBlockingTools: WRITE }), false);
});

test("on/off 覆盖 auto", () => {
	assert.equal(shouldEngage({ state: "on", markerActive: false, activeTools: ["bash"], entryBlockingTools: WRITE }), true);
	assert.equal(shouldEngage({ state: "off", markerActive: true, activeTools: [...READONLY], entryBlockingTools: WRITE }), false);
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
	assert.equal(subagentBlockReason({ workflow: "./scripts/flow.js" }, config), undefined, "路径脚本没有宿主命令权限，放行");
	assert.equal(subagentBlockReason({ workflow: "scripts\flow.js" }, config), undefined, "Windows 风格路径同样放行");
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
		entryBlockingTools: ["edit", "write"],
	};
	const on = modeStatusText({ ...base, engaged: true, markerActive: true, activeTools: base.keepTools });
	assert.ok(on.includes("工具(2)：read、subagent"), on);
	const blocked = modeStatusText({ ...base, engaged: false, markerActive: true, activeTools: ["read", "edit", "write"] });
	assert.ok(blocked.includes("写文件的工具还活跃（edit、write）"), blocked);
	const noMarker = modeStatusText({ ...base, engaged: false, markerActive: false, activeTools: ["read"] });
	assert.ok(noMarker.includes("标记未激活"), noMarker);
	const turnedOff = modeStatusText({ ...base, mode: "off", engaged: false, markerActive: true, activeTools: ["read"] });
	assert.ok(turnedOff.includes("/orchestrator off 关掉了"), turnedOff);
});

test("只读 bash：放行看代码/看历史，拦住写入与命令替换", () => {
	const config = defaultConfig();
	config.bashPolicy = "allowlist";
	assert.equal(bashBlockReason("git diff --stat", config), undefined);
	assert.equal(bashBlockReason("git log --oneline -5 | head -3", config), undefined);
	assert.equal(bashBlockReason("rg -n TODO src/", config), undefined);
	assert.ok(bashBlockReason("git push origin main", config)?.includes("写入/破坏性"));
	assert.ok(bashBlockReason("echo hi > out.txt", config)?.includes("写入/破坏性"));
	assert.ok(bashBlockReason("cat a.txt | tee b.txt", config)?.includes("写入/破坏性"));
	assert.ok(bashBlockReason("sed -i s/a/b/ f.txt", config)?.includes("写入/破坏性"));
	assert.ok(bashBlockReason("echo $(cat x)", config)?.includes("写入/破坏性"));
	assert.ok(bashBlockReason("npm test", config)?.includes("不在只读白名单里"));
	assert.ok(bashBlockReason("pwsh tools/run_godot_tests.ps1", config)?.includes("不在只读白名单里"));
	config.bashAllow = ["npm test"];
	assert.equal(bashBlockReason("npm test", config), undefined, "配置里额外放行的前缀生效");
	assert.ok(bashBlockReason("", config) === "空命令。");
});

test("子代理工具并集剔除派发与管理类工具（禁止再往下派）", () => {
	const allowed = childAllowedTools(["read", "bash", "subagent", "subagents_enable", "subagent_supervisor", "bg_wait", "orchestrator"]);
	assert.deepEqual(allowed, ["read", "bash"]);
});
