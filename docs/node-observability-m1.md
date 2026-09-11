# M1 可观测底座（SessionLedger + 用量面板）实现说明

更新日期：2026-08-21
适用范围：`node-pi/server`（采集/存储/查询）+ `web/`（用量面板）
前置阅读：[`node-platform-plan.md`](node-platform-plan.md) §3–§4.1、[`node-platform-m0-spike.md`](node-platform-m0-spike.md)

---

## 1. 目标与边界

把「每次运行花了多少钱、慢在哪、工具可不可靠、审批拦得对不对」变成可查询的事实，
**不改动 Agent 主链路**，也不触碰 `~/.pi/agent`。

| 目标 | 落地 |
| --- | --- |
| 成本账本 | `runs` 表累计 tokens / cost / 轮次，聚合到日、模型、工作区 |
| 延迟可观测 | run 耗时、llm_call 耗时、**TTFT（首 token）**、provider HTTP 首字节耗时 |
| 工具可靠性 | 每次 tool_call 的耗时/成败，**区分「策略拦截」与「真实失败」** |
| 审批命中率 | 每次审批的规则、风险、决策、等待时长与决策来源 |
| 零侵入 | 唯一插桩点 `AgentRegistry.publish()`，异常一律降级为 warn |

**不做**（明确留给后续里程碑）：任务领域（M2）、断点续跑（M3）、评测 golden set（M4）、
subagent 的 run 树（M5，但 `runs.parent_run_id` 已预留）。

---

## 2. 架构与数据流

```
Pi SDK 事件流 ──► AgentRegistry.publish()   ← 唯一插桩点（fire-and-forget）
                     │
                     ├─► SessionLedger.record(ctx, event)   ← 事件 → runs/steps
                     │      ├─ ToolApprovalBroker.setTraceSink()  ← 审批挂起/结算
                     │      ├─ PlanModeService.setTraceSink()     ← 规划期拦截
                     │      └─ buildObservabilityExtension()      ← provider HTTP 观测
                     │
                     └─► TraceRepository (QueuedTraceRepository)
                            ├─ 250ms / 200 条攒批，读前强制 flush
                            └─ TraceStorage：SqliteTraceStorage | MemoryTraceStorage
```

| 文件 | 职责 |
| --- | --- |
| `services/platform/migrations.ts` | 建表与 `PRAGMA user_version` 版本迁移（事务内整体应用） |
| `services/platform/trace-model.ts` | 领域模型（runs/steps/查询条件）与共享纯函数 |
| `services/platform/trace-repository.ts` | 接口契约 + 写入队列 + 空实现（trace 关闭时） |
| `services/platform/sqlite-trace-storage.ts` | SQLite 后端（批量事务写 + 预聚合 + 有界样本） |
| `services/platform/memory-trace-storage.ts` | 内存后端（与 SQLite **语义等价**，有等价性测试） |
| `services/platform/store.ts` | 装配入口：选后端、建库、套队列、失败回落内存 |
| `services/observability/redact.ts` | 三层脱敏 + digest/字节数/预览 |
| `services/observability/session-ledger.ts` | 事件 → runs/steps（**唯一埋点逻辑**） |
| `services/observability/observability-extension.ts` | provider 层钩子（HTTP status / 首字节耗时） |
| `services/observability/metrics.ts` | 分位数计算与 REST 整形（纯函数） |
| `routes/observability.ts` | 4 个只读/清理接口（薄适配层） |
| `web/src/components/ObservabilityPanel.vue` | 用量面板（设置 → 用量） |

---

## 3. 数据模型

