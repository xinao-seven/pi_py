# Node 后端能力升级规划：可观测与评测 · 任务持久化与断点续跑 · Plan 模式重构 · Subagent

更新日期：2026-08-20
适用范围：`node-pi/server`（生产后端）+ `web/`（共享前端）
不在范围内：`pi-python/`（已冻结，只读参考，本规划不新增或修改其任何文件）

---

## 0. 文档定位

本文不是功能清单，而是一份**带依赖顺序、契约变更与验收标准的实施规划**。四项能力不是并列的四个功能，而是同一条主线：

> 把编码 Agent 从「可用的 Web 产品」，升级为「**可度量、可恢复、可干预、可扩展**的 Agent 平台」。

四项能力的主线关系：

| 能力 | 解决的问题 | 对主线的贡献 |
| --- | --- | --- |
| 可观测性 + 评测 | 「agent 变好了吗？」无法回答 | **可度量**：为后续所有优化提供基线与回归门禁 |
| 任务持久化 + 断点续跑 | 进程重启后中断的任务丢失 | **可恢复**：把一次性对话变成可持久的执行控制面 |
| Plan 模式重构 | 控制流托付给自然语言正则，逻辑不通 | **可干预**：把计划升级为结构化、可编辑、有证据的任务 |
| Subagent | 单一上下文窗口、单线程执行 | **可扩展**：上下文隔离 + 并行 + 预算隔离 |

四项能力**不能并行开四个分支各做各的**：Plan 重构依赖任务领域模型，Subagent 的 trace 依赖可观测底座，评测的 golden set 依赖 Plan 契约冻结。第 4 节给出确定的依赖顺序。

---

## 1. 现状基线

### 1.1 已有能力（本规划直接复用的资产）

| 资产 | 位置 | 本规划如何复用 |
| --- | --- | --- |
| 事件汇聚点（SDK 事件 → 编号 → 缓存 → 广播） | `services/agent-registry.ts:799` `publish()` | 可观测性的唯一插桩点 |
| 结构化会话事件日志（turn/工具/用量/耗时） | `services/agent-registry.ts:813` `logSessionEvent()` | 已经算出 `durationMs`/`usage`/`costTotal`，只需落库 |
| 内联扩展注入机制 | `agent-registry.ts:334` `loader()` | Plan 工具、Subagent 工具、观测钩子全部走这里 |
| 挂起-结算审批中枢 | `services/tool-approval.ts` | Subagent 权限继承、Plan 期 `ask_user` 的通道 |
| 会话门面 `PiSession` | `agent-registry.ts:111` | 补齐 `getSessionStats()` / `getContextUsage()` 即可拿到现成指标 |
| SSE 事件缓存 + `Last-Event-ID` 回放 | `routes/agent.ts:266`、`agent-registry.ts:537` | 新增事件类型直接复用通道 |
| 会话树 / 父子会话（`parentSessionPath`） | `session-service.ts`、`types/index.ts` | Subagent 子会话的归属关系 |
| 工作区登记与路径边界 | `workspace-service.ts`、`file-service.ts` | Subagent 的 cwd 必须落在已登记工作区内 |

### 1.2 关键事实核查（已在本仓库验证，非假设）

| 结论 | 验证方式 | 影响 |
| --- | --- | --- |
| 运行时 Node 为 **v24.12.0**，`node:sqlite` **可用**（带 experimental 警告） | `node -e "require('node:sqlite')"` | 可**零新增依赖**引入 SQLite 存储 |
| SDK 内置 **`fauxProvider()`** 脚本化假 provider（`setResponses` / `appendResponses` / `callCount`） | `pi-ai/dist/providers/faux.d.ts`，经 `pi-ai` 顶层导出 | **离线确定性评测完全可行**，不必自建假 provider |
| `ExtensionAPI.registerProvider(provider)` 接受 `Provider` 对象 | `pi-coding-agent/dist/core/extensions/types.d.ts` | `fauxProvider().provider` 可直接注入 |
| SDK 提供 `session_before_compact` / `session_compact` / `before_provider_headers` / `after_provider_response` / `input` / `agent_settled` 等钩子 | 同上 | 观测、记忆、UX 改造都有官方插桩点，**不需要改 SDK** |
| `SessionManager.create(cwd, dir, { parentSession })` 支持建立子会话 | `session-manager.d.ts:13` | Subagent 子会话可被 `listAll` 与前端会话树识别 |
| `AgentSession.getSessionStats()` 返回完整 usage/cost；`getContextUsage()` 返回上下文占用 | `agent-session.d.ts:622` | **现状被丢弃**：`agent-registry.ts:661-662` 硬编码 `contextUsage: null, sessionStats: {}` → 前端上下文仪表盘长期为空。这是零成本修复项 |
| 仓库**没有任何 CI 配置** | `find . -name "*.yml"` 无结果 | 评测要有意义，必须先补 CI（M4 的前置项） |

---

## 2. 现状诊断：Plan 模式到底哪里不符合逻辑

用户反馈「用起来不符合逻辑」是正确的。以下 8 个问题都可在代码中定位，**且根因是同一个：把关键控制流托付给了自然语言解析**。

### P1 模式必须先开、内容后发，且新会话无法规划

- `docs/node-web-plan-mode.md` 明说：「先点击开关，再在原输入框发送需求」。
- `web/src/components/ChatWindow.vue:245` `togglePlan()`：新会话直接报错「请先发送首条消息创建会话，再开启 Plan 模式」。

**后果**：用户想「先规划一下这个需求」，必须先把全局状态切成 planning，再输入。顺序错了就白跑一个回合；新会话完全无法使用 Plan 模式。这与「先表达意图，模型决定怎么做」的心智相反。

### P2 计划靠正则从自然语言里抠（根因）

- `plan-mode-service.ts:72` `extractPlan()`：要求 assistant 文本里有 `Plan:` / `计划：` 标题 + 编号/无序列表。
- `plan-mode-service.ts:227` `onAgentEnd()`：解析不到 → `todos` 为空 → `awaitingConfirmation` 永远为 `false`。
- `plan-mode-service.ts:375` `command('execute')` 校验：`!awaitingConfirmation` → 抛 `409 plan_not_ready`。

**后果**：模型只要不写 `Plan:` 标题（极其常见），用户点「确认并执行」就一定 409，面板永远停在「Agent 正在讨论并生成结构化 Plan…」。**系统把状态机的迁移条件交给了模型的文风**。

### P3 步骤完成靠模型自报，且漏写即卡死

- `plan-mode-service.ts:100` `markDone()`：只认 `[DONE:n]` 标记。
- `plan-mode-service.ts:229`：`todos.every(completed)` 才退出执行态。

**后果**：模型漏写一次 `[DONE:2]`，执行态永不收敛，用户只能手动退出；而文档承诺的「完成且验证后」在系统层面**没有任何验证能力**——`[DONE:n]` 是模型自证。

### P4 执行期不可修改、不可暂停

- `plan-mode-service.ts:269` `refine()` 只在 `awaitingConfirmation` 时可用（`command()` 在 375 行前校验）。
- 一旦 `execute()`，`awaitingConfirmation=false`；`disable()` 会 `todos = []`（260-268 行）——**计划直接蒸发**。
- 没有 `pause` / `resume`。

**后果**：执行到第 3 步发现第 5 步方案不对，用户只能 abort 或整个退出，且退出后连原计划都看不到。

### P5 计划生命周期与产物不留痕

- `onAgentEnd()` 全部完成时：`executing=false; todos=[]`（229-233 行）。
- 同时 `publish()`（316 行）每改一次状态就 `appendEntry('web-plan-mode', ...)`。

**后果**：JSONL 里堆满状态快照，而**用户界面里没有任何历史计划**。「上周那个重构计划做到哪了」无法回答。

