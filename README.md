# pi_py 仓库总览

一个「两套 pi 实现 + 一个共享 Vue 前端」的仓库：一套用**原版 pi SDK**（Node，生产），
一套用 **Python 复刻的内核**（学习/参考），共用同一个 `/api` REST + SSE 协议和 `web/` 前端。

## 目录结构

```
pi_py/
├── web/                    # Vue 3 前端（两后端共用，VITE_BACKEND_URL 切换后端）
├── node-pi/               # 【Node 版·生产】原版 pi 能力
│   ├── server/           # Fastify + @earendil-works/pi-coding-agent 后端（端口 8001）
│   │   └── extensions/   # ★ 扩展目录：放进 .ts/.js 扩展即被后端自动加载
│   └── utools/           # uTools 桌面插件（拉起 node-pi/server + 加载 web 构建）
├── pi-python/            # 【Python 版·复刻】三层内核 + FastAPI 后端
│   ├── src/             # pi_ai → pi_agent → pi_coding_agent 三层内核
│   ├── server/          # FastAPI 后端（端口 8000）
│   ├── tests/           # unit（内核）/ integration（后端）/ compat（JSONL 兼容）
│   └── pyproject.toml   # Python 项目配置（README 见该目录）
├── scripts/               # 启动/运维脚本（dev、production、smoke）
└── docs/                  # 架构与实施文档
```

## 两个后端怎么选

| | Node 版（生产） | Python 版（复刻） |
|---|---|---|
| 目录 | `node-pi/server` | `pi-python/server` |
| 实现 | 原版 `@earendil-works/pi-coding-agent` SDK | 自研三层内核 + FastAPI |
| 端口 | 8001 | 8000 |
| 前端切换 | `VITE_BACKEND_URL=http://127.0.0.1:8001` | `VITE_BACKEND_URL=http://127.0.0.1:8000`（默认） |
| 用途 | 实际运行 | 学习复刻、兼容验证 |

两个后端都复用原版 pi 的 `~/.pi/agent`（auth.json / models.json / sessions），只读不污染。

## 快速开始

### Node 版（生产）

```powershell
cd node-pi/server
npm install
npm run dev          # 后端 http://127.0.0.1:8001

cd ../../web         # 另开终端，起前端
npm install
npm run dev          # http://127.0.0.1:5173
```

或一键脚本（拉起后端 + 前端，自动等待健康检查）：

```powershell
.\scripts\start-node-dev.ps1
```

### Python 版（复刻）

```powershell
cd pi-python
python -m pip install -e ".[dev]"
python -m uvicorn server.main:app --host 127.0.0.1 --port 8000
```

```powershell
# 另开终端，起前端
cd web
npm install
npm run dev
```

或一键脚本：`.\scripts\start-dev.ps1`（开发）/ `.\scripts\start-production.ps1`（构建前端后同源托管）。

Python 版详细说明见 [`pi-python/README.md`](pi-python/README.md)。

## 扩展（给 Node 版加能力）

Node 版后端把工具审批、Plan 模式与 MCP 工具以**内联扩展**注入每个会话（闭包直连服务单例），
注册点集中在 `OriginalPiSessionFactory.loader()` 的 `extensionFactories`，并支持按预设开关
（`extensions.approval` / `extensions.planMode`）启用/关闭；MCP 服务还可按预设选择白名单
（预设的 `mcpServers` 字段：null = 全部，[] = 禁用，非空数组 = 服务名白名单）。

- 原版 pi（TUI）的 `~/.pi/agent/extensions/` 与项目 `.pi/extensions/` 仍由 SDK 自动发现；
  仓库不再随服务发布 jiti 文件扩展。
- 机制说明见 [`docs/node-extension-system.md`](docs/node-extension-system.md)。

## 用量与可观测性（M1）

Node 版把每次运行的**成本、延迟、工具成功率、审批命中率**沉淀成本地 trace：事件在
`AgentRegistry.publish()` 处记账（fire-and-forget，不侵入 Agent 主链路），写入
`~/.pi/agent-node-server/platform.db`（SQLite，WAL）。前端入口：**设置 → 用量**。