```sql
runs(id, session_id, parent_run_id, task_id, cwd, provider, model, thinking_level,
     started_at, ended_at, status, stop_reason, error_type, error_message,
     turns, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
     cost_usd, ttft_ms, duration_ms, meta, day)

steps(id, run_id, session_id, turn_index, kind, tool_name, tool_call_id,
      started_at, ended_at, duration_ms, is_error, blocked_by,
      error_type, error_message, args_digest, args_bytes, result_digest, result_bytes,
      approval_rule, approval_risk, approval_decision, approval_wait_ms, decided_by,
      meta, day)

-- 预聚合（写入时增量维护，读路径不扫明细）
run_rollups(day, cwd, provider, model, runs, turns, input_tokens, output_tokens,
            cache_read_tokens, cost_usd, errors)
tool_rollups(day, cwd, tool_name, calls, errors, blocked, duration_ms_sum)
approval_rollups(day, cwd, rule, risk, approved, denied, timed_out, wait_ms_sum)
```

- `kind` 取值：`llm_call | tool_call | approval | compaction | branch_summary | memory_write`。
- `blocked_by` 取值：`approval | plan_mode | policy`（**非空即「被策略拦下」**）。
- `year/month/day` 分桶用 UTC 日期字符串（`YYYY-MM-DD`），便于 `day>=? AND day<=?` 走索引。
- 预聚合表里 `provider`/`model` 用**空串**代替 NULL：SQLite 的 UNIQUE 视 NULL 互不相等，
  存 NULL 会让 `ON CONFLICT` 匹配不上而写出重复行。

**迁移规则（重要）**：已发布的 DDL **不得直接改写**，只能追加新版本迁移。目前
`MIGRATIONS` 有两个版本：v1（建表）与 **v2（把过渡期的 `day_rollups` 修成 `run_rollups`）**。
后者对新建库幂等，对已经跑过旧版代码的库会补齐缺失表并清掉遗留表——开发期间正在运行的
`npm run dev` 会因文件变动自动重启并自动完成修复（本次已在真实库上验证：`user_version` 1 → 2）。

---

## 4. 采集口径（关键语义）

| 事件 | 记账行为 |
| --- | --- |
| `agent_start` | 无进行中 run 时**开一个 run**（重试/压缩触发的重复 `agent_start` 不新开） |
| `agent_settled` | **结算 run**（唯一的终态点，见下） |
| `turn_start` | `turns += 1`，开一个 `llm_call` 步骤 |
| `message_update`（assistant，首次） | 记录 **TTFT = now − 本轮请求发出时刻** |
| `message_end`（assistant） | 关 `llm_call` 步骤 + 累计 usage/cost/stopReason |
| `tool_execution_start/end` | 关 `tool_call` 步骤（耗时、is_error、blocked_by、digest） |
| `compaction_start/end` | 一条 `compaction` 步骤 |
| `auto_retry_start` | `run.meta.retries += 1`（续跑不再新开 run） |
| 审批挂起/结算 | `approval` 步骤（rule/risk/decision/waitMs/decidedBy） |
| `before_provider_headers` / `after_provider_response` | `llm_call.meta.{httpStatus,httpLatencyMs}` |

**run 边界为什么取 `agent_settled`**：SDK 的 `_runAgentPrompt()` 在自动重试、阈值压缩、
队列续跑时会多次触发 `agent_start`，只有 `agent_settled` 在所有自动行为收敛后才发一次
（见 `dist/core/agent-session.js`）。取错边界会把一次用户请求拆成多个 run，成本统计直接失真。

**策略拦截 vs 真实失败**（M0 修正 ④ 的落地）：
SDK 对两者都只发 `tool_execution_end(isError=true)`，因此账本主动收集归因：

1. `ToolApprovalBroker` 结算时上报 decision/decidedBy → 未放行时标 `blocked_by='approval'`；
2. `PlanModeService` 拦截时上报 `noteToolBlock` → 标 `blocked_by='plan_mode'`；
3. 兜底：结果文案命中已知拦截文案（`Tool execution was not approved` /
   `Plan mode is read-only`）→ 标 `blocked_by='policy'`。

`steps.is_error` 保留 SDK 原始值，`byTool.errorRate` 只统计 `blocked_by IS NULL AND is_error=1`。
**被正确拦下的调用不计入失败率**，`cwd` 侧另有 `blocked` 计数单独展示。