### P6 工具权限用快照式恢复，会覆盖用户设置

- `restrictTools()`（303 行）`toolsBeforePlanMode ??= getActiveTools()`；`restoreTools()`（312 行）无条件写回。
- 规划期前端若通过 `set_tools` 改了工具，退出 Plan 后会被旧快照覆盖。
- `PLAN_TOOLS`（27 行）硬编码，且 `isSafePlanCommand()`（111 行）的正则白名单**会拦掉 `tsc --noEmit`、`pnpm test`、`npm run build`、`node -e`** 等最常用的只读验证命令。

**后果**：规划期反而无法跑验证，规划质量下降；这是「不符合逻辑」的直接体感来源。

### P7 计划与任务模型是两套东西（即将重复建模）

`PlanTodo { step, text, completed }` 是会话内临时数据；如果按原计划新增 `TaskService`（`dist/services/task-service.d.ts` 里那份半成品设计：`TaskRecord/status/steps/blockedReason/conclusion`），两套模型会各自演化。

### P8 重启后计划无法被感知

- `PlanMachine.attach()`（133 行）只在会话被 `open()` 时执行。
- 服务重启 + 前端未打开该会话 → 处于待确认或执行中的计划**没有任何提醒机制**。

### 修正结论（本规划采取的方向）

| 问题 | 修正方向 | 落地里程碑 |
| --- | --- | --- |
| P1 | 删除全局预开关，改为**发送时的执行方式选择**（`mode: plan \| direct`），新会话同样支持 | M4 |
| **P2（根因）** | **计划改由工具调用产出**：注册 `submit_plan` / `update_plan` / `complete_step` / `block_step`（TypeBox schema），彻底删除 `extractPlan` / `markDone` 正则 | M4 |
| P3 | 步骤完成必须带**证据**（命令+退出码 / 文件 / 摘要），可由 `verification` 声明并由服务端校验 | M4 |
| P4 | 计划全生命周期可编辑（增删改重排跳过）、可 `pause`/`resume`、`abandon` 保留记录 | M3+M4 |
| P5 | 计划落为 **Task 实体**（`origin: 'plan'`），JSONL 只留 `planId` 引用指针 | M3+M4 |
| P6 | 权限改为**能力集声明**（`planPolicy`），退出时回到会话当前工具集而非旧快照；验证类命令显式放行 | M4 |
| P7 | Plan 与 Task **合流**：Plan 是 Task 的视图，不再是独立模型 | M3 |
| P8 | 引入**执行租约 + 恢复清单**，重启后主动告知可恢复的计划 | M3 |

---

## 3. 统一底座设计

四项能力共享一个存储与一套领域实体，避免后期返工。

### 3.1 存储选型

| 方案 | 结论 |
| --- | --- |
| 沿用原子写 JSON 文件（现状 `workspace-service.ts` 风格） | **任务**可接受（写少、量小） |
| **`node:sqlite`（推荐）** | **可观测与评测**需要按时间聚合、p50/p95、按工具/模型分组——SQL 是正确工具。已验 Node 24.12 可用，零新增依赖 |
| `better-sqlite3` | 需要原生编译，Windows 下多一个安装风险；仅在 `node:sqlite` 遇到阻塞问题时作为备选 |

**结论**：单一数据库文件 `~/.pi/agent-node-server/platform.db`，`PRAGMA journal_mode=WAL`，任务与观测分表。

**必须处理的工程风险**：`node:sqlite` 的 `DatabaseSync` 是**同步 API**，在单线程 Fastify 进程里会阻塞事件循环。

应对：
1. 所有写入走内存队列，每 **250ms 或累计 200 条**批量 flush 一次（单批 WAL 写入通常在毫秒级）；
2. 行数据保持小（默认只存 digest 与计数，见 3.3 隐私）；
3. 读路径（Dashboard 聚合查询）走**预聚合表 + 定时汇总**，不在请求里跑全表扫描；
4. 启动时用 `PI_NODE_STORE=memory` 可整体降级为内存实现，保证测试与无盘环境可用。

抽象成 `services/platform/store.ts`：

```ts
export interface PlatformStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  /** 任务聚合 */
  tasks: TaskRepository;
  /** 观测聚合（写入走批量队列） */
  traces: TraceRepository;
  /** 评测运行记录（独立库文件，避免污染生产数据） */
  evals: EvalRepository;
}
```

### 3.2 阶段划分与依赖

```text
M1 可观测底座 ──────────────┐
  ├─ PlatformStore(SQLite)  │
  ├─ SessionLedger          ├──► M4 评测（需要冻结的 Plan 契约 + Trace 指标）
  └─ 补齐 facade 指标       │
                            │
M2 任务领域 ────────────────┼──► M4 Plan 重构（Plan 是 Task 的视图）
  ├─ TaskService(复活)      │
  ├─ 执行租约 + 恢复清单     │
  └─ tasks API + SSE        │
                            │
M3 断点续跑 ────────────────┘
                            └──► M5 Subagent（需要 Trace 父子树 + 预算 + 任务关联）
```

**排序理由**：
- M1 是所有度量的前提，且是纯增量、零返工；
- M2 是 Plan 重构的模型基础（先有 Task，才能把 Plan 映射上去）；
- M3 依赖 M2 的租约字段；
- M4 重构 Plan 会改动 `plan_*` 命令与 SSE 契约，**评测 golden set 必须在其后冻结**，否则白写；
- M5 依赖 M1 的 `run.parent_run_id` 与预算统计。

### 3.3 隐私与安全红线（贯穿所有里程碑）

沿用仓库既有安全规范，新增三条：

1. **默认不落正文**。Trace 只存 `sha256(content).slice(0,12)` digest、字节数、首行截断 120 字符。需要正文调试时显式设置 `PI_NODE_TRACE_CONTENT=1`。
2. **不落密钥**。所有写入前经过统一 `redact()`：剔除 `sk-`/`Bearer`/`apiKey`/`authorization` 形态的字符串；模型参数里的 `apiKey` 字段一律丢弃。
3. **不触碰 `~/.pi/agent`**。`platform.db`、任务文件、评测输出全部落在 `node-server-*` 前缀的自身路径或注入路径；测试必须注入临时目录（与现有测试一致）。

---

## 4. 里程碑实施规划

### M1 可观测性底座（SessionLedger + 指标面板）

**目标**：不改动 Agent 主链路，把已有的运行事实沉淀成可查询的 trace 与成本账本。

#### 4.1.1 数据模型

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,              -- uuid，子 agent 的 run 通过 parent_run_id 形成树
  session_id TEXT NOT NULL,
  parent_run_id TEXT,               -- M5 使用
  task_id TEXT,                     -- 关联 M2 的任务
  cwd TEXT NOT NULL,
  provider TEXT, model TEXT, thinking_level TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  status TEXT NOT NULL,             -- running | completed | aborted | error
  stop_reason TEXT, error_type TEXT, error_message TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  ttft_ms INTEGER, duration_ms INTEGER
);

CREATE TABLE steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- llm_call | tool_call | approval | compaction | branch_summary | memory_write
  tool_name TEXT, tool_call_id TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER,
  is_error INTEGER DEFAULT 0, error_type TEXT, error_message TEXT,
  args_digest TEXT, args_bytes INTEGER,
  result_digest TEXT, result_bytes INTEGER,
  approval_rule TEXT, approval_risk TEXT, approval_decision TEXT,
  approval_wait_ms INTEGER, decided_by TEXT,
  meta TEXT
);