```powershell
# 默认即开启；关闭或换存储方式：
$env:PI_NODE_TRACE = '0'        # 关闭（行为与引入前一致，接口返回空集）
$env:PI_NODE_STORE = 'memory'   # 内存实现（无盘环境）
$env:PI_NODE_TRACE_CONTENT = '1'  # 额外保留已脱敏正文（默认只存 digest + 120 字符预览）
```

默认不落对话正文、不落密钥；库文件与 trace 均不碰 `~/.pi/agent`。
实现说明与全部配置见 [`docs/node-observability-m1.md`](docs/node-observability-m1.md)。

## 任务（M2）

「任务」是会话里的一等公民：目标 + 步骤（带状态、验证声明、完成证据），状态由步骤聚合，
写入带版本号（并发冲突返回 `409 task_conflict`）。前端入口：聊天输入框上方的**任务面板**
（可新建任务、推进步骤、取消任务）；接口在 `/api/tasks`，变更通过 SSE `task_updated` 实时推送。
任务落在同一个 `platform.db`（与 trace 同库不同表），因此**重启不丢**、`runs.task_id` 可关联。
执行/断点续跑（租约、`/resume`、`/recovery`）属于 M3；完成声明的实际校验属于 M4。

实现说明见 [`docs/node-task-domain-m2.md`](docs/node-task-domain-m2.md)。

## 断点续跑（M3）

进程崩溃/重启后不会「忘记跑到哪」：任务有**执行租约**（防双跑、崩溃后自动过期），
执行中的动作会留下**在飞标记与副作用分级**（只读 / 写入 / 未知）。
重启时启动扫描给出**待恢复清单**（只列不跑），前端面板提示「上次运行被中断」并提供
[继续执行] / [重试当前步骤]：

- 中断在两步之间 → 可直接继续；
- 中断在写操作上且步骤声明了产物（`verification.kind='file'`）→ 先验证产物：
  **在就补记完成（绝不重跑）**，不在就把任务标为 blocked 要人确认；
- 无法判定副作用 → 必须显式确认（`confirmSideEffect`），不会自动重放写操作。

接口：`GET /api/tasks/recovery`、`POST /api/tasks/:id/resume`（202）+ SSE `task_recovery_required`。
说明见 [`docs/node-task-recovery-m3.md`](docs/node-task-recovery-m3.md)。

## Plan 模式（M4 重构）

计划不再是「模型写 `Plan:` 标题、系统用正则解析」，而是 **Task 的受控视图 + 结构化工具**：

- **发送时选择执行方式**：输入框的 `[直接执行 | 先规划]`（记住上次选择）或 `/plan` 前缀；
  **新会话也能直接规划**，不再需要先开开关再发消息。
- **规划期只读**：Agent 只读调研、可以跑验证类命令（`tsc --noEmit` / `pnpm test` / `npm run build`），
  不能改工作区；写操作与 MCP 工具一律拦截（能力分类判定，不是白名单比对）。
- **计划由工具产出**：`propose_plan` / `submit_plan` / `update_plan` / `complete_step` / `block_step` / `ask_user`，
  模型不需要写任何特殊标记；步骤完成必须带证据，服务端按声明的 `verification` 校验
  （产物存在 / 命令与退出码 / 人工结论）。
- **模型也能发起规划**：任务较大时会用 `propose_plan` 弹窗问你「要不要先出计划」，你点「先规划」
  才进入只读规划期（提议权给模型、决定权在你）；你选「直接做」或没答，它就直接干活。
- **工具集常驻**：计划工具从第一轮就在会话里，开关计划**不增删工具**——`tools` + 系统提示词
  构成请求最前面的前缀，改一次就让整段缓存失效（详见 [`docs/node-plan-cache-stability.md`](docs/node-plan-cache-stability.md)），
  只读改由 `tool_call` 拦截兜底，「用量」面板的**缓存命中率**可直接看到效果。
- **全生命周期可控**：确认执行、执行中改后面几步、暂停/继续、放弃（记录保留可查）；
  崩溃后由 M3 的恢复清单接上（`replan` 只对计划任务开放）。
- **留在任务库里**：计划就是 `origin='plan'` 的任务，因此任务面板、成本账本、断点续跑天然共用同一份状态。