**成本兜底（DeepSeek 用量恒为 $0 的根因）**：
`models.json` 里重复定义同名模型时，SDK 的 provider-composer 会用该定义覆盖内置模型，并把未填写的
`cost` 归零（`dist/core/provider-composer.js` 的 `modelFromJson`），于是「自定义了 provider 但没写价格」
的配置（典型是 DeepSeek）在用量面板里永远是 $0。账本在 `message_end` 累计成本时按此口径处理：

1. 模型显式给出的**非零** `usage.cost.total` 优先，原样累加；
2. 为 0/缺省时，用 `getBuiltinModel(provider, model)` 回查内置目录，按与 pi-ai `calculateCost` 相同的
   阶梯价口径重算（`services/observability/model-cost.ts` 的 `builtinCostUsd`）；
3. 目录里没有该模型则保持 0——自定义模型的真实价格只能由用户在模型配置页填 `cost`。

兜底只影响**新写入**的 run，不回溯已有记录；模型配置页的一键 DeepSeek 预设已带上官方价格。

---

## 5. 关键取舍与对规划的偏离

| 决策 | 原因 |
| --- | --- |
| 聚合走**预聚合表**，时间分辨率为「天 + cwd」 | 规划要求「读路径不扫全表」。M0 实测 20 万行全表 `GROUP BY` ≈ 96ms。代价是自定义的中间时间窗会按整天计入，故在 API 文档与前端都标注；分位数仍按精确窗口取样本。 |
| `run_rollups` 取代规划里的 `day_rollups` | 实现中发现：只用 `day_rollups` 时 `totals` 要从 `runs` 明细算，一旦 `prune` 清理明细，`totals` 与 `byTool` 口径立刻互相矛盾（测试暴露）。改为按 `(day, cwd, provider, model)` 单一聚合表后，`totals` / `byModel` / `daily` 同源，**清理明细后聚合历史完整保留**。 |
| 分位数用**有界样本**（默认最近 2000 条）而非直方图 | SQLite 无 percentile 函数；等宽直方图需要每个工具几百个桶，误差与行数都不划算。样本不足 N 时结果**精确**，超过则是「最近样本」的近似值。 |
| `prune` 只删明细、**不动预聚合** | 明细用于下钻，聚合用于长期趋势。清理后 Dashboard 累计口径不变，只是 drill-down 变少（REST 返回 `deletedRuns`）。 |
| run 的 provider/model 取 run 开始时；每次调用的 provider/model 记在 `llm_call.meta` | 中途 `set_model` 时，run 归属保持稳定，逐次调用的真实模型仍可下钻。 |
| 未结算（`running`）的 run **不计入聚合** | 聚合只在 `run_finish` 时增量写入。这类 run 仍出现在 `/runs` 列表里（status=running），进程崩溃留下的记录会被 `registry.close()` 收尾或保留为 running。 |
| `createApp()` 不传 trace 配置时**不写盘** | 测试用 `createApp()` 绝不允许触碰真实 `~/.pi`。生产由 `server.ts` 传 `config.trace`（默认开启 SQLite）。 |

---

## 6. 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_NODE_DATA_DIR` | `~/.pi/agent-node-server` | 本项目私有数据目录（不占用 pi 命名空间） |
| `PI_NODE_TRACE` | `1` | `0` 关闭可观测性：写操作变空实现，REST 仍返回空集 |
| `PI_NODE_STORE` | `sqlite` | `memory` 时整体走内存实现（无盘环境/测试） |
| `PI_NODE_TRACE_DB` | `<dataDir>/platform.db` | SQLite 库文件路径 |
| `PI_NODE_TRACE_CONTENT` | `0` | `1` 时额外保留**已脱敏、已截断**的正文（默认只存 digest + 120 字符预览） |
| `PI_NODE_TRACE_FLUSH_MS` | `250` | 攒批时间上限（10–60000） |
| `PI_NODE_TRACE_BATCH` | `200` | 攒批条数上限（1–5000） |
| `PI_NODE_TRACE_MAX_PENDING` | `5000` | 队列硬上限，超出丢最旧并计数（100–1000000） |