CREATE INDEX idx_steps_run ON steps(run_id);
CREATE INDEX idx_steps_kind_time ON steps(kind, started_at);
CREATE INDEX idx_steps_tool ON steps(tool_name, started_at);
CREATE INDEX idx_runs_session ON runs(session_id, started_at);
```

#### 4.1.2 采集点（零主链路侵入）

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| run 生命周期 | `agent_start` / `agent_end` / `agent_settled` | `agent_settled` 才代表自动重试与压缩队列都已收敛，是 run 的正常终态 |
| turn 边界 | `turn_start` / `turn_end` | 已有 `entry.turnStartedAt` |
| 模型响应、usage、cost | `message_end`（`logSessionEvent()` 已解析） | 直接落库，不重复计算 |
| 工具调用、耗时、错误 | `tool_execution_start` / `tool_execution_end` | 已有 `entry.toolStartTimes` |
| 审批等待 | `ToolApprovalBroker` 的 `onPending` 与 `decide()` | 记录 `approval_wait_ms` 与决策来源（人工/超时/中止） |
| 压缩 | `compaction_start` / `compaction_end` | 作为独立 step，便于分析「压缩是否频繁」 |
| TTFT（首 token 延迟） | `message_update` 首次到达时刻 | 现有代码没有，**这是新增的最有价值指标** |
| provider HTTP 层 | 观测内联扩展监听 `before_provider_headers` / `after_provider_response` | 拿 status code 与请求头耗时，用于区分「模型慢」与「网络慢」 |

实现形态：`services/observability/session-ledger.ts` 暴露 `record(entry, payload)`，由 `AgentRegistry.publish()` 尾部调用（**fire-and-forget，任何异常降级为 warn 日志，绝不冒泡到 agent loop**）。

#### 4.1.3 零成本修复项（建议在 M1 一并做掉）

`agent-registry.ts:661-662` 当前返回 `contextUsage: null, sessionStats: {}`。补齐方式：

```ts
// PiSession 门面新增可选能力
readonly getSessionStats?: () => unknown;
readonly getContextUsage?: () => unknown;
```

`state()` 改为：有则透传，无则保持 `null` / `{}`（保持与 Python 后端字段兼容）。**收益**：前端 `AgentControls.vue:149` 的上下文占用仪表盘立即有数据，成本账本也有权威来源。

#### 4.1.4 REST 契约

| 接口 | 返回 |
| --- | --- |
| `GET /api/observability/summary?from&to&cwd` | `{ totals, byModel[], byTool[], byApproval[], daily[] }` |
| `GET /api/observability/runs?sessionId&taskId&limit&cursor` | run 列表（分页） |
| `GET /api/observability/runs/:runId` | run + steps + 子 runs |
| `DELETE /api/observability/runs?before=<iso>` | 手动清理 |

`summary` 字段约定：

```jsonc
{
  "totals": { "runs": 0, "turns": 0, "inputTokens": 0, "outputTokens": 0,
              "cacheReadTokens": 0, "costUsd": 0,
              "p50DurationMs": 0, "p95DurationMs": 0, "p50TtftMs": 0, "errorRate": 0 },
  "byModel": [{ "provider": "deepseek", "model": "deepseek-chat", "runs": 0,
                "costUsd": 0, "tokens": 0, "p95DurationMs": 0 }],
  "byTool":  [{ "toolName": "bash", "calls": 0, "errors": 0, "errorRate": 0,
                "p50DurationMs": 0, "p95DurationMs": 0 }],
  "byApproval": [{ "rule": "recursive-delete", "risk": "critical",
                   "approved": 0, "denied": 0, "timedOut": 0, "p50WaitMs": 0 }],
  "daily": [{ "date": "2026-08-20", "runs": 0, "costUsd": 0,
              "inputTokens": 0, "outputTokens": 0 }]
}
```

#### 4.1.5 前端

新增 `web/src/components/ObservabilityPanel.vue`（右侧面板的第四个 tab，或独立抽屉）+ `web/src/lib/api.ts` 的 4 个封装 + `web/src/types/index.ts` 的类型。

必须同步的既有文件（仓库硬约束）：`types/index.ts`、`lib/api.ts`、`agent-events.ts`（若新增 SSE 事件）。

#### 4.1.6 落点文件

```text
services/platform/store.ts                 # SQLite/内存双实现 + 写入队列
services/platform/migrations.ts            # 建表与版本迁移
services/observability/session-ledger.ts   # 事件 → runs/steps
services/observability/metrics.ts          # 聚合查询 + 预聚合
services/observability/redact.ts           # 脱敏与 digest
services/observability/observability-extension.ts  # provider 层钩子（TTFT/HTTP）
routes/observability.ts
config.ts                                  # 新增 PI_NODE_TRACE_* 配置
```

#### 4.1.7 测试

- 单元：`redact()` 剔除密钥；`digest` 稳定；写入队列批量 flush 与丢弃策略。
- 集成：`app.inject()` 打一个 fake session 事件序列 → 断言 `summary` 的 totals/byTool 数值正确。
- 边界：SQLite 不可写（临时目录被占用）→ 服务仍能启动并降级为 memory 实现，`/api/health` 正常。
- 性能：1000 次 `record()` 的同步耗时 p95 < 5ms（防止阻塞事件循环回归）。

**DoD**：跑一个真实会话后，Dashboard 能显示成本、p95 延迟、工具成功率、审批命中率；关掉 trace 开关后行为与今天完全一致。

#### 4.1.8 实施修订（2026-08-21，M1 落地后回填）

本节是最初的规划口径；以下三处在实施中被修正，**以 [`node-observability-m1.md`](node-observability-m1.md) 为准**：

1. **`day_rollups` → `run_rollups(day, cwd, provider, model)`**：原设计下 `totals` 只能从 `runs`
   明细聚合，`prune` 清理明细后 `totals` 与 `byTool` 口径会互相矛盾（测试暴露）。改为单一 run
   聚合表后 `totals` / `byModel` / `daily` 同源，**清理明细不影响聚合历史**。
2. **聚合时间分辨率为「天 + cwd」**：预聚合表按 UTC 日期分桶，未结算的 `running` run 不计入聚合；
   只有 p50/p95 分位数按精确窗口取「最近 2000 条样本」（不足即精确值）。REST 契约里的
   `from`/`to` 因此对聚合是「天级」语义，对分位数是精确语义。
3. **`summary` 增加追加字段 `store`**：`{mode, degraded, pending, dropped}`，让前端能区分
   「没有数据」与「trace 未开启 / 已降级」。原契约字段一个未少。

另外两点实施细节：`steps.blocked_by` 的归因来源有三处（审批结算、Plan 拦截上报、结果文案兜底）；
run 的边界取 `agent_settled` 而非 `agent_start`（SDK 在重试/压缩续跑时会多次发 `agent_start`）。

---

### M2 任务领域（TaskService 复活）

**目标**：建立「任务」这个一等公民，作为 Plan 的载体与断点续跑的控制面。

`dist/services/task-service.d.ts` 里有一份此前未落地的设计（`TaskRecord` / `TASK_STATUSES` / 原子串行写 / `refreshTaskStatus`），本里程碑在其基础上**扩展而非推翻**：新增 `origin`、`revision`、`verification`、`evidence`、`execution`（租约）。

#### 4.2.1 数据模型

```ts
export const TASK_STATUSES = ['pending','in_progress','blocked','completed','cancelled'] as const;
export const STEP_STATUSES = ['pending','in_progress','completed','blocked','skipped'] as const;

