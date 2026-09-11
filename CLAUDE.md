# CLAUDE.md

本文件为 Claude Code 在本仓库工作时的行为指南。

> **接到任务先读 [`PROGRESS.md`](PROGRESS.md)**：它记录当前里程碑、下一步任务、已冻结的技术决策与硬约束。
> 新会话从那里继续，不要重新推导已定结论。

## 项目概览

「两套 pi 实现 + 一个共享 Vue 前端」的仓库：

- **`node-pi/server`（生产）**：Fastify + 原版 `@earendil-works/pi-coding-agent` SDK，监听 `8001`。
- **`pi-python`（复刻/学习）**：Python + FastAPI 三层内核复刻（`pi_ai → pi_agent → pi_coding_agent`），监听 `8000`。
- **`web`（共享前端）**：Vue 3 + Vite + Pinia + Tailwind，通过 `VITE_BACKEND_URL` 切换后端（默认 `8000`，Node 版为 `8001`）。

**核心约束**：Node 后端对共享 Vue 前端维持**同一套 `/api` REST + SSE + 错误契约**。改动任何路径、响应、SSE 载荷或状态字段前，须检查 `web/src/lib/api.ts`、`web/src/lib/agent-events.ts` 与 Pinia store。

`pi-python` 是对原版内核的学习性复刻，生产运行走 `node-pi`。**`pi-python` 已停止同步开发：没有明确需求不得改动 `pi-python/` 下的任何文件**，只能作为只读的行为对照参考。

## 目录结构

```
pi_py/
├── web/                    # Vue 3 前端（共用，VITE_BACKEND_URL 切换后端）
│   └── src/
│       ├── lib/api.ts      # 全部 REST 封装（统一解析 ApiError）
│       ├── lib/agent-events.ts  # SSE 事件 → 流式状态规约（reduceAgentEvent）
│       ├── stores/         # Pinia（app.ts / auth.ts）
│       ├── types/index.ts  # 前端数据类型（与后端 JSON 一一对应）
│       └── components/     # 三栏 IDE：会话侧栏/聊天/文件面板等
├── node-pi/
│   ├── server/             # Node 生产后端（Fastify，8001）
│   │   ├── src/
│   │   │   ├── app.ts      # 应用装配、依赖注入、生命周期、全局错误处理
│   │   │   ├── server.ts   # 进程入口（仅读取配置 + 监听）
│   │   │   ├── config.ts   # 环境变量基础设施配置（PI_NODE_*）
│   │   │   ├── errors.ts   # 统一 API 错误
│   │   │   ├── routes/     # HTTP/SSE 适配层（薄）：agent/auth/files/mcp/models/observability/presets/sessions/skills/tasks/workspaces
│   │   │   └── services/   # 业务逻辑 + Pi SDK 适配：agent-registry/tool-approval/user-question/subagent-{service,presets,models,tools}/plan-{mode-service,tools,policy}/task-{service,lease,recovery,runner}/mcp/（含模板库）...
│   │   │       ├── platform/       # SQLite/内存存储（M1/M2）：migrations/trace-model/trace-repository/task-* /store
│   │   │       └── observability/  # trace 采集与聚合（M1）：session-ledger/redact/metrics/observability-extension
│   │   ├── spike/          # 能力守护脚本（离线、临时目录）；`npm run spike` 兼作 CI 门禁
│   │   ├── eval/           # M4 评测 golden set（`npm run eval`，CI 的 eval job）
│   │   └── test/           # Vitest（映射 src/ 结构）
│   └── utools/             # uTools 桌面插件（拉起 node-pi/server + 加载 web 构建）
├── pi-python/              # Python 复刻（学习参考）
│   ├── src/pi_ai/          # 底层：模型原子类型、Provider（anthropic/openai/deepseek/fake）
│   ├── src/pi_agent/       # 中层：通用 Agent loop、事件、工具抽象
│   ├── src/pi_coding_agent/# 顶层：Session v3、Coding Agent 组装、工具实现
│   ├── server/             # FastAPI 应用层：routes（薄）→ services → errors
│   └── tests/              # unit / integration / compat
├── scripts/                # 启动/运维脚本（.ps1 / .bat / .py）
├── docs/                   # 架构与实施文档（中文）
└── tests/                  # 旧的 Python 测试目录（遗留；实际 pytest 在 pi-python 下运行）
```

## 常用命令

