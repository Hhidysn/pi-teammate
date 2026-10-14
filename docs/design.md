# 设计：编排器模式（pi-teammate）

只写已实现的契约与机制；调研来源、质询发现、决策理由与已否决方案见文末「决策与来源」。

## 目的与边界

主代理在模式内是项目经理：接需求、拆活、派活、核验、汇总，**不写代码、不跑命令、不写文件**。派活复用 pi-subagents，不新增派发器。支持 pi CLI 与 pi-web-gui 两个宿主，不改宿主代码。

不在范围内：worker 常驻池、模型档位路由（fast/good）、任务台账或看板、TUI 面板、GUI 下拉新增项、复制 i-wish 的参考文件。

## 契约

### 入口

- 标记工具 `orchestrator`（`exposure: "model-only"`、`defaultActive: false`、自身声明被 `prepareLoadout.hiddenDeclarations` 隐藏）。它在活跃集里表示「这台机器/这个项目要用编排器模式」。
- 推荐配置 `"defaultTools": ["+orchestrator", "-bash", "-edit", "-write"]`；pi-web-gui 里选 `configured` 即生效。
- CLI 一次生效：`pi --tools read,grep,find,ls,subagent,bg_wait,web_search,fetch_content,source_check,orchestrator`。
- 会话内：`/orchestrator on|off|status`。

### 进入规则（E2）

`shouldEngage`：显式 `on` 直接进入；`off` 不进入；`auto`（默认）要求「标记活跃」且「当前没有 `entryBlockingTools`（默认 `edit`/`write`）里的工具活跃」。后半句是尊重宿主预设——用户在 GUI 选 `full`/`default` 就是想要普通会话，选 `configured`/`read-only` 才是编排器模式。shell 工具不在默认名单里：pi-web 会给新会话带一个 shell（实测：settings.json 未被改写、来源未定位），而模式一旦进入就用白名单把它收敛掉。

### 模式内的工具（白名单）

`keepTools`（默认 `read`、`grep`、`find`、`ls`、`web_search`、`fetch_content`、`source_check`、`subagent`、`bg_wait`、`subagent_supervisor`）∩ 已注册，加标记，加 pi-subagents 的冷启动加载器（若注册了）。白名单同时是门禁依据，不存在第二份配置。

### 状态

模式状态是显式的，写在会话条目 `pi-teammate:mode`（`{ mode, previousTools }`），`session_start` 从 `getBranch()` 最后一个该类型条目重建，因此分支切换、resume、reload 各自独立；标记本身只作 `auto` 的进入依据。`/orchestrator off` 恢复进入前的工具集（快照），并把状态置为 `off`。

## 机制

1. **Reduction**：`before_agent_start` 幂等把活跃集和 `event.systemPromptOptions.selectedTools` 都钉成白名单。同时写 `selectedTools` 是因为 pi 的规则是「显式改 selectedTools 者优先，否则以实时 loadout 为准」；加载器留在白名单里是为了不与 pi-subagents 的每轮重放抢声明（顺序无关）。
2. **Gate**：`tool_call` 拦白名单外的一切调用（嵌套调用也走这里），返回派发引导。
3. **参数级准入**：`subagent` 再按参数拦——`workflow` 为字符串时是命名资源（如 `run-ci` 走 `runs.host` → `spawn(shell)`），默认禁用；`blockedSubagentActions` 里的 action 会写宿主配置或计划表，也禁用。内联脚本（`workflow: true`）没有宿主命令权限，放行。
4. **子代理能力天花板**：进入模式时注册 pi-subagents 的会话级 `capabilityCeiling`（`allowedTools` = 当前注册工具剔除 `subagent`/`subagents_enable`/`subagent_supervisor`/`bg_wait`/标记；`allowedAgents` = 映射角色）。子代理因此拿不到派发工具（`fanoutAuthorized` 为假），也不会出现孙代理。退出时 `dispose()`。
5. **Policy**：`before_agent_start` 往 `systemPromptOptions.sections.pi_teammate` 写一段规则（身份、角色与派活时机、派活契约、i-wish 阶段对齐、汇总格式）。进入模式时算一次，逐轮复用，保持提示前缀稳定。
6. **就绪检查**：没有 `subagent`（pi-subagents 未装/未加载）时不进入模式并提示；能力天花板接口取不到时警告，提示用角色档案 `maxSubagentDepth: 1` 兜底；白名单里含写工具时提示「等于放弃不写代码的保证」。