export interface TaskStep {
  id: string;                        // 's1'，稳定 id（Plan 步骤沿用）
  title: string;
  details?: string;
  status: StepStatus;
  /** 步骤完成的验证声明：完成时服务端可据此校验，而不是相信模型自报 */
  verification?: {
    kind: 'command' | 'file' | 'manual';
    command?: string;                // kind=command：期望命令与退出码
    expectExitCode?: number;
    path?: string;                   // kind=file：期望存在的产物
  };
  /** 完成证据（由 complete_step 工具或 API 提供） */
  evidence?: {
    summary?: string;
    toolCallIds: string[];
    filesTouched: string[];
    commands?: Array<{ command: string; exitCode: number | null }>;
    lastError?: string;
  };
  blockedReason?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  steps: TaskStep[];
  origin: 'user' | 'plan';           // 区分手工任务与 Plan 产物
  sessionId?: string;
  cwd?: string;
  revision: number;                  // 乐观并发：写入必须带 ifRevision
  blockedReason?: string;
  conclusion?: string;
  execution: {                       // 断点续跑所需（M3）
    attempt: number;
    lastHeartbeatAt?: string;
    lease?: { owner: string; expiresAt: string };
    inFlight?: {
      stepId?: string;
      kind: 'turn' | 'tool';
      toolCallId?: string;
      startedAt: string;
      /** 崩溃时无法判定副作用是否已落地 → 恢复时必须人工确认 */
      sideEffect: 'none' | 'write' | 'unknown';
    };
  };
  createdAt: string;
  updatedAt: string;
}
```

**存储**：`~/.pi/agent-node-server/tasks.json`（沿用 `dist` 版设计的原子串行写，保证与本仓库现有持久化风格一致）；任务表同时镜像进 `platform.db` 供 Dashboard 关联（`task_id` 外键），单一真相源仍是任务文件。若 M1 已建好 store，则直接落 SQLite 表 `tasks` / `task_steps`，二者取其一，**不并存**（规划结论：M1 先落地时直接进 SQLite，删除 JSON 方案）。

#### 4.2.2 REST 契约

| 接口 | 说明 |
| --- | --- |
| `GET /api/tasks?status&sessionId&cwd` | 列表，按 `updatedAt` 倒序 |
| `POST /api/tasks` | `{ title, goal, steps[], sessionId?, cwd? }` |
| `GET /api/tasks/:id` | 详情 |
| `PATCH /api/tasks/:id` | `{ title?, goal?, status?, blockedReason?, conclusion?, ifRevision }`，`revision` 不匹配 → `409 task_conflict` |
| `POST /api/tasks/:id/steps` | 追加步骤 |
| `PATCH /api/tasks/:id/steps/:stepId` | 改状态/文案/顺序（`{ position? }`） |
| `DELETE /api/tasks/:id/steps/:stepId` | 删除步骤（已完成的需 `force: true`） |
| `POST /api/tasks/:id/cancel` | 取消 |
| `POST /api/tasks/:id/resume` | `{ mode: 'continue' | 'retry_step' | 'replan' }` → `202`（M3） |
| `GET /api/tasks/recovery` | 重启后可恢复任务清单（M3） |

SSE 新增：

```
{ type: 'task_updated', task: TaskRecord }
{ type: 'task_recovery_required', tasks: TaskRecoveryItem[] }   // M3
```

#### 4.2.3 测试

- 正常：创建任务、追加步骤、推进状态（`refreshTaskStatus` 由步骤聚合出的任务状态正确）。
- 边界：并发 `PATCH` 携带过期 `ifRevision` → 409；删除唯一未完成步骤后任务状态回落为 `pending`。
- 边界：损坏的任务文件 → 启动降级为空任务列表，不影响 Agent 启动（沿用 `dist` 版设计意图）。

**DoD**：任务可增删改查，重启后不丢；SSE 变更实时推送到前端任务面板。

#### 4.2.4 实施修订（2026-08-21，M2 落地后回填）

以 [`node-task-domain-m2.md`](node-task-domain-m2.md) 为准，以下四点做了明确化：

1. **状态只由步骤聚合，`completed` 不冻结**：`refreshStatus` 里只有 `cancelled` 是冻结状态，
   其余（含 `completed`）都由步骤重新聚合。这样「删除唯一未完成步骤」能回落到 `pending`
   （本节 DoD 的要求），代价是手工设置的 `status` 会在下一次步骤变更时被重新聚合——
   有意为之：不保留「任务说已完成、步骤还挂着」的隐藏状态。
2. **存储直接进 SQLite**：M1 先落地了 `platform.db`，因此按 §4.2.1 的结论走 SQLite
   （`tasks` / `task_steps`，迁移 v3），不再实现 JSON 原子串行写方案，二者不并存。
3. **`/resume` 与 `/recovery` 不在 M2 占位**：本节的接口表标注它们属于 M3；
   M2 只交付 CRUD 与 `cancel`，不提供「返回 202 但什么都不做」的空接口。
4. **并行并发用单语句乐观锁**：`UPDATE ... SET revision = revision + 1 WHERE id = ? AND revision = ?`
   按 `changes` 判定，409 `task_conflict` 带 `currentRevision`；不需要多语句事务或额外隔离级别。

另外两点边界：任务写入**不走** trace 的写入队列（它是用户可见状态，必须同步落库、错误冒泡）；
`runs.task_id` 只在 run **开始时**写入，执行中绑定任务不回溯已有 run。

---

### M3 断点续跑（Durable Execution）

**目标**：进程崩溃/重启后，未完成任务可被识别、解释并安全继续。

#### 4.3.1 三个核心机制

**1）执行租约（Lease）**

```ts
interface LeaseStore { acquire(taskId: string, owner: string, ttlMs: number): Promise<boolean>;
                       renew(taskId: string, owner: string, ttlMs: number): Promise<void>;
                       release(taskId: string, owner: string): Promise<void>; }
```

- `owner` = `pid + bootId`（每次进程启动生成新的 `bootId`）。
- 任务开始执行时 `acquire`，每 10s `renew`，正常结束 `release`。
- 启动时若发现 `status='in_progress'` 且租约已过期 → 该任务处于「疑似中断」状态，进入恢复清单。
- **防止双跑**：同一任务被两个进程持有时，第二个 acquire 失败 → 该任务只读。

**2）In-flight 标记（副作用判定）**

- `turn_start` → `inFlight = { kind: 'turn' }`；`agent_settled` → 清除。
- `tool_execution_start` → `inFlight = { kind: 'tool', toolCallId, sideEffect }`；`tool_execution_end` → 清除。
- `sideEffect` 判定：`read/grep/find/ls` → `none`；`edit/write/bash`（命中写规则）→ `write`；审批挂起中或结果未知 → `unknown`。
- **恢复策略**：
  - `sideEffect='none'` → 可自动重试该步；
  - `sideEffect='write'` → 必须**先验证产物**（比对步骤 `verification`），通过则标记完成，否则标记 `blocked` 并说明「上次执行中断，产物状态需人工确认」；
  - `sideEffect='unknown'` → **禁止自动继续**，必须人工确认。
- 这是 durable execution 最容易被忽略、也最能体现工程深度的一点。

**3）恢复上下文注入**

`POST /api/tasks/:id/resume` 的执行流程：

```text
1. 校验租约（不可双跑）
2. registry.open(task.sessionId) 重建 AgentSession（复用已持久化的 JSONL 上下文）
3. 生成恢复摘要 custom message（display: false）：
     [TASK RESUME]
     goal / 已完成步骤与证据 / 当前步骤 / 上次中断原因 / 未决的副作用
     要求：先复述当前状态并确认无冲突，再继续
4. 按 mode 决定动作：
     continue   → 继续当前步骤
     retry_step → 把当前步骤状态重置为 pending 后继续
     replan     → 进入 Plan 重构路径（M4）重新提交计划