```powershell
# Node 后端（生产）
cd node-pi/server
npm install
npm run dev               # http://127.0.0.1:8001
npm run typecheck && npm test && npm run build

# Python 后端（复刻）
cd pi-python
python -m pip install -e ".[dev]"
python -m uvicorn server.main:app --host 127.0.0.1 --port 8000 --reload
python -m pytest

# 前端
cd web
npm install
npm run dev               # http://127.0.0.1:5173（/api 代理到 VITE_BACKEND_URL）
npm run typecheck && npm run lint && npm run test && npm run build
```

一键脚本（仓库根）：`scripts/start-node-dev.ps1`（Node 后端 + 前端）、`scripts/start-dev.ps1`（Python 后端）、`scripts/start-production.ps1`（构建前端后同源托管）。

## 架构与设计原则

### Node 后端（node-pi/server）

- 依赖方向固定：`routes → services → Pi SDK / Node 标准库`。`app.ts` 只负责组装和依赖注入，`server.ts` 只负责启动。
- 路由不得直接创建 Pi Session、读写持久化配置或承载长生命周期状态。
- `AgentRegistry`（`services/agent-registry.ts`）是核心：每个会话一个活跃 `AgentSession`，内存缓存 SSE 事件（每会话最多 256 条）支持 `Last-Event-ID` 回放，命令走统一的 `command()` 分发。
- 会话命令类型（`POST /api/agent/:sessionId` body.type）：`prompt` / `steer` / `follow_up` / `abort` / `set_model` / `set_thinking_level` / `set_tools` / `compact` / `navigate_tree` / `reload_resources` / `approve_tool` / `plan_enable|disable|execute|refine`。
- 会话详情（`GET /api/sessions/:id`）的 `tree` 只能是**扁平节点 + `depth`**（先序、不含 `children`）。原因：树深度等于会话条目数，嵌套结构会让 Fastify 的 `JSON.stringify` 在长会话上爆栈（`docs/node-session-tree-flat.md`）。节点只带导航字段（`id/parentId/depth/type/role/text/label/labelTimestamp`），正文一律走 `context.messages`。
- 新能力落点：新 API → 新增 `routes/<resource>.ts` + 对应 service，在 `app.ts` 显式注册；新会话能力 → `AgentRegistry`；新工具/事件钩子 → `extensions/`（不要为加载单个扩展改 `app.ts`）。
- 可观测性（M1）：采集只在 `AgentRegistry.publish()` 一处插桩（→ `SessionLedger`）；存储与聚合在 `services/platform/`（SQLite/内存双实现 + 写入队列）；查询走 `routes/observability.ts` → `services/observability/metrics.ts`。不要在其他地方新增 trace 写入点。
- 任务领域（M2）：领域模型与仓储在 `services/platform/task-*.ts`，用例在 `services/task-service.ts`（状态由步骤聚合、写入必须带 `ifRevision`），接口在 `routes/tasks.ts`，变更经 `AgentRegistry.announceTask()` 以 SSE `task_updated` 推送。任务写入**不走 trace 的写入队列**：它是用户可见的状态，必须同步落库、错误必须冒泡。
- 断点续跑（M3）：`task-lease.ts`（租约，owner = pid + bootId）→ `task-recovery-extension.ts`（在飞动作与副作用分级）→ `task-recovery.ts`（恢复清单与判定）→ `task-runner.ts`（续跑：校验 → 取租约 → 注入 `[TASK RESUME]` 隐藏上下文 → 发 prompt → 续期保活）。三条不可让步的规则：**只列不跑**（恢复清单不自动执行）、**无法判定副作用必须人工确认**、**产物在就补记完成、绝不重跑**。任何执行态写入都要经 `TaskService`（乐观锁 + 广播），不要绕开它直接写库。
- Plan 模式（M4）：**Plan 是 Task 的受控视图**（`origin='plan'`），不是第二套模型。分工：`platform/plan-model.ts`（纯投影 `PlanView`/`derivePlanStatus`）→ `plan-tools.ts`（`propose_plan`/`submit_plan`/`update_plan`/`complete_step`/`block_step`/`ask_user` + `PlanToolbox` 用例层）→ `plan-policy.ts`（规划期能力分类）→ `plan-mode-service.ts`（会话状态机：上下文注入去抖、`tool_call` 拦截、命令分发）。三条不可让步的规则：**只有用户能确认执行**、**步骤完成必须有证据且按 verification 校验**、**规划期只读（能力分类，未归类即不放行）**。**计划工具从会话创建起就常驻 `activeTools`，计划开始/结束一律不增删工具**（增删会让请求前缀缓存整段失效，见 `docs/node-plan-cache-stability.md`）；只读由 `tool_call` 拦截兑现，模型想发起规划用 `propose_plan` 征求用户同意。改 `plan_*` 命令或 SSE `plan_updated` 载荷（`PlanView`）必须同步 `web/src/types`、`web/src/lib/agent-events.ts` 与 Pinia/组件。
- MCP：协议层支持任意 server（stdio 子进程 / streamable-http 静态头），配置两层合并（`~/.pi/agent/mcp.json` 用户级 + `{cwd}/.pi/mcp.json` 工作区级，同名工作区优先），每 server 可 `approval: "required"`，预设可白名单。**凭据只能写成 `$ENV` 引用**（env / headers / **args** 三处都会在 spawn 时插值）——该配置文件与原版 CLI 共享，禁止落明文密钥。推荐清单在 `services/mcp/mcp-templates.ts`（前端配置页「模板库」，一键添加/填入表单），新增模板必须过 `assertTemplateTable()`。
- 子任务委派（M5）：`subagent` 工具按预设（`~/.pi/agent/agents/*.md` + 项目级 `.pi/agents/`）创建**进程内子会话**，走 `AgentRegistry`，因此审批/trace/任务绑定天然生效。三条不变量：**不能递归是结构保证**（到 `maxDepth` 的子会话根本不注册该工具）、**只读预设真的只读**（子会话工具集 = 预设工具集，不并入 MCP/计划/ask_user）、**一定要收尾**（成功/失败/超预算/取消/停机都会 `remove`）。子会话落 `~/.pi/agent-node-server/subagents/`（不进 CLI 会话列表）；取消级联的五个入口见 `docs/node-subagent-m5.md` §3。官方文件扩展 `subagent` 已被内联实现**同名接管**（`INLINE_OWNED_EXTENSION_DIRS`，不动用户磁盘文件，CLI 照常）。
- 人机交互两条通道：危险命令走 `ToolApprovalBroker`（`tool_call_pending` / `approve_tool`），提问走 `QuestionBroker`（`question_pending` / `answer_question`，见 `docs/node-question-channel.md`）。两者语义一致——工具挂起 → SSE → 用户动作 → Promise 结算；超时/中止/会话关闭都要有确定归宿。**「谁在等用户」只有一个真相源**：不要在任务/计划里再镜像一份（M4.1 移除了 `PlanView.question*`）。
- 版本号语义：`task.revision` 是**用户可见内容的版本**。执行期运行时写入（租约/心跳/在飞）用 `keepRevision: true` 不占版本号；`TaskService.mutate` 的 `change()` 返回原对象即「无变化」（不写库、不广播、不动版本号）。所有写入都先重读记录再改，因此不会用陈旧副本覆盖运行时字段。