契约见 [`docs/node-web-plan-mode.md`](docs/node-web-plan-mode.md)，
实现与验证证据见 [`docs/node-plan-mode-m4.md`](docs/node-plan-mode-m4.md)。

## 向用户提问（ask_user）

Agent 需要你拍板时（需求歧义、方案取舍、风险偏好）会**弹窗提问**，而不是靠猜：

- 一次可以问**多个问题**，每题可给选项（单选 / 多选）并允许自由输入；
- 回答作为工具结果直接回到 Agent，它**在同一次工具调用里**继续，不需要你另发一条消息；
- 「让 AI 自己决定」= 让 Agent 按最合理的假设继续并写明假设；不回答（超时 10 分钟）
  也会这样处理并明确告知模型；
- 弹窗状态存在服务端：刷新页面后仍能恢复（`state.pendingQuestion`）。

契约见 [`docs/node-question-channel.md`](docs/node-question-channel.md)。

## 子任务委派（subagent）

模型可以把「自包含但会污染上下文」的活派出去：`subagent` 工具按预设
（`~/.pi/agent/agents/*.md`，与官方扩展同契约；你已有的 `scout`/`planner`/`reviewer`/`worker`
直接可用）创建一个**进程内子会话**，只把摘要 + 用量回传父会话。

- 子会话走 `AgentRegistry` 创建：危险命令审批共用同一个 broker（弹窗出现在**父会话**界面）、
  进 trace 树（`parent_run_id`）、继承父会话的任务绑定；
- **不能递归是结构保证**：到深度上限的子会话根本不注册该工具；
- **只读预设真的只读**：子会话工具集就是预设工具集，不并入 MCP/计划/ask_user；
- **预算硬约束**：轮数 / token / 成本 / 时限，超限中止但把已产出的摘要带回来；
- 预设里的 `model:` **解析不了就回退父会话模型并说明原因**（官方扩展正是死在这里）；
- 子会话落在 `~/.pi/agent-node-server/subagents/`（可查，**不进 CLI 的会话列表**）。

前端在工具卡片里展示预设/深度/用量/轨迹/回退说明/摘要。详见
[`docs/node-subagent-m5.md`](docs/node-subagent-m5.md)。

## MCP 接入

支持任意 MCP server（stdio 子进程 / streamable-http 静态头），配置落在
`~/.pi/agent/mcp.json`（用户级）与 `{cwd}/.pi/mcp.json`（工作区级，同名覆盖）。
配置页有**模板库**：18 个推荐 server 按组展示（记忆、结构化思考、库文档、搜索、浏览器、
文件、GitHub/Git/Serena、数据库、Sentry/Slack/Figma…），带「只读 / 本地写 / 外部副作用、
需要凭据、建议审批、工具数量级」徽标；无凭据的可一键添加，其余填入表单后补 `$ENV` 即可
（配置文件里永不落明文密钥）。详见 [`docs/node-mcp-guide.md`](docs/node-mcp-guide.md)。

## 测试

```powershell
# Node 版（生产后端）
cd node-pi/server && npm run typecheck && npm test && npm run build && npm run spike && npm run eval

# 前端
cd web && npm run typecheck && npm run lint && npm test && npm run build

# Python 版
cd pi-python && python -m pytest
```

CI 见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)，三个 job：`node-backend`（format → typecheck → test → build → spike）、
`web`（typecheck → lint → test → build）、`eval`（离线 golden set 与阈值门禁）。

`npm run spike` 是**能力守护**（不是探索脚本），8+1 个离线脚本验证依赖布局未破坏关键能力
（`fauxProvider` 可解析、`node:sqlite` 可用、父子会话识别、`tool_call` 钩子链与阻断语义、
`session_start` 派发与 plan 上下文清理，以及 **M4 端到端：模型零标记完成「规划 → 确认 → 执行 → 完成」**）。
详见 [`docs/node-platform-m0-spike.md`](docs/node-platform-m0-spike.md)。

`npm run eval` 是 **M4 golden set 门禁**：7 个确定性用例（fauxProvider 驱动真实管线）+
三项阈值（pass@1 100%、计划一次通过率 ≥80%、零残留旧标记），任何一项不达标即 CI 红灯。
指标含义见 [`docs/node-plan-mode-m4.md`](docs/node-plan-mode-m4.md) §4.3。