5. 重新 acquire 租约并续跑
```

**4）启动时恢复清单**

`app.ts` 的 `onReady` 钩子（已存在，用于 `workspaceService.initialize()`）串行追加：

```ts
await store.initialize();
await taskService.initialize();
await recoveryService.scan();   // 产出 recovery 清单，不自动执行
```

- 结果通过 `GET /api/tasks/recovery` 暴露，并在**首个 SSE 连接建立时**补推一条 `task_recovery_required`。
- **不自动继续**是刻意设计：模型可能在无人时执行不可逆操作。默认需用户点「继续」。

#### 4.3.2 落点文件

```text
services/tasks/task-service.ts        # 领域逻辑（含 revision/refreshTaskStatus）
services/tasks/task-store.ts          # 持久化（SQLite 或原子 JSON）
services/tasks/task-lease.ts          # 租约
services/tasks/recovery-service.ts    # in-flight 分析与恢复清单
services/tasks/task-recovery-extension.ts  # turn/tool 事件 → inFlight 记录
routes/tasks.ts
```

#### 4.3.3 测试（本里程碑最重要）

- 集成：用 fake session 驱动「任务开始 → 第 2 步工具执行中」→ 模拟进程重启（重建 store/registry）→ 断言恢复清单包含该任务且 `sideEffect` 判定正确。
- 边界：租约未过期时第二个进程 acquire 失败 → 任务只读。
- 边界：`sideEffect='write'` 且产物校验失败 → 任务置 `blocked` 且 `blockedReason` 含中断说明。
- 边界：会话文件已被删除 → resume 返回 `409 task_session_missing`，任务标记 `blocked` 而非崩溃。
- **禁止**：测试不得触碰真实 `~/.pi`，全部注入临时目录（沿用仓库现有隔离约定）。

**DoD**：手工 kill 掉进程后重启，任务面板提示「1 个任务中断」，可一键继续且不产生重复副作用。

#### 4.3.4 实施修订（2026-08-21，M3 落地后回填）

以 [`node-task-recovery-m3.md`](node-task-recovery-m3.md) 为准。本节设计基本原样落地（租约、
在飞标记、恢复清单、`[TASK RESUME]` 注入、`/resume` 202），三处做了明确化/收紧：

1. **比规划更保守的写副作用判定**：§4.3.1 写的是 `tool_execution_end` 清除 in-flight。
   但那一刻步骤还没被标记完成——「写完文件、还没打勾就被杀」只看 inFlight 会被判成
   「两步之间」而自动续跑，正是重复副作用的来源。实现里额外保留 `execution.lastSideEffect`，
   且只在它属于**当前步骤的本次尝试**（`at >= step.startedAt`）时生效；`retry_step`
   重置步骤后自然失效（不需要额外清理代码）。
2. **`kind='command'` 的验证不自动执行**：执行任意 shell 等于绕过审批链路，M3 只做只读
   `stat`（`kind='file'`）；命令类校验由 M4 的完成工具接进工具调用与审批。
3. **`replan` 不占位**：直接 `409 replan_unavailable`（M4 接管），不做「返回 202 但什么都不做」。
4. **执行态写入也走 TaskService 的乐观锁并广播** `task_updated`：否则面板手里的 `revision`
   会静默落后，用户下一次操作会莫名 409。

另外两点实现的边界：恢复清单**只列不跑**（启动扫描只记日志）；写副作用产物缺失时
除了 `retry_step`（用户显式要求重做）之外一律把任务标 blocked 并拒绝续跑。

---

### M4 Plan 模式重构

**目标**：把 Plan 从「文本解析驱动的会话内状态」重构为「Task 的受控视图 + 结构化工具契约」。

#### 4.4.1 新的状态模型

```ts
export type PlanStatus =
  | 'drafting'    // Agent 正在调研/撰写计划
  | 'proposed'    // 已提交计划，等待用户确认
  | 'executing'
  | 'paused'      // 用户暂停或崩溃中断
  | 'completed'
  | 'abandoned';

export interface PlanStepView {
  id: string;                 // 与 TaskStep.id 一致
  title: string;
  details?: string;
  status: StepStatus;
  verification?: TaskStep['verification'];
  evidence?: TaskStep['evidence'];
  blockedReason?: string;
}