### Python 三层内核（pi-python/src）

依赖方向是**硬性约束**（由 `pi-python/tests/unit/test_architecture.py` 校验）：

- `pi_ai` 不得导入 `pi_agent` / `pi_coding_agent`
- `pi_agent` 可以导入 `pi_ai`，不得导入 `pi_coding_agent`
- `pi_coding_agent` 可导入两者；FastAPI 与 Vue 位于其上层
- 禁止在 `server/routes/` 堆业务逻辑；服务类放 `server/services/`，路由用 `Depends(request.app.state.xxx)` 取服务。

### SSE 与错误契约

- 长任务以 `202` 接收，结果经 SSE 推送；不阻塞 HTTP 等模型完成。SSE 保持 `Last-Event-ID` 回放、断开清理和 15 秒心跳，hijack 响应须显式补 CORS 头。
- 错误响应固定为 `{ error: { code, message, details? } }`，机器码用 snake_case。校验失败抛 `422 validation_error`；不得把堆栈、凭据、绝对敏感路径或 SDK 原始错误返回给浏览器。
- 前端 `EventSource` 无法带 Authorization 头，SSE/media 地址的令牌走查询参数（见 `web/src/lib/api.ts` 的 `appendToken`）。

## 安全规范（重要）

- **与原版 pi CLI 共享 `~/.pi/agent`（最高优先级约束）**：该目录是原版 pi CLI 的数据目录，**CLI 必须能继续以原版行为运行**。Web 与 CLI **共享会话与配置**，扩展与 trace **各自独立**。原则是：
  - **共享态的增量写入允许，破坏性写入禁止。**
  - 禁止：**删除** pi 的文件（会话 JSONL）、写入时**剥离未知字段**、写入 pi 无法解析的内容、把明文密钥写进共享配置。
  - 允许：新增会话、向会话追加条目、向 `models.json` 新增/修改 provider。共享态写入必须满足：校验前置 + spread 保留未知字段 + 临时文件 rename 原子写。参考实现：`services/model-config-service.ts`。
  - `auth.json` / `settings.json` / `models-store.json` 只读（pi 自己持 `proper-lockfile` 写入）；`models.json` pi **只读**，故 web 写入无锁冲突。
  - 本项目自有文件（`mcp.json` / `node-server-presets.json` / `node-server-workspaces.json`）与 trace/task 存储**建议**落在 `~/.pi/agent-node-server/`，避免占用 pi 命名空间（无功能风险，仅卫生）。
  - **trace 必须对 CLI 零影响**：只读 SDK 内存事件、只写自己的库文件；`ledger.record()` 一律 fire-and-forget + 异常降级为 warn，**绝不能冒泡到 agent loop**。
  - 测试必须隔离 `agentDir` 到临时目录，禁止触碰真实 `~/.pi` 或网络。
  - 边界核实与逐文件判定见 `docs/node-platform-m0-spike.md` 第 3 节。