降级路径（都只记 warn、绝不阻断服务）：

1. `PI_NODE_STORE=memory` → 内存实现；
2. SQLite 打不开/建表失败 → 自动回落内存；
3. 运行时连续 flush 失败 3 次 → `degraded`：后续写入直接丢弃并计数（面板会显示告警）；
4. 队列超限 → 丢最旧一条并计数。

---

## 7. REST 契约

| 接口 | 返回 |
| --- | --- |
| `GET /api/observability/summary?from&to&cwd` | `{ totals, byModel[], byTool[], byApproval[], daily[], store }` |
| `GET /api/observability/runs?sessionId&taskId&limit&cursor` | `{ runs[], nextCursor }`（键集分页，`limit` 1–500，默认 50） |
| `GET /api/observability/runs/:runId` | `{ run, steps[], children[] }` |
| `DELETE /api/observability/runs?before=<iso>` | `{ ok, deletedRuns }`（`before` 必填） |

- 时间参数接受 ISO 字符串或毫秒时间戳；非法参数 `422 validation_error`；
  `from > to` 也 422；run 不存在 `404 run_not_found`。
- `summary.store` 是**追加字段**（非规划契约）：`{mode, degraded, pending, dropped}`，
  让面板能区分「没有数据」与「没开 trace/已降级」。
- 字段清单与前端类型一一对应：`web/src/types/index.ts`、`web/src/lib/api.ts`。

---

## 8. 隐私与边界

1. **默认不落正文**：参数/结果只存 `sha256(内容).slice(0,12)`、字节数与 120 字符预览；
   正文需显式 `PI_NODE_TRACE_CONTENT=1`，且落库前已脱敏、已截断（8KB）。
2. **三层脱敏**（`redact.ts`）：密钥键名整值替换 → 密钥形态（`sk-`/`Bearer`/`ghp_`/`AKIA`/
   `xoxb-`/私钥块）替换 → 大字符串只脱敏预览前缀（避免拖住事件循环，digest 输入封顶 256KB）。
3. **与 CLI 的边界**：库文件落在 `~/.pi/agent-node-server/platform.db`，不读写、不修改
   `~/.pi/agent` 下的任何文件；trace 只读 SDK 内存事件。
4. **对 agent loop 零影响**：`record()` 与所有 `note*` 方法内部 try/catch，异常只记 warn；
   队列写失败降级而非抛出。

---

## 9. 前端

- 入口：设置弹窗新增「用量」分类 → `ObservabilityPanel.vue`。
- 内容：时间范围（24h/7d/30d/全部）+「仅当前工作区」开关、KPI（运行次数与失败率、
  累计成本与 token、p95/p50 耗时、首 token p50）、模型/工具/审批三张表、每日成本柱状图、
  最近运行列表（**点击展开 steps**，标出被策略拦下的步骤）。
- `trace` 未开启或降级时显示明确提示。
- 顺带修复：`ContextUsage.tokens/percent` 改为可空（SDK 在刚压缩完返回 null），
  `AgentControls` / `ChatWindow` 此时不渲染仪表盘，避免显示 `NaN%`。

---

## 10. 测试与验证