export interface PlanView {
  planId: string;             // 稳定 id，贯穿全生命周期
  taskId: string;             // 与 Task 1:1（plan 就是 origin='plan' 的 task）
  sessionId: string;
  status: PlanStatus;
  revision: number;
  title: string;
  steps: PlanStepView[];
  awaitingUserAction: boolean; // 需要用户动作时为 true（确认/澄清/解阻塞）
  draftingSince?: number;
  updatedAt: string;
}
```

**关键变化**：JSONL 里不再每次 `publish()` 追加完整快照，只追加一条 `{ customType: 'web-plan-ref', data: { planId, taskId } }` 引用指针（M2 的任务存储才是真相源）。这修掉 P5 的 JSONL 膨胀与「历史计划不可见」。

#### 4.4.2 结构化工具契约（修正 P2 的核心）

规划期由内联扩展注册以下工具（`pi.registerTool` + TypeBox，参考 SDK 的 `ToolDefinition`）：

| 工具 | 参数（TypeBox） | 作用 |
| --- | --- | --- |
| `submit_plan` | `{ title: string, steps: Array<{ title, details?, verification?: { kind, command?, expectExitCode?, path? } }> }` | 创建/替换计划 → Task(`origin='plan'`)，Plan 进入 `proposed`，返回 `{ planId, revision }` |
| `update_plan` | `{ revision: number, title?, steps? }` | 修订（`drafting`/`proposed`/`paused` 可用；`revision` 不匹配返回错误让模型重读） |
| `complete_step` | `{ stepId, evidence: { summary?, commands?: [{command, exitCode}], files?: string[] } }` | 完成一步；若该步声明了 `verification`，**服务端校验证据**，不符则返回 `isError: true` 并要求补齐 |
| `block_step` | `{ stepId, reason: string }` | 阻塞某步（计划转 `paused`，向用户求助） |
| `ask_user` | `{ question: string, options?: string[] }` | 规划期澄清，复用审批通道（`PendingToolApproval` 的 channel 复用，前端用同一对话框样式） |

**删除物**：`extractPlan()`、`markDone()`、`[DONE:n]` 约定、`awaitingConfirmation` 由文本解析赋值的全部路径。

**保留物**：`isSafePlanCommand()` 的思路保留但改为**能力分类**（见 4.4.3）。

**向后兼容**：`promptSnippet` / `promptGuidelines` 必须写清楚工具用法（SDK 会把它们注入系统提示词），这是结构化输出的可靠性来源——比在 `before_agent_start` 里写「请输出 `Plan:` 标题」强得多。

#### 4.4.3 规划期权限模型（修正 P6）

不再「快照 + 恢复」，改为**能力声明 + 显式放行验证命令**：

```ts
export interface PlanPolicy {
  /** 允许的只读工具（默认 read/grep/find/ls） */
  readOnlyTools: string[];
  /** bash 策略：none 完全禁止；verify 允许验证类命令；all 全放行（不推荐） */
  bash: 'none' | 'verify' | 'all';
  /** 验证类命令白名单（可被工作区 .pi/plan-policy.json 扩展） */
  verifyCommands: string[];
  /** 是否允许 MCP 只读工具（默认禁止，无法证明只读） */
  allowMcp: boolean;
}
```

默认 `verifyCommands` 显式包含（修复 P6 的痛点）：

```
tsc / tsc --noEmit / npm|pnpm|yarn run <script> / npx <tool> --help /
node -e '<no fs write>' / vitest run / jest / pytest / go build ./... / cargo check /
git status|log|diff|show|branch|remote / rg|fd|cat|head|tail|wc|ls|find|du
```

实现方式：解析命令的**能力类别**（读文件 / 写工作区 / 联网 / 提权 / 破坏性），而不是逐条正则黑名单。复用 `tool-approval.ts` 的 `ApprovalCategory` 分类结果，同一套判定同时服务审批与 Plan。

**退出恢复**：`restoreTools()` 不再写回旧快照，而是「叠加撤销」——记录本会话 Plan 期新增/移除的工具差集，退出时只撤销差集，用户在此期间的手动改动得以保留。

#### 4.4.4 入口 UX 重构（修正 P1）

- 移除 `AgentControls.vue` 的 Plan 预开关（`planActive` / `togglePlan`）。
- `ChatInput.vue` 增加**发送方式选择器**：`[ 直接执行 ▾ | 先规划 ]`（默认记住上次选择），并在输入框支持 `/plan` 前缀命令。
- `POST /api/agent/new` 与 `POST /api/agent/:sessionId { type:'prompt' }` 增加 `mode?: 'direct' | 'plan'`；新会话支持 `mode: 'plan'`（修掉「必须先发一条消息」）。
- 扩展监听 `input` 事件：把一次性「本条消息进入规划」变成消息级属性，而不是会话级全局状态。
- `PlanProgress.vue` 改造：
  - 步骤可**内联编辑**（标题/顺序/增删/跳过）→ 调 `PATCH /api/tasks/:id/steps/...`；
  - 新增 `暂停` / `继续` / `重试此步` / `放弃`（保留记录）按钮；
  - 展示每步的 `verification` 与 `evidence`（证据可展开）；
  - 历史计划入口：已完成/放弃的计划在侧栏可查（来自 Task 列表，而非会话内临时数据）。

#### 4.4.5 命令与事件契约迁移

| 旧 | 新 | 备注 |
| --- | --- | --- |
| `plan_enable` | `plan_start` | 语义：开始一次规划（配合 `mode` 使用） |
| `plan_refine` | `plan_refine` | 保留；驱动 Agent 用 `update_plan` 重交 |
| `plan_execute` | `plan_execute` | 保留；服务端校验 `status='proposed'` |
| — | `plan_pause` | 新增 |
| — | `plan_resume` | 新增（内部走 `POST /api/tasks/:id/resume`） |
| `plan_disable` | `plan_abandon` | 语义变更：**保留** Task 记录，仅结束 Plan |

`plan_enable` / `plan_disable` 作为 deprecated 别名保留一个版本并在文档标注，随后删除。

SSE：`plan_updated` 的载荷从 `PlanSnapshot` 换成 `PlanView`（破坏性变更，需同步 `web/src/types/index.ts` 与 `agent-events.ts`）。

#### 4.4.6 测试

- 单元：`submit_plan` 工具参数校验（空步骤、重复 title、含未知 verification kind → 错误）。
- 集成（**替代现有的正则断言**）：
  - 规划期 `edit`/`write`/MCP 工具被拦截 → 不变；
  - 验证类命令（`pnpm test`、`tsc --noEmit`）**放行**（当前是被拦的，属于行为修正）；
  - `submit_plan` → Plan `proposed` → `plan_execute` → `complete_step`（带证据）→ 状态推进；`complete_step` 证据不符 → `isError`；
  - `plan_pause` → `plan_resume` 保持 revision；
  - `plan_abandon` 后 Task 仍可查（`status='cancelled'`）。
- 回归：删除 `extractPlan`/`markDone` 后，原 `test/services/plan-mode.test.ts` 中依赖正则的用例必须**重写而非删除**（覆盖同样的用户旅程）。
- 前端：`web/test/components/PlanProgress.test.ts` 覆盖编辑/暂停/恢复交互。

**DoD**：模型不写任何特殊标记也能完成「规划 → 确认 → 执行 → 完成」全流程；执行中可改计划；退出后计划可查。

---

### M5 Subagent（上下文隔离 + 并行 + 预算隔离）

**目标**：主 Agent 能把子任务委派给独立上下文的子 Agent，并保持权限、预算与可观测性一致。

#### 4.5.1 工具契约

```ts
pi.registerTool({
  name: 'task',
  label: 'Delegate a subtask',
  description: 'Delegate a scoped subtask to a subagent with an isolated context window. Returns a summary, not the full transcript.',
  executionMode: 'parallel',       // 支持一次 fan-out 多个
  parameters: Type.Object({
    description: Type.String({ description: 'Short title, e.g. "Locate auth middleware"' }),
    prompt: Type.String({ description: 'Complete, self-contained instructions' }),
    agent: Type.Optional(Type.Union([Type.Literal('explore'), Type.Literal('verify'), Type.Literal('general')])),
    cwd: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(Type.String())),
    model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
    maxTurns: Type.Optional(Type.Number()),
    maxCostUsd: Type.Optional(Type.Number()),
    timeoutMs: Type.Optional(Type.Number()),
    background: Type.Optional(Type.Boolean()),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) { /* … */ },
});
```

`agent` 预设（把常用组合固化，避免模型每次自己拼）：

| 预设 | 工具集 | 模型 | 预算 | 典型用途 |
| --- | --- | --- | --- | --- |
| `explore` | `read/grep/find/ls`（**无 bash**） | 目录默认（或更便宜的档位） | maxTurns 12 / $0.10 | 大范围定位代码、调研 |
| `verify` | `read/grep/find/ls/bash(verify)` | 目录默认 | maxTurns 8 / $0.10 | 跑测试、复核改动 |
| `general` | 继承父会话工具集（**仍受审批约束**） | 目录默认 | maxTurns 20 / $0.50 | 需要写文件的独立子任务 |

#### 4.5.2 SubagentService 设计

```ts
export interface SubagentRequest {
  parentSessionId: string;
  parentRunId: string;
  cwd: string;
  prompt: string;
  agent: 'explore' | 'verify' | 'general';
  tools: string[];
  model?: { provider: string; modelId: string };
  budget: { maxTurns: number; maxCostUsd: number; timeoutMs: number };
  depth: number;                    // 父会话 depth + 1
}

export interface SubagentResult {
  subagentSessionId: string;
  runId: string;
  status: 'completed' | 'failed' | 'aborted' | 'budget_exceeded' | 'timeout';
  summary: string;                  // 只有摘要回传父上下文
  usage: { turns: number; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number };
}

