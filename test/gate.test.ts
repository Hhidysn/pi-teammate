import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.ts";
import {
	bashBlockReason,
	childAllowedTools,
	effectiveKeepTools,
	modeStatusText,
	shouldEngage,
	splitCommandSegments,
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
	const scriptsOn = { workflowScriptsDisabled: false };
	assert.ok(subagentBlockReason({ workflow: "run-ci", args: { command: "npm test" } }, config, scriptsOn)?.includes("命名 workflow"));
	assert.equal(subagentBlockReason({ workflow: "./scripts/flow.js" }, config, scriptsOn), undefined, "路径脚本没有宿主命令权限，放行");
	assert.equal(subagentBlockReason({ workflow: "scripts\flow.js" }, config, scriptsOn), undefined, "Windows 风格路径同样放行");
	assert.ok(subagentBlockReason({ action: "config.update" }, config, scriptsOn) === undefined);
	assert.ok(subagentBlockReason({ action: "update" }, config, scriptsOn)?.includes("update"));
	assert.equal(subagentBlockReason({ agent: "worker", task: "改这个" }, config, scriptsOn), undefined);
	assert.equal(subagentBlockReason({ workflow: true }, config, scriptsOn), undefined, "workflow-scripts 可用时内联脚本放行");
	assert.equal(subagentBlockReason({ action: "list" }, config, scriptsOn), undefined);
});