## 能力边界（诚实的部分）

- 保证的是「主代理不能通过宿主工具改代码/跑命令」；不保证子代理的任意 shell 不写文件（那是 worker/verifier 的职责），也不做 OS 级隔离。
- 编排器可以通过 `subagent` 的 `output` 让子代理把结果写到文件——写的是报告，不是代码。
- 编排器自己不能跑测试或看 `git diff`，所以终局验证由 `verify` 角色执行并交回命令、cwd、退出码、原始输出位置。

## 验收

| 编号 | 检查 | 通过条件 |
| --- | --- | --- |
| A1 | 入口：settings 配方 / CLI 配方 / GUI 预设矩阵 | 首轮请求里 `pi_teammate` 章节存在；活跃工具精确等于白名单；`full`/`default` 不进模式，`read-only` 进 |
| A2 | 硬拦 | 尝试 `write`/`bash` 等被拦且**没有实际执行**（文件不存在、无副作用）；仅「工具不存在」不算证据 |
| A3 | `subagent` 参数准入 | 命名 workflow 与配置写入 action 被拒；派活、内联脚本、查询、等待放行 |
| A4 | 生命周期 | `/orchestrator off` 恢复原工具集、`on` 重新收敛；重复开关稳定；reload / resume / 树导航后状态与工具集正确；两个会话互不污染 |
| A5 | 子代理侧 | 子代理拿不到派发工具，不产生孙代理；映射外的角色被拒 |
| A6 | 端到端 | 一个真实小任务走通 需求确认 → architect → worker → reviewer → verifier → 汇总；代码改动只由子代理落地；verifier 交回命令/退出码/输出位置，故意失败必须使验收失败 |

A1–A5 在 G1 阶段由独立验证者跑确定性检查；A6 在 G2 阶段跑真实任务与 GUI 手测。

### G1 验证证据（2026-10-14，独立验证者，新上下文）

被验版本（无 git，按 sha256 冻结）：`src/index.ts` 3838c10c…、`src/gate.ts` 2eb9b09e…、`src/config.ts` 85c0f0ba…、`test/gate.test.ts` 8a20ad83…。宿主 pi 1.0.4、pi-subagents 0.76.1、node 24.13.0；原始输出在 `/tmp/pi-teammate-g1/out/`。

结论：A1–A5 **无失败**。要点：

- 入口：settings 配方与 CLI allowlist 配方的首轮请求工具集精确等于白名单、`sections` 含 `pi_teammate`；无标记、以及「标记 + 写工具活跃」都不进入模式。
- 硬拦：临时扩展把 `write` 与一个带副作用的探针工具强塞进活跃集和 `selectedTools`（该请求的 `<tools>` 章节确实列出了二者），模型也真的调用了，两次都在 `tool_call` 层被拦；副作用文件不存在、探针 `execute()` 未运行。
- 参数准入：命名 workflow 与配置写入 action 被拒；`list` 查询与真实单代理派发放行。
- 生命周期：`off` 后快照原样恢复（写工具回来），`on` 后收敛，连开关稳定，resume 按分支条目重建（`on`/`off` 各自正确），两个会话互不污染。
- 子代理侧（静态）：天花板注册内容里 `subagent`/`subagent_supervisor`/`bg_wait`/标记已被剔除，`allowedAgents` 等于角色映射；退出时注册表清空；pi-subagents 确实消费它（`advertised_subagents` 缩减为交集）。

观察（非失败）：回合间窗口内其它扩展可能把非白名单工具重新激活（例如 `get_search_content`），下一次 `before_agent_start` 会收敛，且 `tool_call` 门禁始终拦住它；请求面的工具集始终等于白名单。

未覆盖，留给 G2：GUI 预设矩阵本身（经 pi-web-gui 的 `carriedToolNames`）、`--reload` 与树导航后的状态、内联脚本与 `bg_wait` 的放行、真实孙代理与映射外角色被拒、配置文件覆盖链的端到端。

### G2 验证证据（2026-10-14，真实项目 desktop-dice）

任务：检视 desktop-dice 的未提交变更（11 个改动 + 8 个新增）并提交推送到 `origin/main`；只在编排器模式下运行（全局 settings 的 `packages` + `defaultTools` 生效，未用 `-e`）。