export class SubagentService {
  constructor(
    private readonly factory: PiSessionFactory,   // 复用 OriginalPiSessionFactory
    private readonly registry: AgentRegistry,     // 子会话注册进注册表 → 前端可见
    private readonly ledger: SessionLedger,       // run.parent_run_id 形成 trace 树
    private readonly approvals?: ToolApprovalBroker,
    private readonly limits = { maxConcurrent: 3, maxDepth: 1 },
  ) {}
  async run(request: SubagentRequest): Promise<SubagentResult>;
  abortAll(parentSessionId: string): void;
  listForSession(parentSessionId: string): SubagentRecord[];
}
```

关键实现点：

1. **独立会话文件**：`SessionManager.create(cwd, sessionsDir, { parentSession: parentFile })` → 子会话可被 `SessionManager.listAll` 发现、被前端会话树按 `parentSessionPath` 缩进展示。
2. **防止递归**：`depth >= maxDepth` 时**不注册 `task` 工具**（构造子会话时用不同的 `extensionFactories` 列表），而不是在运行时拦截。这样「不能递归」是结构保证。
3. **权限继承**：子会话复用**同一个** `ToolApprovalBroker` 实例。`PendingToolApproval` 增加 `parentSessionId?: string`；SSE 的 `tool_call_pending` 载荷带上 `parentSessionId`，前端在**父会话界面**弹窗并标注「子任务：<description> 请求执行 …」。子 Agent 无法绕过审批。
4. **预算执行**（在子会话的事件订阅里计数，不看模型自报）：
   - `turn_start` → `turns++`；超 `maxTurns` → `abort()` + `budget_exceeded`；
   - `message_end` 累加 usage/cost；超 `maxCostUsd` → 同上；
   - 定时器 `timeoutMs` → 同上；
   - 达到上限时**返回已产出的摘要**而不是空结果（优雅降级）。
5. **上下文隔离与回收**：父会话只收到 `summary`（默认截断 8000 字符）+ usage + `subagentSessionId`。完整轨迹留在子会话 JSONL，前端可展开查看。
6. **取消级联**：父会话 `abort` → `SubagentService.abortAll(parentSessionId)`；`task` 工具的 `signal` 也要级联（`childSession.abort()`）。
7. **并发控制**：全局并发上限（默认 3）+ 每父会话上限（默认 4）；超出排队（`background: true` 时不阻塞父会话）。
8. **工作区边界**：`cwd` 必须位于 `WorkspaceService` 已登记的根目录内，否则工具返回 `isError: true`（复用 `file-service.ts` 的边界检查逻辑）。

#### 4.5.3 可观测与前端

- Trace：子会话的 run 通过 `parent_run_id` 挂到父 run，`GET /api/observability/runs/:runId` 返回子 run 列表 → Dashboard 能画出**执行树**与「子任务成本占比」。
- 前端：
  - `TaskCallBlock.vue`（工具卡片）：显示 `description` / 预设 / 预算进度条 / 状态 / 展开子会话；
  - 侧栏会话树缩进展示子会话（已有 `parentSessionPath`）；
  - 观测面板增加「委派统计」（次数、平均成本、成功率、被预算截断的比例）。

#### 4.5.4 测试

- 集成（用 `fauxProvider` 驱动，**不访问网络**）：
  - 父会话调用 `task` → 子会话被创建并注册进 registry → 返回摘要与 usage；
  - `depth = maxDepth` 时子会话**没有** `task` 工具；
  - 子会话触发危险命令 → `tool_call_pending` 的 `parentSessionId` 正确，父会话界面可见；
  - 超过 `maxTurns` → `budget_exceeded` 且摘要非空；
  - 父会话 abort → 子会话被 abort（断言子会话 `isStreaming === false`）；
  - `cwd` 越界 → `isError: true`。
- 边界：并发 5 个 `task` 调用 → 同时运行的子会话不超过 `maxConcurrent`。

**DoD**：一次 prompt 内并行启动 2 个 `explore` 子任务，父会话上下文只增加摘要；Dashboard 能展开看到两层 run 树与各自成本。

---

## 5. 契约变更总表（提交前必查清单）

仓库硬约束：任何路径、响应、SSE 载荷或状态字段变更，必须同步 `web/src/lib/api.ts`、`web/src/lib/agent-events.ts` 与 Pinia store。

### 5.1 REST 新增

| 路径 | 里程碑 |
| --- | --- |
| `GET /api/observability/summary` | M1 |
| `GET /api/observability/runs` / `runs/:runId` | M1 |
| `DELETE /api/observability/runs` | M1 |
| `GET/POST /api/tasks`、`/api/tasks/:id`、`/api/tasks/:id/steps(/:stepId)`、`/api/tasks/:id/cancel` | M2 |
| `POST /api/tasks/:id/resume`、`GET /api/tasks/recovery` | M3 |
| `POST /api/subagents`、`GET /api/subagents?sessionId` | M5 |

### 5.2 命令新增/变更（`POST /api/agent/:sessionId` body.type）

| 命令 | 状态 |
| --- | --- |
| `plan_start` / `plan_pause` / `plan_resume` / `plan_abandon` | 新增（M4） |
| `plan_enable` / `plan_disable` | deprecated 别名，保留一个版本（M4） |
| `prompt` 增加 `mode?: 'direct' \| 'plan'` | 扩展（M4） |
| `approve_tool` 增加可选 `subagentSessionId` | 扩展（M5） |

### 5.3 SSE 事件新增/变更

| 事件 | 载荷 | 里程碑 |
| --- | --- | --- |
| `plan_updated` | **变更**：`PlanSnapshot` → `PlanView` | M4 |
| `task_updated` | `{ task: TaskRecord }` | M2 |
| `task_recovery_required` | `{ tasks: TaskRecoveryItem[] }` | M3 |
| `tool_call_pending` | **扩展**：新增 `parentSessionId?`、`subagentLabel?` | M5 |
| `subagent_updated` | `{ subagentSessionId, description, status, usage }` | M5 |

### 5.4 前端文件清单

| 文件 | 变更 |
| --- | --- |
| `web/src/types/index.ts` | `PlanView` 替换 `PlanSnapshot`；新增 `TaskRecord` / `TaskStep` / observability 类型 / `SubagentInfo` |
| `web/src/lib/api.ts` | 上述 REST 封装 |
| `web/src/lib/agent-events.ts` | `reduceAgentEvent` 处理 `task_updated` / `subagent_updated` / `task_recovery_required` |
| `web/src/composables/useAgentSession.ts` | 连接新事件；`plan` 类型切换；`send()` 支持 `mode` |
| `web/src/components/PlanProgress.vue` | 可编辑步骤 + 暂停/继续/重试/放弃 + 证据展示 |
| `web/src/components/ChatWindow.vue` | 删除 `togglePlan` / `actPlan`，改为 `mode` 传递 |
| `web/src/components/AgentControls.vue` | 移除 Plan 预开关 |
| `web/src/components/ChatInput.vue` | 发送方式选择器 |
| `web/src/components/ObservabilityPanel.vue` | 新增 |
| `web/src/components/TaskPanel.vue` / `TaskCallBlock.vue` | 新增 |

### 5.5 文档同步（CLAUDE.md 要求：行为变化必须同步 README 与对应 docs）

| 文档 | 动作 |
| --- | --- |
| `docs/node-web-plan-mode.md` | **重写**（契约换成 `PlanView` + 工具驱动流程） |
| `docs/node-pi-backend.md` | 追加四项能力的功能清单 |
| `docs/node-command-approval.md` | 补充「能力分类」与 `ask_user` 复用通道 |
| `docs/node-extension-system.md` | 登记新增内联扩展（观测 / Plan 工具 / Subagent） |
| `docs/node-observability.md` | 新增 |
| `docs/node-tasks-and-recovery.md` | 新增 |
| `docs/node-subagent.md` | 新增 |
| `README.md` | 能力矩阵与启动说明（如新增 `npm run eval`） |

---

## 6. 测试与质量策略

沿用仓库约定：Node 用 `app.inject()` + fake session + 临时目录；**绝不访问网络、绝不触碰真实 `~/.pi`**。

| 层级 | 策略 |
| --- | --- |
| 单元 | 纯函数与领域逻辑：`redact`、`digest`、`refreshTaskStatus`、`PlanPolicy` 能力分类、`PlanView` 映射 |
| 集成 | `app.inject()` 驱动 REST，fake session 注入事件序列，断言 SSE 载荷与状态迁移 |
| 恢复 | 「模拟崩溃」测试：重建 store/registry 实例，断言恢复清单与副作用判定 |
| 确定性 Agent 测试 | 用 `fauxProvider` 注入 `setResponses([...])` 脚本，覆盖多轮工具调用而不是只测单轮 |
| 架构守护 | 新增 `test/architecture.test.ts`：禁止 `routes/` 直接 import SDK；禁止 `services/observability` 反向依赖 `routes`；禁止 `pi-python` 出现在任何 import 路径 |
| 前端 | Vitest + `@vue/test-utils`，覆盖 PlanProgress 编辑交互与 Dashboard 数据渲染 |

**必须补的工程基建（无 CI 则评测无意义）**：

```yaml
# .github/workflows/ci.yml
jobs:
  node-backend:  typecheck → test → build
  web:           typecheck → lint → test → build
  eval:          fake provider golden set（失败即阻断）
