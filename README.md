# pi-teammate

编排器模式的 pi 扩展：主代理变成项目经理——只接需求、拆活、派活、核验、汇总，**不写代码**。改代码、跑命令、写文件都交给 pi-subagents 的子代理。

- 不新增派发器：派活一律走已有的 [pi-subagents](https://github.com/nicobailon/pi-subagents)。
- 不靠提示词自觉：白名单外的工具在 `tool_call` 层被拦，`subagent` 的命名 workflow 与配置写入类 action 也被拦。
- 不改宿主：pi CLI 与 pi-web-gui 都支持，不改 pi-web-gui 代码，不改 pi-subagents 源码或全局配置。

## 安装

1. 装包（会用 `~/.pi/agent/settings.json` 的 `packages` 记录来源）：

   ```bash
   pi install git:github.com/Hhidysn/pi-teammate
   ```

2. 装验证角色档案（可选但推荐，`verify` 角色默认映射到它）：

   ```bash
   cp ~/.pi/agent/git/github.com/Hhidysn/pi-teammate/agents/verifier.md ~/.pi/agent/agents/
   ```

   路径说明：`pi install git:<host>/<user>/<repo>` 把仓库克隆到 `~/.pi/agent/git/<host>/<user>/<repo>`（本项目即 `~/.pi/agent/git/github.com/Hhidysn/pi-teammate`）；若改用 `pi install npm:...`，安装目录是 `~/.pi/agent/npm/node_modules/pi-teammate`。按你的实际安装目录替换上面的路径即可。

## 进入编排器模式

**推荐（两个宿主通用）**：在 `~/.pi/agent/settings.json`（或项目 `.pi/settings.json`）里写：

```json
"defaultTools": ["+orchestrator", "-bash", "-edit", "-write"]
```

pi-web-gui 的下拉保持 `configured` 即可。之后下拉本身就是模式选择器：

| 下拉预设 | 结果 |
| --- | --- |
| `configured` / `read-only` | 编排器模式（没有 bash/edit/write） |
| `default` / `full` | 普通会话（有写工具，模式不开启） |
| `chat-only` | 纯聊天 |

**只想这一次生效**：

```bash
pi --tools read,grep,find,ls,subagent,bg_wait,web_search,fetch_content,source_check,orchestrator "你的需求"
```

（pi 1.0.4 的 `--tools` 是纯 allowlist，不支持 `+name`/`-name`，所以要写全；`defaultTools` 支持 `+`/`-`。）

**随时开关**：`/orchestrator on|off|status`（不带参数则切换）。关闭会恢复进入前的工具集。

## 配置

`~/.pi/agent/pi-teammate.json`，项目可用 `.pi/pi-teammate.json` 覆盖（后者优先）。全部字段可选：

```json
{
  "keepTools": ["read", "grep", "find", "ls", "web_search", "fetch_content", "source_check", "subagent", "bg_wait"],
  "entryBlockingTools": ["edit", "write"],
  "roles": { "design": "architect", "implement": "worker", "research": "researcher", "recon": "scout", "review": "reviewer", "verify": "verifier" },
  "helpers": ["council-gpt", "council-deepseek"],
  "referencesDir": "~/.agents/skills/i-wish/references",
  "allowNamedWorkflows": false,
  "bashPolicy": "none",
  "bashAllow": [],
  "blockedSubagentActions": ["create", "update", "delete", "eject", "disable", "enable", "reset", "refine", "refine.show", "refine.rollback", "schedule.create", "schedule.update", "schedule.delete"]
}
```

| 字段 | 作用 |
| --- | --- |
| `keepTools` | 模式内保留的工具，改这一个字段就等于改白名单**和**门禁（同源）。加进写工具会失去「不写代码」的保证，启动时会提示。 |
| `entryBlockingTools` | 这些工具活跃时不自动进入模式（默认 `edit`/`write`）。宿主会往新会话里塞 shell（pi-web 实测如此），所以 shell 不在默认名单里：模式一旦进入就用白名单把它收敛掉。 |
| `roles` | 角色 → 子代理名。默认复用已有 agent 定义；`verify` 需要能跑命令的角色。 |
| `helpers` | 额外可派的协助者（不进五步流程），会进子代理允许名单和 policy 文本。例如 `["council-gpt", "council-deepseek"]`。 |
| `referencesDir` | i-wish 参考目录；存在时注入「设计与拆分读 plan.md、验证读 build.md」的指引。 |
| `allowNamedWorkflows` | 默认 `false`：`subagent` 的命名 workflow（如 `run-ci`）会让宿主直接执行命令，模式内禁用。文件路径脚本不受此限制。 |
| `bashPolicy` | `none`（默认，编排器没有 bash）或 `allowlist`（只读命令白名单；需要时自动把 `bash` 加进 `keepTools`）。 |
| `bashAllow` | 在默认只读名单之外**额外**放行的命令前缀（例如 `npm test`）。加任何东西都会削弱保证。 |
| `blockedSubagentActions` | `subagent` 上被拦的 action，默认是会写宿主配置或计划表的那批。 |

## 编排器在模式内能做什么

- 保留：`read`、`grep`、`find`、`ls`（看文件）、`web_search`、`fetch_content`、`source_check`（核一手来源）、`subagent`、`bg_wait`、`subagent_supervisor`（派活与收活）。
- `bashPolicy: "allowlist"` 时额外给 `bash`，但**只放行只读命令**：`git status/diff/log/show/ls-files/branch`、`ls/cat/head/tail/wc/rg/grep/find/tree/stat` 等；重定向、`sed -i`、`rm/mv/cp`、`git commit/push`、包安装、`--fix/--write`、命令替换一律拦下。实测：`git log --oneline -2` 放行，`git push origin main` 被拦。
- 拦掉：`bash`、`powershell`、`edit`、`write` 等一切白名单外的工具。
- 子代理侧：注册 pi-subagents 的会话级能力天花板——只能派映射里的角色，且子代理拿不到派发工具（不会出现孙代理）。

## 已知边界

- **编排器只有只读的「看」能力**：默认没有 bash；开了 `bashPolicy: "allowlist"` 也只能看（git 历史/diff、读文件、搜索），**跑不了测试**（`npm test`、`pwsh .../run_godot_tests.ps1` 这类入口不在默认名单里），也改不了文件。全量测试由 `verify` 角色跑并交回命令、cwd、退出码与输出位置；需要看代码分布时派 `scout`。
- **只读 bash 是启发式，不是安全保证**：被放行的命令可能自己调项目脚本写文件（`npm test` 的 pretest/posttest、构建产物、git 的 textconv/外部 diff）。默认名单只放「看」；要跑测试就用 `bashAllow` 显式加，加的时候就接受了这个风险。
- **派发形态**：优先 `subagent({agent, task})`、`tasks: [...]`（并行）、`chain: [...]`（顺序）；内联 workflow（`workflow: true` + 回复正文里的 js 块）在真实会话里失败过，不建议；命名 workflow（`run-ci` 等）会执行宿主命令、已被拦；文件路径脚本（`workflow: "./flow.js"`）没有宿主命令权限，放行。
- **不能写文件**：设计文档、任务记录这类产物由 `worker` 落地，编排器审内容。
- 能力天花板依赖 pi-subagents 的公共接口（`src/api/capability-ceiling.js`，按 globalThis 注册表共享）。找不到时会警告，此时用角色档案的 `maxSubagentDepth: 1` 兜底。
- 旧的 pi（< 0.86.1）缺少 `getActiveTools`/`setActiveTools` 时不做工具收敛，模式不生效。

## 开发

```bash
node --test test/gate.test.ts test/config.test.ts   # 门禁与配置的纯逻辑
```

契约与机制见 [docs/design.md](docs/design.md)。