- **密钥绝不外泄**：任何 API 响应不得包含真实密钥；自身配置只保存 `$ENV_VAR` 引用，按 `auth.json` 的 key 名映射解析（`$DEEPSEEK_API_KEY → auth.json["deepseek"].key`）。
- Node 后端的本项目自有可写状态（trace / task / mcp / presets / workspaces）建议落在 `~/.pi/agent-node-server/`；Python 后端落在 `~/.pi/agent-python/`。共享态（`models.json`、`sessions/`）按上一条的红线写入。测试必须隔离 `agentDir` 到临时目录，禁止触碰真实 `~/.pi` 或网络。
- **trace 对 agent loop 零影响（M1 已实施）**：`services/observability/session-ledger.ts` 是唯一埋点逻辑，由 `AgentRegistry.publish()` 尾部调用；所有入口 try/catch + warn，写入先入队（250ms/200 条批量落 `~/.pi/agent-node-server/platform.db`），队列超限丢最旧、连续失败进入 degraded，**任何情况都不得冒泡到 agent loop**。默认只存 digest + 120 字符预览（正文需 `PI_NODE_TRACE_CONTENT=1`），并对 `sk-`/`Bearer`/`apiKey` 等形态统一脱敏。`createApp()` 不传 trace 配置时不写盘（测试环境安全的默认值）。细节见 `docs/node-observability-m1.md`。
- **危险命令人工确认**：`bash` 命中危险规则（递归删除、格式化、关机、强制 Git 推送等）时挂起执行，向 SSE 推 `tool_call_pending`，前端弹窗，由 `approve_tool` 命令允许/拒绝。拒绝或超时（Node 30 秒 / Python 60 秒）按拒绝处理。`ToolApprovalBroker`（Node）/ `ToolApprovalGate`（Python）是唯一真相源。
- 文件访问必须确认工作区已登记，保持路径边界与敏感文件拦截（`.env`、凭据、密钥后缀）。

## 扩展系统（内联扩展）

- 仓库内的工具审批、Plan 模式与 MCP 工具都是**内联扩展**：各服务类（`ToolApprovalBroker` / `PlanModeService` / `buildMcpExtension`）提供 `buildExtension(): InlineExtension`，由 `OriginalPiSessionFactory.loader()` 的 `extensionFactories` 注入每个会话（闭包直连服务单例，无事件总线桥接）。
- 按预设开关动态启用/关闭：`CreateSessionInput.extensions.{approval,planMode}`，默认开启；`loader()` 里按 `plan → approval → mcp` 顺序注册（规划期先拦，避免先弹审批框）。
- 用户级 `~/.pi/agent/extensions/` 与工作区 `.pi/extensions/` 的文件扩展仍由 SDK 自动发现（jiti 隔离，协作需走 `pi.events`）；仓库不再随服务发布文件扩展。

## 代码规范

- **注释**：默认不写注释；需要时用中文解释「为什么」，不用中文复述代码「是什么」。Node 公开类/关键方法保留「英文 docstring + 中文说明」双语风格；Python 文件头英文 docstring + 一行 `中文说明：...`。
- **TypeScript**：ESM + NodeNext，相对 import 带 `.js` 后缀，类型用 `import type`，`strict`，避免无理由的 `any`。前端组件统一 `<script setup lang="ts">` + 组合式 API。
- **Python**：`from __future__ import annotations` + 完整类型注解，优先 `dataclass`（只读加 `frozen=True, slots=True`）。业务错误抛 `server.errors.APIError(status, code, message)`。
- **提交**：Conventional Commits（`feat|fix|docs|refactor|test|chore`），描述用中文，一个提交只做一件事，代码与文档分开提交。
- **测试**：改动必须附带测试；行为变更至少覆盖正常路径 + 一个失败/边界路径。Node 用 `app.inject()` + fake session + 临时目录；Python 集成测试注入 `FakeProvider`，绝不访问网络。