| 测试 | 覆盖 |
| --- | --- |
| `test/services/platform/trace-store.test.ts` | 迁移幂等、聚合口径、cwd/时间过滤、键集分页、run 详情、**清理明细后聚合保留**、SQLite/内存**等价性**、队列攒批/定时/丢旧/降级/关闭、SQLite 不可用回落内存 |
| `test/services/observability/session-ledger.test.ts` | 脱敏与摘要、全事件序列 → run/steps、审批决策与拦截归因、plan 拦截与文案兜底、provider HTTP meta、重试计数、会话收尾、命令级失败、**sink 抛错时不冒泡** |
| `test/services/observability/registry-ledger.test.ts` | registry→ledger 端到端、prompt 失败、会话移除收尾、**trace 关闭时不建库** |
| `test/services/observability/ledger-e2e.test.ts` | **真实 SDK + 离线 fauxProvider** 跑完整 agent loop：run/turns/tokens、2 个 llm_call、`httpStatus=200`、tool_call 归因、summary 有数 |
| `test/services/observability/metrics.test.ts` | 分位数边界、取整、空窗口、store 健康字段、序列化 |
| `test/routes/observability-routes.test.ts` | 4 个接口、参数校验、分页、详情、清理语义、trace 关闭仍可用 |
| `test/services/agent-registry-state.test.ts` | `contextUsage`/`sessionStats` 透传与兜底 |
| `web/test/components/ObservabilityPanel.test.ts` | 指标渲染、范围/工作区切换触发重载、按需加载详情与拦截标记、未开启提示、错误提示 |
| `web/test/lib/api.test.ts` | 新接口的 URL 构造与方法 |

验证命令：

```powershell
cd node-pi/server && npm run format:check && npm run typecheck && npm test && npm run build && npm run spike
cd web && npm run typecheck && npm run lint && npm test && npm run build
```

---

## 11. DoD 对照

| DoD | 结果 |
| --- | --- |
| 跑一个真实会话后，Dashboard 能显示成本、p95 延迟、工具成功率、审批命中率 | ✅ `ledger-e2e.test.ts` 用真实 SDK 落库；面板读同一套接口（成本/延迟/工具表/审批表/每日） |
| 前端上下文仪表盘显示真实占用 | ✅ 透传 `getContextUsage()`（M0 已实测存在），并处理 `null` 占用 |
| 关掉 trace 配置后行为与今天完全一致 | ✅ `registry-ledger.test.ts` 断言「不建库、不写文件」，服务照常启动，接口返回空集 |
| 1000 次 `record()` 同步耗时 p95 < 5ms；写入 mock 抛错后 agent loop 仍能跑完 | ✅ 实测（SQLite 后端、batchSize 200）：**p50 0.004ms / p95 0.011ms / max 5.5ms**——max 来自每 200 条一次的批量 flush（单事务 `lastFlushMs ≈ 3.4ms`），不是单条开销；该数字由 `session-ledger.test.ts` 的用例守门。mock 抛错时 `record()` 不抛、只记 warn；flush 失败进入 degraded 而非抛出 |
| `steps` 必须区分策略阻断与工具失败 | ✅ `blocked_by` 字段 + 三处归因 + `byTool.errorRate` 口径 + 单测与端到端断言 |
| 读路径不扫全表 | ✅ 聚合全部走预聚合表；分位数走有界样本（LIMIT，索引扫描） |

---

## 12. 已知限制与后续

| 项 | 说明 |
| --- | --- |
| 聚合时间分辨率 | 为「天 + cwd」；自定义小时级窗口会按整天计入。若将来需要小时级，可给预聚合表加 `hour` 分桶（表结构已按此思路设计）。 |
| 进程被强杀 | 进行中的 run 会留下 `status=running` 记录；正常关闭（`registry.close()`）会收尾为 `aborted`。M3 的恢复扫描可顺带清理。 |
| 规划期拦截的端到端验证 | 归因逻辑有单测；未在 e2e 中开启 Plan 模式（需要 `session_start` + 命令链路）。 |
| 子 agent run | `parent_run_id` 已预留，实际写入留给 M5。 |
| 面板刷新 | 手动刷新 + 切换条件自动加载；未做 SSE 实时推送（M1 不引入新事件类型，避免改前端契约）。 |
| 成本兜底不回溯 | 被 `models.json` 覆盖掉价格的历史 run 仍是 $0；兜底只对新记录生效，不重算历史。 |
| 目录外模型仍为 $0 | 不在内置目录里的模型（如内测模型）没有价格来源，需用户在模型配置页填 `cost`，否则成本保持 0。 |