test("subagent：按 pi-subagents 的 workflow-scripts 配置拦下注定失败的形态", () => {
	const config = defaultConfig();

	// 未禁用 workflow-scripts（默认）：顶层 tasks/chain 会被 pi-subagents 拒绝 → 提前拦下并指正确形态
	const scriptsOn = { workflowScriptsDisabled: false };
	const tasksReason = subagentBlockReason({ tasks: [{ agent: "worker", task: "x" }] }, config, scriptsOn);
	assert.ok(tasksReason?.includes("workflow-scripts 未禁用"), tasksReason);
	assert.ok(tasksReason?.includes("workflow: true"), tasksReason);
	assert.ok(subagentBlockReason({ chain: [{ agent: "worker", task: "x" }] }, config, scriptsOn)?.includes("未禁用"));
	assert.equal(subagentBlockReason({ workflow: true }, config, scriptsOn), undefined);
	assert.equal(subagentBlockReason({ workflow: "./flow.js" }, config, scriptsOn), undefined);
	assert.ok(subagentBlockReason({ workflow: "run-ci" }, config, scriptsOn)?.includes("命名 workflow"));

	// 已禁用 workflow-scripts：脚本/命名资源不可用 → tasks/chain 才是正确形态
	const scriptsOff = { workflowScriptsDisabled: true };
	const wfReason = subagentBlockReason({ workflow: true }, config, scriptsOff);
	assert.ok(wfReason?.includes("已禁用 workflow-scripts"), wfReason);
	assert.ok(wfReason?.includes("tasks"), wfReason);
	assert.ok(subagentBlockReason({ workflow: "./flow.js" }, config, scriptsOff)?.includes("已禁用 workflow-scripts"));
	assert.ok(subagentBlockReason({ workflow: "run-ci" }, config, scriptsOff)?.includes("已禁用 workflow-scripts"));
	assert.equal(subagentBlockReason({ tasks: [{ agent: "worker", task: "x" }] }, config, scriptsOff), undefined);
	assert.equal(subagentBlockReason({ chain: [{ agent: "worker", task: "x" }] }, config, scriptsOff), undefined);
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

test("只读 bash：补常用只读前缀（cd / sed -n / git config --get / git describe 等）", () => {
	const config = defaultConfig();
	config.bashPolicy = "allowlist";
	assert.equal(bashBlockReason("cd ~/projects/pi-teammate && git log -1", config), undefined, "cd 分段后要看 git log");
	assert.equal(bashBlockReason("sed -n 1,20p src/gate.ts", config), undefined, "sed -n 是只读打印");
	assert.equal(bashBlockReason("git config --get user.name", config), undefined);
	assert.equal(bashBlockReason("git config --list", config), undefined);
	assert.equal(bashBlockReason("git describe --tags --always", config), undefined);
	assert.equal(bashBlockReason("git cat-file -p HEAD", config), undefined);
	assert.equal(bashBlockReason("echo done", config), undefined);
	assert.equal(bashBlockReason("jq -r .name package.json", config), undefined);
	assert.equal(bashBlockReason("sha256sum a.txt", config), undefined);
	assert.equal(bashBlockReason("diff a.txt b.txt", config), undefined);
});

test("只读 bash：新增前缀不放宽写操作", () => {
	const config = defaultConfig();
	config.bashPolicy = "allowlist";
	assert.ok(bashBlockReason("sed -i s/a/b/ f.txt", config)?.includes("写入/破坏性"), "sed -i 仍被拒模式挡住");
	assert.ok(bashBlockReason("git config user.name x", config)?.includes("不在只读白名单里"), "普通 git config 写操作不在前缀里");
	assert.ok(bashBlockReason("git config --unset user.name", config)?.includes("不在只读白名单里"));
	assert.ok(bashBlockReason("echo hi > out.txt", config)?.includes("写入/破坏性"), "重定向仍被拒模式挡住");
	assert.ok(bashBlockReason("git push origin main", config)?.includes("写入/破坏性"));
});

test("只读 bash：分段器只在引号外切分", () => {
	assert.deepEqual(splitCommandSegments('rg -n "a|b" x && ls'), ['rg -n "a|b" x', "ls"]);
	assert.deepEqual(splitCommandSegments("echo 'x|y'; pwd"), ["echo 'x|y'", "pwd"]);
	assert.deepEqual(splitCommandSegments("echo a || echo b"), ["echo a", "echo b"]);
	assert.deepEqual(splitCommandSegments("a;b\nc|d"), ["a", "b", "c", "d"]);
	assert.deepEqual(splitCommandSegments("echo \"it's\""), ["echo \"it's\""], "双引号内的单引号不结束引号");
});

test("只读 bash：引号内的 | 不切段（真实故障：rg -n \"SAFE|isSafeCommand\"）", () => {
	const config = defaultConfig();
	config.bashPolicy = "allowlist";
	assert.equal(bashBlockReason('rg -n "SAFE|isSafeCommand" -A 20 src/', config), undefined);
	assert.equal(bashBlockReason("grep -E 'a|b' src/", config), undefined);
	assert.equal(bashBlockReason("git diff | head", config), undefined, "引号外的单管道仍拆段，两段都在名单里则放行");
	assert.ok(bashBlockReason("cat a.txt | tee b.txt", config)?.includes("写入/破坏性"), "管道后的 tee 仍被拒");
	assert.ok(bashBlockReason("ls | xargs rm -rf", config)?.includes("写入/破坏性"), "管道后的 rm 仍被拒");
	assert.ok(
		bashBlockReason('echo "a>b"', config)?.includes("写入/破坏性"),
		"引号内的 > 仍被拒模式当成重定向：拒绝模式跑在原始命令串上，不做引号感知（保守拦下）",
	);
});

test("只读 bash：新增只读前缀生效（du/df/系统/版本/包查询）", () => {
	const config = defaultConfig();
	config.bashPolicy = "allowlist";
	for (const cmd of [
		"du -sh src",
		"df -h",
		"whereis git",
		"type node",
		"date",
		"uname -a",
		"whoami",
		"ps aux",
		"bat src/gate.ts",
		"eza -l",
		"node --version",
		"python --version",
		"npm list",
		"npm ls",
		"npm view typescript",
		"npm info react",
		"npm outdated",
	]) {
		assert.equal(bashBlockReason(cmd, config), undefined, cmd);
	}
	for (const cmd of ["curl https://example.com", "wget https://example.com", "less src/gate.ts", "more src/gate.ts", "top", "htop"]) {
		assert.ok(bashBlockReason(cmd, config)?.includes("不在只读白名单里"), `${cmd} 不应在名单里`);
	}
});

test("只读 bash：新增拒绝模式（git 破坏性 / 提权 / 进程 / 服务 / 编辑器 / 包管理）", () => {
	const config = defaultConfig();
	config.bashPolicy = "allowlist";
	for (const cmd of [
		"git pull",
		"git merge main",
		"git rebase main",
		"git cherry-pick abc123",
		"git revert HEAD",
		"git tag v1.0.0",
		"git init",
		"git clone https://example.com/x.git",
		"sudo rm -rf /tmp/x",
		"su root",
		"kill -9 1234",
		"pkill node",
		"killall node",
		"reboot",
		"shutdown -h now",
		"systemctl restart nginx",
		"service nginx restart",
		"vim src/gate.ts",
		"vi src/gate.ts",
		"nano src/gate.ts",
		"emacs src/gate.ts",
		"code .",
		"subl src/",
		"shred -u secret.txt",
		"chgrp staff file.txt",
		"ln -s a b",
		"npm update",
		"npm link",
		"npm publish",
		"npm uninstall left-pad",
		"yarn add lodash",
		"yarn publish",
		"pnpm install",
		"apt install curl",
		"apt-get remove vim",
		"apt purge nginx",
		"apt-get upgrade",
		"brew install jq",
		"brew uninstall jq",
		"brew upgrade",
	]) {
		assert.ok(bashBlockReason(cmd, config)?.includes("写入/破坏性"), cmd);
	}
	assert.equal(bashBlockReason("git status", config), undefined, "新增拒绝模式没误伤 git 查看类");
	assert.equal(bashBlockReason("git describe --tags --always", config), undefined, "--tags 不被 git tag 规则误伤");
});

test("子代理工具并集剔除派发与管理类工具（禁止再往下派）", () => {
	const allowed = childAllowedTools(["read", "bash", "subagent", "subagents_enable", "subagent_supervisor", "bg_wait", "orchestrator"]);
	assert.deepEqual(allowed, ["read", "bash"]);
});