结果：编排器走完 scout（事实底稿）→ reviewer（静态审查，无阻断项，2 条 P2）→ verifier（headless 定向测试）→ worker（3 个原子提交 + 推送）→ verifier（换新上下文复核）→ 汇总。产出 3 个提交 `ffc7367`/`c27f80b`/`537e1a6`，推送 `091101c..537e1a6 main -> main`。编排器自己未调用任何写工具。

独立复核（主代理）：`git log`/`git status`/`git rev-parse HEAD`/`git ls-remote origin refs/heads/main` 四处一致（远端 = 本地 = `537e1a6…`），工作区干净。

映射外角色被拒（A5 的行为证据）：在编排器会话里要求派 `delegate`，得到 `Capability ceiling from pi-teammate does not allow agent 'delegate'. Allowed agents: architect, council-deepseek, council-gpt, researcher, reviewer, scout, verifier, worker.`，`subagent({action:"list"})` 把它列在 Restricted agents 下，且未启动任何 run（mission failed）；编排器未自行干活，而是报告失败并给出选项。该输出同时确认了 `helpers` 字段已生效。

G2 未覆盖：GUI 预设矩阵与 `/reload`、树导航后的状态（需要交互式 TUI 与 GUI 手测）；带 `subagent` 工具的自定义角色档案下的「孙代理」行为检查（机制上由天花板剔除 `subagent` 阻断，G1 已验工具集剔除与注册内容）。

### 第二轮独立验证（2026-10-14，独立验证者 / verifier 新上下文）

冻结版本 `dc808fa`（工作区干净）；原始输出 `/tmp/pt-v2/out/`。

**已验证**

- **V1 进入条件回归**：标记活跃 + 只有 `bash` 活跃、无 `edit`/`write` → 进入，且请求面 `sections.tools` 无 `bash`（`getActiveTools()` 在 session_start 含 bash、before_agent_start 已收敛）。settings 配方（`{"+orchestrator","+bash","-edit","-write"}`）同样进入：`编排器模式：开启（auto）｜工具(10)：…`。
- **V2** 标记 + `edit` 或 `write` 活跃 → 不进入（分支无模式条目、请求面无 `pi_teammate`）。
- **V3 状态文案**：所有 notify 均单行；未进入的四种情形（标记未激活 / edit / write / edit+write / 被 off 关掉）原因与实际阻碍逐条一致。
- **V4 `/reload`**（用扩展命令调 `ctx.reload()`，同一 `session.reload()` 路径）：reload 后模式仍在、活跃集精确等于白名单、状态条目仍在分支、天花板重新注册。
- **V5 GUI 预设矩阵的 CLI 等价复核**：无写工具方向 → 进入；`edit`/`write` 方向 → 不进入。真实 GUI 矩阵由用户手工确认：`configured`/`read-only` 开、`default`/`full` 关、`chat-only` 不涉及扩展。
- **V6** 单测 `node --test`：12/12。

**失败并已修复（F1）**

- 现象：树导航到「开启模式之前」的分支（该分支无 `pi-teammate:mode` 条目）后，模式仍然生效：下一轮请求面含 `pi_teammate` 且工具被钉成白名单；期望是回到普通会话。
- 根因：`src/index.ts` 只在 `session_start`/`before_agent_start`/`tool_call` 上重建状态，没有 `session_tree` 处理器；而 pi 的 `navigateTree()` 只发 `session_tree` 不发 `session_start`，于是运行期的 `engaged` 标志跨分支沿用。
- 修复：新增 `session_tree` 处理器，与 `session_start` 共用 `rebuildFromBranch()`（按新分支最后一条模式条目重建 mode 与 previousTools，并 dispose 旧天花板），再走 `engageIfWanted()`；分支里已有条目时不再重复追加。
- 复现确认（用验证者的脚本，主代理执行，非独立）：`post-nav` 到无条目分支 → `ACTIVE=[read,bash,edit,write,…]`、天花板 `empty`、下一轮 `SECTIONS=[]`；导航回带 `mode:"on"` 的分支 → 重新收敛 + 天花板重新注册。

**非缺陷（裁量）**

- 状态文案在「已开启」时不含 `｜原因：`：那是第二轮任务书的措辞，契约（README / 本文件）只要求未进入时给出原因，故不视为缺陷。

**本轮未覆盖**