## 文档

> 开发/继续推进本项目时，先读 [`PROGRESS.md`](PROGRESS.md)（当前进度、下一步任务、已冻结决策）。

| 文档 | 内容 |
|------|------|
| [`PROGRESS.md`](PROGRESS.md) | 当前进度与下一步计划 |
| [`docs/node-platform-explained.md`](docs/node-platform-explained.md) | **平台讲解稿（大白话）**：M1–M5 主线、名词扫盲、设计取舍与面试速答（想快速搞懂「怎么串起来」先读这份） |
| [`pi-python/README.md`](pi-python/README.md) | Python 版项目文档（配置、API、安全） |
| [`docs/three-layer-architecture.md`](docs/three-layer-architecture.md) | Python 三层包结构与依赖规则 |
| [`docs/node-pi-backend.md`](docs/node-pi-backend.md) | Node 版后端说明 |
| [`docs/node-extension-system.md`](docs/node-extension-system.md) | Node 扩展发现与接入 |
| [`docs/node-command-approval.md`](docs/node-command-approval.md) | 命令风险分级与审批事件链路 |
| [`docs/node-mcp-guide.md`](docs/node-mcp-guide.md) | MCP 支持总结（原理、实现、配置方法与示例） |
| [`docs/node-mcp-support.md`](docs/node-mcp-support.md) | MCP 功能的设计与实现细节 |
| [`docs/node-mcp-implementation.md`](docs/node-mcp-implementation.md) | MCP 实现详解（代码走读） |
| [`docs/node-platform-plan.md`](docs/node-platform-plan.md) | Node 平台化规划（可观测/任务持久化/断点续跑/Plan 重构/Subagent） |
| [`docs/node-platform-m0-spike.md`](docs/node-platform-m0-spike.md) | M0 验证报告：存储选型与 `~/.pi/agent` 只读边界审计 |
| [`docs/node-observability-m1.md`](docs/node-observability-m1.md) | M1 可观测底座：采集口径、存储与聚合取舍、REST 契约与配置 |
| [`docs/node-task-domain-m2.md`](docs/node-task-domain-m2.md) | M2 任务领域：状态聚合语义、乐观并发、任务 REST/SSE 与面板 |
| [`docs/node-task-recovery-m3.md`](docs/node-task-recovery-m3.md) | M3 断点续跑：执行租约、在飞动作与副作用分级、恢复清单与一键续跑 |
| [`docs/node-web-plan-mode.md`](docs/node-web-plan-mode.md) | **Plan 模式契约**（M4 起：Plan 是 Task 的视图 + 工具驱动） |
| [`docs/node-plan-mode-m4.md`](docs/node-plan-mode-m4.md) | **M4 实现说明**：8 个缺陷的修法、已冻结决策、spike/eval 验证证据 |
| [`docs/node-plan-cache-stability.md`](docs/node-plan-cache-stability.md) | **Plan 缓存稳定性 + `propose_plan`**：为什么不再增删工具、注入去抖、模型提议的边界 |
| [`docs/node-question-channel.md`](docs/node-question-channel.md) | **向用户提问的交互通道**：ask_user 工具契约、弹窗行为、SSE/命令、测试 |
| [`docs/node-subagent-m5.md`](docs/node-subagent-m5.md) | **M5 子任务委派**：为什么内联替换官方扩展、预算/审批继承/trace 树、决策与验证 |
| [`docs/node-plan-extension-ownership.md`](docs/node-plan-extension-ownership.md) | Plan 扩展归属决策与 `session_start` 修复 |
| [`docs/node-session-tree-flat.md`](docs/node-session-tree-flat.md) | **长会话读取崩溃修复**：分支树扁平化（`tree` 契约、前端归一化、回归测试） |
| [`docs/web-observability-panel-scroll.md`](docs/web-observability-panel-scroll.md) | **用量页面滚不动的修复**：设置弹窗里嵌入式面板的高度/滚动契约 |
| [`docs/development-standards.md`](docs/development-standards.md) | 开发与提交规范 |