```

---

## 7. 风险与取舍

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| `node:sqlite` 为 experimental，API 可能变动 | 中 | 全部访问收敛在 `services/platform/store.ts` 单一适配层；出问题可切 `better-sqlite3` 而不动上层 |
| `DatabaseSync` 同步阻塞事件循环 | **高** | 批量 flush（250ms/200 条）+ 预聚合表 + 启动时实测 p95；超预算则切 worker thread 持有 DB |
| Plan 契约破坏性变更 | 中 | 自有前端可一次性切换；`plan_enable/disable` 保留别名一个版本；`docs/node-web-plan-mode.md` 同步重写 |
| 工具驱动计划可能被模型忽略（仍不调用 `submit_plan`） | 中 | `promptSnippet` + `promptGuidelines` 注入；`ask_user` 兜底；评测 case 专门覆盖「模型首轮不提交计划」的场景 |
| Subagent 成本失控 | **高** | 三重预算（turns/cost/timeout）+ 并发上限 + 深度上限 + Dashboard 委派成本占比告警 |
| 子 Agent 绕过审批造成安全问题 | **高** | 共享同一 `ToolApprovalBroker`；子会话**不注册**审批扩展的替代实现；评测强制覆盖「子会话触发危险命令」 |
| 恢复导致重复副作用 | **高** | `sideEffect` 三分法 + `write` 必须产物校验 + `unknown` 禁止自动继续 |
| 范围过大导致半成品 | 高 | 每个里程碑独立可交付、可回滚；M5 可整体延后而不影响前四项 |

**明确不做**（避免范围蔓延）：
- 不做多租户/用户体系（与本次主线正交）。
- 不做向量检索 / 长期记忆（可复用 M1 的 trace 底座另立里程碑）。
- 不做沙箱化执行（属安全纵深，`tool-approval.ts` 的能力分类为它预留了接口）。
- 不改 `pi-python/`。

---

## 8. 实施顺序与工作量估算

| 里程碑 | 内容 | 预估 | 依赖 |
| --- | --- | --- | --- |
| **M0** 验证性 spike | ① `node:sqlite` 写入 p95 实测；② `fauxProvider` 经 `registerProvider` 驱动完整 agent loop（含工具调用）；③ `SessionManager.create({parentSession})` 是否被前端会话树识别；④ `submit_plan` 工具与审批挂起的拦截顺序 | 2 天 | — |
| **M1** 可观测底座 | store + ledger + facade 指标补齐 + summary API + Dashboard | 1.5 周 | M0 |
| **M2** 任务领域 | TaskService + tasks API + SSE + 前端任务面板 | 1 周 | M1 |
| **M3** 断点续跑 | 租约 + inFlight + 恢复清单 + resume + 崩溃测试 | 1 周 | M2 |
| **M4** Plan 重构 | 工具契约 + 状态模型 + 权限模型 + UX 改造 + 文档重写 | 2 周 | M3 |
| **M5** Subagent | task 工具 + SubagentService + 预算/权限/取消 + trace 树 + 前端 | 1.5 周 | M1、M4 |
| 基建（穿插） | CI + `npm run eval` + 架构守护测试 | 2 天 | — |

合计约 **8 周**（单人，含测试与文档）。

**若时间受限的裁剪顺序**：保留 M1 → M2 → M3 → M4，把 M5 延后。理由：前三者构成「可度量 + 可恢复」的平台底座，M4 把当前**用户已明确抱怨的 Plan 体验**修好，三者组合已经能回答面试中最难的四类追问；M5 是能力纵深，缺它不影响前四项成立。

---

## 9. 验收清单与可量化指标

### 9.1 功能验收

- [ ] M1：任意会话结束后，`GET /api/observability/summary` 返回非零的 runs/cost/p95/工具成功率；前端上下文仪表盘（`AgentControls.vue`）显示真实占用。
- [ ] M1：关闭 trace 配置后，行为与改造前完全一致（回归测试证明）。
- [ ] M2：任务 CRUD + 乐观并发冲突返回 409 + 重启不丢。
- [ ] M3：kill 进程后重启，任务面板提示中断任务；`sideEffect='unknown'` 的任务禁止自动继续。
- [ ] M4：模型不输出任何特殊标记，也能完成「规划 → 确认 → 执行 → 完成」；执行中可改步骤；退出后任务仍可查。
- [ ] M4：`pnpm test` / `tsc --noEmit` 在规划期被放行（当前被拦）。
- [ ] M5：并行 2 个子任务，父上下文仅增加摘要；子会话触发危险命令时父界面弹出审批。
- [ ] CI：typecheck + test + build + fake eval 全绿。

### 9.2 简历可用的量化指标（实施过程中必须采集）

| 指标 | 采集方式 | 目标 |
| --- | --- | --- |
| 首 token 延迟 p50/p95 | M1 ledger `ttft_ms` | 改造前后对比，作为流式体验基线 |
| 单任务平均成本 | M1 `cost_usd` 按 task 聚合 | M5 上线后「委派是否更便宜」有数据 |
| 工具调用失败率 | M1 `byTool.errorRate` | 下降趋势 |
| 计划一次通过率 | M4 评测：`submit_plan` 首次即被确认的比例 | ≥ 80% |
| 评测任务成功率 | M4 golden set pass@1 | 作为回归门禁基线 |
| 崩溃恢复成功率 | M3 测试 + 手工演练 | 100% 且零重复副作用 |
| 审批误报率 | M1 `byApproval`（denied/approved） | 可量化「能力分类优于黑名单」 |

---

## 10. 附：现状代码引用索引

| 位置 | 说明 |
| --- | --- |
| `node-pi/server/src/services/agent-registry.ts:799` | `publish()` 事件汇聚点（M1 插桩处） |
| `node-pi/server/src/services/agent-registry.ts:813` | `logSessionEvent()` 已解析 turn/工具/usage/cost |
| `node-pi/server/src/services/agent-registry.ts:661-662` | `contextUsage: null, sessionStats: {}`（M1 零成本修复） |
| `node-pi/server/src/services/agent-registry.ts:334` | `loader()` 内联扩展注入（M1/M4/M5 接入点） |
| `node-pi/server/src/services/plan-mode-service.ts:72` | `extractPlan()` 正则解析（M4 删除） |
| `node-pi/server/src/services/plan-mode-service.ts:100` | `markDone()` `[DONE:n]`（M4 删除） |
| `node-pi/server/src/services/plan-mode-service.ts:111` | `isSafePlanCommand()` 白名单（M4 改为能力分类） |
| `node-pi/server/src/services/plan-mode-service.ts:303-315` | 快照式工具限制/恢复（M4 改为差集撤销） |
| `node-pi/server/src/services/plan-mode-service.ts:316-324` | `publish()` 每次追加完整快照（M4 改为引用指针） |
| `node-pi/server/dist/services/task-service.d.ts` | 未落地的 TaskService 设计（M2 的起点） |
| `node-pi/server/src/routes/agent.ts:266` | SSE 端点（M1/M2/M5 新事件复用） |
| `node-pi/server/src/services/agent-registry.ts:537` | `subscribe()` 断线重放 |
| `node-pi/server/src/app.ts:173` | `onReady` 钩子（M3 恢复扫描接入点） |
| `web/src/components/ChatWindow.vue:193-252` | `actPlan` / `togglePlan`（M4 删除） |
| `web/src/components/PlanProgress.vue` | Plan 面板（M4 改造为可编辑 + 证据展示） |
| `web/src/types/index.ts:305-315` | `PlanMode` / `PlanTodo` / `PlanSnapshot`（M4 替换为 `PlanView`） |
| `node-pi/server/node_modules/@earendil-works/pi-ai/dist/providers/faux.d.ts` | `fauxProvider()`（M4 评测的离线驱动） |