- 真实 GUI 进程里的预设取值（`carriedToolNames`）与 `chat-only`：未独立验证（用户手工确认预设矩阵，CLI 等价配方已验）。
- TUI 按键路径（`/reload` 键位、`/tree` 选择器 UI）：用 `ctx.reload()` / `ctx.navigateTree()` 等价路径替代，键位与渲染未覆盖。
- F1 修复的独立复核：上一条复现确认由主代理执行，若要完全独立，需再派一次验证。

## 决策与来源

| 决定 | 备选与否决理由 | 依据 |
| --- | --- | --- |
| 一层派发，不设组长层 | 两层多一跳转述、成本翻倍，且文件归属更难说清；pi-subagents 的嵌套默认深度为 2 且规则写明「普通子代理不是编排器」 | `pi-subagents/docs/configuration.md:480`；oh-my-opencode-slim 也是严格两层（`src/agents/role-routing.ts`） |
| 自建轻量插件，不复用 `@saifymatteo/pi-orchestrator` | 它自建 `pi --mode rpc` 派发通道并强制保留 `delegate`，与「复用 pi-subagents 的角色与模型路由」冲突；MIT，仅借鉴其三层结构 | npm registry + 其 README（2026-10-14） |
| 进入规则 E2（按宿主预设） | 单靠标记会把 `full`/`default` 预设也收敛掉，违反「其它预设不变」 | `pi-web-gui/lib/rpc-manager.ts:267-285` 的 `carriedToolNames` |
| 编排器不给 bash | `npm test` 类命令经项目脚本可写文件，命令字符串白名单给不出只读保证；验证改由独立角色执行 | 质询复核 omp 的 `plan-mode-guard` 与 `npm test` 执行链 |
| 新增 `agents/verifier.md` | 现成 `evidence-auditor` 只查网页、不能跑命令，映射它等于假验证 | `pi-subagents/agents/evidence-auditor.md` 的 tools |
| 子代理用能力天花板而非改全局配置 | `disabledFeatures`、`maxSubagentDepth` 都是全局的，会改变非编排会话 | `pi-subagents/docs/configuration.md`；`src/runs/shared/capability-ceiling.js` 的 globalThis 注册表 |
| 隐藏自己的声明，不隐藏加载器 | 隐藏加载器会破坏普通会话（无 eager 配置时 `subagent` 靠它启用） | `pi-subagents/src/extension/tool-activation.js` |
| i-wish 参考按路径读，不复制内容 | 复制会产生两份源；角色档案预载 SKILL.md 会把「主代理做决策/停下等门禁」带进子代理 | `pi-coding-agent/docs/skills.md` 的按需加载模型 |

调研来源（访问日期 2026-10-14）：

- oh-my-opencode-slim `src/agents/orchestrator.ts`、`src/agents/role-routing.ts`、`src/agents/permissions.ts`；上游 oh-my-openagent（SUL-1.0，仅参考结构，不复制文本）。
- `can1357/oh-my-pi`：`docs/vibe-mode.md`（导演模式 = read-only 工具集 + worker 控制工具）、`packages/coding-agent/src/tools/plan-mode-guard.ts`（写拦截）。
- pi 官方：`docs/settings.md`、`docs/extensions.md`、`docs/skills.md`、`dist/core/agent-session.js`、`dist/core/extensions/types.d.ts`、`dist/extensions/tool-search/tool.js`。
- pi-web-gui：`lib/tool-presets.ts`、`lib/rpc-manager.ts`。
- pi-subagents 0.76.1：`src/extension/tool-activation.js`、`src/workflows/workflow-resources.js`、`src/workflows/host-command.js`、`src/runs/shared/capability-ceiling.js`。

独立设计质询（2026-10-14，architect / openai/gpt-6-astra）给出 6 条阻塞项：预设泄漏（C1）、reduction 优先级（C2）、`subagent` 内部执行宿主命令（F1）、模式状态自删除与恢复（F2）、一层派发无机制（F3）、验证角色能力不足（F4）。以上决定逐条对应处置，其中 F1/F3/F4 由代码机制关闭，C1/C2/F2 由入口规则、双写工具集与显式状态关闭。

## 未知项

- pi-web-gui 里本地 path 包的加载与扩展注册时序，以及 GUI 预设与逐轮收敛在树导航后的交互（U2/U5）。
- `before_agent_start` 每轮 `setActiveTools` 的请求开销（U1，源码上 sections 不变则不新增 system 消息，仍需一次请求体证据）。
- 能力天花板在真实派发中的效果（A5），需要一次实际派发来确认。