## 前端要点

- 类型集中在 `web/src/types/index.ts`；API 调用统一走 `web/src/lib/api.ts`（统一解析为 `ApiError`）；状态用 Pinia，组件间不 props 深传。
- 后端形状差异（如分支树：Node 扁平 / Python 嵌套）在 API 层归一化（`web/src/lib/session-tree.ts`），组件只面对一种形状；**任何遍历会话结构的地方一律用显式栈，不用递归**（长会话会爆栈）。
- SSE 事件 → 流式状态：`web/src/lib/agent-events.ts` 的 `reduceAgentEvent` 是纯函数规约，新增事件类型时同步更新。
- 关键组件：`ChatWindow.vue`（会话/流式）、`SessionSidebar.vue`、`ToolApprovalDialog.vue`（危险命令确认）、`ModelsConfig.vue`、`McpConfig.vue`、`PresetConfig.vue`、`SkillsConfig.vue`、`PlanProgress.vue`、`TaskPanel.vue`（任务面板）、`ObservabilityPanel.vue`（设置 → 用量）。
- 主题/声音偏好存 localStorage（`pi.theme` / `pi.sound`），写入 `<html data-theme>`。

## 关键文档

| 文档 | 内容 |
|------|------|
| [`PROGRESS.md`](PROGRESS.md) | **当前进度与下一步**（新会话先读这个） |
| `README.md` | 仓库总览与快速开始（唯一入口） |
| [`docs/node-platform-explained.md`](docs/node-platform-explained.md) | **平台讲解稿（大白话）**：M1–M5 主线、名词扫盲（租约/在飞/run/step）、跨模块的三条不可让步规则、已知限制 |
| `docs/development-standards.md` | Python 项目开发规范 |
| `node-pi/server/DEVELOPMENT.md` | Node 后端开发规范 |
| `docs/node-pi-backend.md` | Node 后端功能清单 |
| `docs/node-platform-plan.md` | Node 平台化规划（M0–M5 里程碑、契约变更、验收标准） |
| `docs/node-platform-m0-spike.md` | M0 验证结论：存储选型、`~/.pi/agent` 只读边界审计与整改清单 |
| `docs/node-observability-m1.md` | **M1 可观测底座**：采集口径（run 边界/TTFT/策略拦截归因）、存储与聚合取舍、REST 契约、配置与降级 |
| `docs/node-task-domain-m2.md` | **M2 任务领域**：状态聚合语义（唯一真相源＝步骤）、乐观并发、任务 REST/SSE 契约、面板 |
| `docs/node-task-recovery-m3.md` | **M3 断点续跑**：执行租约、在飞动作与副作用分级、恢复清单与一键续跑、DoD 验证记录 |
| `docs/node-web-plan-mode.md` | **Plan 模式对外契约**（M4 起：PlanView、五个计划工具、命令表、规划期权限） |
| `docs/node-plan-mode-m4.md` | **M4 实现说明**：8 个缺陷的修法、已冻结决策、spike/eval 验证证据、已知限制 |
| `docs/node-plan-cache-stability.md` | **Plan 缓存稳定性 + `propose_plan`**：为什么不再增删工具、注入去抖、模型提议的边界 |
| `docs/node-question-channel.md` | **向用户提问通道**（`ask_user`）：工具契约、弹窗、SSE/命令、行为取舍 |
| `docs/node-plan-extension-ownership.md` | Plan 扩展归属决策 + `session_start` 修复（M4 前置项） |
| `docs/node-session-tree-flat.md` | 长会话读取崩溃修复：`GET /api/sessions/:id` 分支树扁平化契约与前端归一化 |
| `docs/web-observability-panel-scroll.md` | 前端修复：设置 →「用量」面板的高度与滚动契约（滚不动的根因与回归防线） |
| `docs/three-layer-architecture.md` | Python 三层包结构与依赖规则 |
| `docs/node-extension-system.md` | 扩展发现与接入 |
| `docs/node-command-approval.md` | 命令风险分级与审批链路 |
| `docs/node-mcp-guide.md` / `node-mcp-support.md` / `node-mcp-implementation.md` | MCP 支持 |

行为变化须同步更新 README 与对应 docs 文档。
