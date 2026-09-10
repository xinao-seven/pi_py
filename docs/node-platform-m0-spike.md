# M0 验证性 Spike 报告：离线确定性能力 · 存储选型 · 持久化边界审计

更新日期：2026-08-20
关联规划：`docs/node-platform-plan.md`（M0 里程碑）
状态：**已完成**（四项全部验证，含两项对规划的修正与一项新增安全审计）
复现方式：`cd node-pi/server && npm run spike`（离线、临时目录、不触网、不触碰真实 `~/.pi/agent`）

---

## 0. 结论摘要

| # | 验证项 | 结论 | 对规划的影响 |
| --- | --- | --- | --- |
| ① | `node:sqlite` 写入延迟 | ✅ 可用且**远比规划预期快**：批量 200 行 p95 = **0.65ms** | 规划的「高风险：同步阻塞事件循环」**降级为低风险**；批量 flush 策略仍保留 |
| ② | `fauxProvider` 驱动完整 agent loop | ✅ 完全可行，含工具调用、usage、cost、contextUsage | M4 评测 / M5 测试的驱动层**成立**；但需新增 `@earendil-works/pi-ai` 直接依赖 |
| ③ | `SessionManager.create({ parentSession })` | ✅ 父子关系写入 JSONL header，`listAll` 正确回填 `parentSessionPath` | M5 子会话可被前端会话树识别，**成立** |
| ④ | 扩展工具与审批的拦截顺序 | ✅ 完整成立，且发现 3 个规划未覆盖的行为细节 | M4 权限模型地基**成立**；需修正 M1 的 `byTool.errorRate` 语义 |

**额外产出**：对「web 与 CLI 共享态」的边界审计（第 3 节）。结论：**现有写入整体合规且 `models.json` 的写法可作为范本**；唯一需加固的是会话删除的原子性与可恢复性（非阻塞项）。同时给出 trace 与 CLI 完全隔离的证明（3.7）。

---

## 1. 逐项证据

### ① `node:sqlite` 写入延迟实测

环境：Node **v24.18.0**，Windows，`PRAGMA journal_mode=WAL`。

```
单行一次事务    n=2000 batch=  1  p50=0.28ms  p95=0.37ms  p99=0.55ms  max=1.42ms
批量 20 行      n= 500 batch= 20  p50=0.32ms  p95=0.38ms  p99=0.41ms  max=2.99ms
批量 200 行     n= 300 batch=200  p50=0.53ms  p95=0.65ms  p99=0.98ms  max=10.04ms

聚合查询（20 万行全表 GROUP BY）: 96.59ms
建索引耗时:                   150.05ms
带索引的点查聚合:                9.22ms
```

**判读**：

- 规划的工程风险应对（「250ms 或累计 200 条批量 flush」）**实测成本仅 0.65ms**，对事件循环的影响可忽略。原「高」风险评级是基于假设，现已证伪 → **降级为低**。
- **真正的风险被规划写错了地方**：不是写入，而是**无索引的全表聚合（96ms）**。规划已给出正确对策（「预聚合表 + 定时汇总，不在请求里跑全表扫描」），这条必须严格执行。
- 结论：`node:sqlite` 作为存储**保留**，无需引入 `better-sqlite3`（也就无需在 Windows 上承担原生编译风险）。

### ② `fauxProvider` 离线确定性驱动

**发现的阻塞点（规划未提）**：`@earendil-works/pi-ai` **不是** `node-pi/server` 的直接依赖，只嵌套在 `pi-coding-agent/node_modules/` 下；`pi-coding-agent` 的 `dist/index.d.ts` **不导出** `fauxProvider`。规划的原文「经 `pi-ai` 顶层导出」在**本仓库的依赖布局下不成立**。

**解决**：新增直接 devDependency `@earendil-works/pi-ai@0.83.0`（与 `pi-coding-agent` 同版本，npm 自动 dedupe 为单份）。

**注入路径**（规划未给，此处确定）：

```
fauxProvider()  →  ModelRuntime.registerNativeProvider(faux.provider)
                →  runtime.getModel(providerId, modelId)
                →  createAgentSession({ modelRuntime, model, ... })
```

**实测结果**（脚本化 2 轮：工具调用 → 文本结论）：

```
[1] faux api id = faux:1789014804194:pgqp1vdm4cg | provider.id = faux
[2] registerNativeProvider 后可解析模型 = faux/faux-1
    → tool_execution_start: read {"path":"hello.txt"}
    → tool_execution_end: read isError= true
    → assistant: 已读取文件，结论是 OK。
[3] agent loop 完成，耗时 14.6ms，faux 调用轮次 = 2
[4] 事件序列: agent_start, turn_start, message_start, message_end,
              message_update, tool_execution_start, tool_execution_end,
              turn_end, agent_end, agent_settled
[5] 最终消息序列: user → assistant → toolResult(read) → assistant
[7] getSessionStats(): {"toolCalls":1,"toolResults":1,"totalMessages":4,
      "tokens":{"input":831,"output":11,"cacheRead":452,"cacheWrite":832,"total":2126},
      "cost":0,"contextUsage":{"tokens":877,"contextWindow":128000,"percent":0.685}}
[8] getContextUsage(): {"tokens":877,"contextWindow":128000,"percent":0.685}
[9] 剩余待发响应 = 0
```

**判读**：

- 完整 agent loop（含工具执行、错误工具结果、多轮）可离线确定性驱动，**M4 评测与 M5 集成测试无需自建假 provider**。
- `getPendingResponseCount() === 0` 可作为「脚本被完整消费」的断言，防止用例静默漂移。
- **同时验证了 M1 的零成本修复项**：`getSessionStats()` 已包含 `contextUsage.tokens / contextWindow / percent`，`getContextUsage()` 亦可直接调用。`agent-registry.ts:661-662` 硬编码的 `contextUsage: null` **确认纯属丢弃数据**。
- `agent_settled` 事件确实存在且在每个 turn 结束链路的末尾发出，规划「以 `agent_settled` 作为 run 正常终态」的判断成立。

### ③ 父子会话与 `parentSessionPath`

```
[1] 父会话 id = 01a08997-a174-…
[2] 子会话 id = 01a08997-a1ad-…
[3] 子会话 JSONL header: {"id":"01a08997-a1ad-…","parentSession":"<path>"}   ✅ 等于父文件
[4] listAll 发现 2 个会话
    子 id=01a08997… parentSessionPath=有(7240-8b8d-c052d43561f2.jsonl)
    父 id=01a08997… parentSessionPath=无
[5] 与父会话 path 一致 = true
```

**判读**：M5 的「子会话被前端会话树按 `parentSessionPath` 缩进展示」**不需要任何额外实现**，只需在创建子会话时传 `parentSession`。同时确认 `parentSession` 是写进 **JSONL 第一行 header** 的——这一点对第 3 节的安全审计很关键。

### ④ 扩展工具与 `tool_call` 钩子链（M4/M5 地基）

实测设计：扩展 A（模拟 Plan）注册 `submit_plan` 工具 + 拦截 `edit`；扩展 B（模拟审批）拦截 `bash`。

```
[1] tool_call 钩子调用顺序:
    1. plan-hook:submit_plan
    2. approval-hook:submit_plan      ← 扩展注册的工具同样走钩子链 ✅
    3. plan-hook:edit
    4. plan-hook:bash
    5. approval-hook:bash
```

**阻断语义精确定义**（单独一轮 `probe` 工具验证）：

```
[1] 钩子顺序: plan:probe                ← 后注册的 approval 钩子未被调用（短路）
[2] 工具体实际执行次数 probeRuns = 0     ← block 生效，工具体确实没跑 ✅
[3] 事件: execution_start(probe), execution_end(probe, isError=true)
[4] 回给模型的 toolResult:
    isError = true | toolName = probe
    content = [{"type":"text","text":"PLAN_BLOCKED: 规划期禁止副作用"}]
```

**四条关键结论**：

1. **扩展注册的工具（`pi.registerTool`）与内置工具走同一条 `tool_call` 钩子链**。这直接决定 M4 的 `submit_plan` 能被 Plan 策略拦截（规划期禁止重复提交）——地基成立。
2. **钩子顺序 = 注册顺序**，且 `loader()` 现有的 `plan → approval → mcp` 顺序正确（规划期先拦，避免先弹审批框）。
3. **首个 `{ block: true }` 之后钩子链短路**——`approval-hook` 不会被调用。这是 M5「子会话审批继承」必须注意的：如果 M4 的 Plan 策略先拦下，子会话的危险命令**根本不会走到审批**。
4. ⚠️ **阻断不产生独立事件**：`block` 表现为 `tool_execution_end(isError=true)` + reason 作为 toolResult 内容。SDK **不发出** `tool_execution_blocked`（全仓检索确认该事件仅存在于 `pi-python` 与前端 `agent-events.ts`，Node 后端从不产生）。

> **由此产生一条对 M1 的修正**：现有 `logSessionEvent()` 与未来的 ledger 会把「策略阻断」计入 `tool_execution_end isError=true`，从而**污染 `byTool.errorRate`**（把「被策略正确拦截」统计成「工具失败」）。M1 的 `steps` 表必须增加区分字段（如 `blocked_by TEXT` / 复用 `approval_decision`），否则 M4 的「审批误报率」指标会从第一天就是错的。
>
> 同时：前端 `agent-events.ts` 的 `case 'tool_execution_blocked'` 分支对 Node 后端是**死代码**，M4 改造时应清理或标注。

---

## 2. 存储选型：SQLite 是否必要？

### 2.1 先厘清：仓库里现在有三套完全不同的"持久化"

| 载体 | 归属 | 内容 | 新原则下可写？ |
| --- | --- | --- | --- |
| `~/.pi/agent/sessions/*.jsonl` | **原版 pi** | 会话消息树（header + entries） | ❌ 只能读 |
| `~/.pi/agent/{auth,models,models-store,settings}.json` | **原版 pi** | 凭据 / 模型 / 设置 | ❌ 只能读 |
| `~/.pi/agent/node-server-*.json` | 本项目 | workspaces / presets | ⚠️ 可写，但位置越界 |
| `~/.pi/agent-python/` | Python 后端 | models / workspaces | ✅ 已正确隔离 |

**关键前提**：会话 JSONL 是**原版 pi 的资产**。在新原则下它只能读，因此**它天然不可能成为 trace / task 的存储**——无论它本身设计得好不好。讨论「JSONL 够不够用」只在「我们自己新写 JSONL」这个意义上成立。

### 2.2 会话 JSONL 作为观测存储的具体问题

1. **归属问题**（决定性）：不是我们的文件，不能写。
2. **语义不匹配**：会话 JSONL 是对话日志，没有 run / step 概念，没有 TTFT、没有审批等待时长、没有工具错误分类。规划要的 `runs`/`steps` 字段在 JSONL 里根本不存在，只能靠解析消息正文反推。
3. **查询模型不匹配**：Dashboard 需要「时间窗 + 按工具/模型/审批分组 + p50/p95 + 分页 + 保留期清理」。JSONL 需要全量 parse → 内存排序 → 手工分组，**每次刷新都是 O(全量)**。
4. **增长无界**：每次工具调用至少 1 行。按 20 会话/天 × ~300 step 估算 ≈ 6000 行/天 ≈ **220 万行/年**。全量回放不可接受。
5. **隐私保留策略无法分离**：JSONL 存完整正文，而规划要求 trace 默认只存 digest。混在一起就无法对两者施加不同的保留期与脱敏策略。
6. **保留期清理是重写整文件**：`DELETE WHERE started_at < ?` 在 SQL 里是索引定位；在 JSONL 里是读全量 + 过滤 + 原子重写。

### 2.3 但 SQLite 不是唯一答案 —— 规划的理由有一半站不住

规划给出的两条 SQLite 理由：

| 规划理由 | 核查结论 |
| --- | --- |
| 「需要按时间聚合、p50/p95、按工具/模型分组——SQL 是正确工具」 | ✅ 成立，这是**真实**理由 |
| 「`DatabaseSync` 同步阻塞事件循环」（列为**高风险**） | ❌ **已被 M0 证伪**。批量 200 行 p95 = 0.65ms。真实等级：低 |

所以决策应当建立在**查询需求**上，而不是性能担忧上。

### 2.4 决策矩阵

| 数据 | 量级 | 写入频率 | 查询形态 | 结论 |
| --- | --- | --- | --- | --- |
| `runs` / `steps`（trace） | 百万级/年 | 高频、可批量 | 时间窗聚合 + 分位数 + 分组 + 分页 + 保留期清理 | **SQLite** |
| `tasks` / `task_steps` | 几十~几百条 | 低频、整条更新 | 按 id/status/session 取；乐观并发 | **JSON 够用**；但见下方"但如果" |
| workspaces / presets | < 100 条 | 极低频 | 全量读 | **保持 JSON 原子写**（现状不动） |

**"但 tasks 放哪"的真正决定因素**：规划要求 `runs.task_id` 关联任务（Dashboard 要按 task 聚合成本）。若 tasks 留在 JSON 而 traces 在 SQLite，每次「按任务看成本」都要跨存储 join。所以：

> **tasks 也放 SQLite（同一库不同表）**——不是因为 JSON 不行，而是因为**单一存储 + 可 join** 比"两种持久化机制"更简单、更少失效模式。

### 2.5 如果坚持完全避开 SQLite，可行吗？

**可行**，替代方案：**append-only JSONL 事件日志 + 启动载入内存 + 定时 JSON 快照**。

| | SQLite | 自建 JSONL |
| --- | --- | --- |
| 依赖 | 零（`node:sqlite` 内置） | 零 |
| 可手工检视 / diff | ❌ 需工具 | ✅ |
| 崩溃恢复 | ✅ WAL 事务 | ⚠️ 丢最后一批（可接受） |
| 时间窗聚合 + 分位数 | ✅ SQL | ❌ 自己实现索引与聚合 |
| 保留期清理 | ✅ 一条 DELETE | ❌ 全量读 + 重写 |
| 启动代价 | ✅ O(1) | ❌ 全量回放（220 万行 ≈ 数百 MB） |
| 适用条件 | 需原始 step 级查询 | **只保留预聚合 rollup**（日 / 模型 / 工具三张表），不保留逐条 step |

**结论**：JSONL 方案把 SQL 的活儿搬回了应用层。**它只在「你确定不需要原始 step 级查询、只要聚合指标」时成立。** 而 M4 的「计划一次通过率」、M5 的「子任务成本占比」、以及规划第 9.2 节罗列的全部量化指标，都需要 step 级下钻——所以我建议 **SQLite**。

### 2.6 最终建议

```
trace（runs/steps/预聚合表）  →  SQLite
tasks（tasks/task_steps）     →  同一 SQLite 库，不同表
workspaces / presets          →  保持 JSON 原子写（现状不动）
会话历史                       →  只读，永不写入
```

**库文件位置建议**：规划的 `~/.pi/agent/platform.db` 不会破坏 pi（pi 不认识这个文件），但会占用 pi 的命名空间。建议改到：

```
~/.pi/agent-node-server/platform.db
```

理由：本项目自有文件与 pi 自有文件分离，备份/清理/排错时边界清晰；与 Python 后端的 `~/.pi/agent-python/` 对称。

---

## 3. 共享态边界审计

### 3.1 原则（澄清后的版本）

Web 与 CLI **共享会话与配置**，扩展与 trace **各自独立**。因此原则不是「`~/.pi/agent` 严格只读」，而是：

> **共享态的增量写入允许，破坏性写入禁止。**

具体化为四条红线：

| 允许 | 禁止 |
| --- | --- |
| 新增会话文件、向会话追加条目 | **删除** pi 的文件（会话 JSONL） |
| 向 `models.json` 新增/修改 provider（字段保留式写入） | 写入时**剥离未知字段**（会静默丢掉 pi 的配置） |
| 读取凭据 / 设置 / 会话历史 | 写入 pi 无法解析的内容（schema 破坏） |
| 本项目自有文件（trace / tasks / mcp / presets） | 把明文密钥写入共享配置；让 trace 异常冒泡进 agent loop |

### 3.2 共享态清单（pi CLI 与本项目共用）

| 文件 | pi 侧行为 | 本项目行为 | 判定 |
| --- | --- | --- | --- |
| `auth.json` | 读 + 写（`proper-lockfile` 加锁） | 只读（`ModelRuntime`） | ✅ |
| `settings.json` | 读 + 写（`proper-lockfile` 加锁） | 只读（`SettingsManager`，`applyOverrides` 仅内存） | ✅ |
| `models.json` | **只读**（`model-runtime.js:59` 仅 `ModelConfig.load`） | 读 + 增量写 | ✅ 见 3.3 |
| `models-store.json` | 写（`FileModelsStore`） | 只读 | ✅ |
| `sessions/*.jsonl` | 读 + 追加（**无文件锁**） | 读 + 新增 + 追加 | ⚠️ 见 3.4 |
| `skills/` `prompts/` `agents/` `extensions/` | SDK 自动发现（共享） | 读；写入被限制在已登记工作区内 | ✅ |

### 3.3 `models.json` 写入：合规，且实现正确

核实 `services/model-config-service.ts`：

```ts
// 写方向：spread 保留未知字段（不是白名单）
const provider = { ...candidate };          // :89
// 读方向：白名单过滤，避免把明文密钥回给前端
if (ENV_REFERENCE.test(candidate.apiKey)) provider.apiKey = candidate.apiKey;   // :60
```

- **未知字段保留**：写方向用 `{ ...candidate }`，不会静默丢掉 pi 的扩展配置 ✅
- **读方向白名单**：只影响 API 响应，不影响磁盘文件 ✅
- **明文密钥拒绝**：`apiKey` 必须形如 `$ENV_VAR`，否则 422 ✅
- **原子写**：临时文件 + `rename` ✅
- **无锁冲突**：pi 对 `models.json` **只读不写**，CLI 下次启动/刷新时自然生效 ✅

> **结论：这一项无需整改。** 之前把它列为「硬违规」是错误判断——它恰好是共享态写入的正确做法，应作为后续所有共享态写入的**参考实现**（spread 保留 + 原子写 + 校验前置 + 净化只作用于读方向）。

### 3.4 会话 JSONL：唯一需要处理的风险点

`routes/sessions.ts:116-142` `reparentAndDelete()`：

```ts
for (const child of children) { /* 读 → 改 header.parentSession → 原子写回 */ }
await rm(target.path);          // 删除目标会话文件
```

| 维度 | 评估 |
| --- | --- |
| 语义 | ✅ 合理。web 与 CLI 共享会话，用户在 web 删除就应该真的删掉（否则两端列表不一致） |
| schema 安全 | ✅ `JSON.parse` → 改 `parentSession` → `JSON.stringify`，**其他 header 字段保留** |
| 并发安全 | ⚠️ **pi 对会话文件不加任何锁**（`session-manager.js` 无 `proper-lockfile`）。若 CLI 正在写同一会话，rename 与 append 会互相覆盖 |
| 失败原子性 | ⚠️ 循环里逐个改写子会话，**第 2 个子会话 header 损坏时第 1 个已被改写**，留下部分变更（只抛 409，不回滚） |

**建议（保留功能，加固两点）**：

1. **两阶段提交**：先解析并校验全部子会话 header，全部通过后再统一写盘 → 消除部分变更。
2. **删除改为可恢复**：`rm` → 移入 `~/.pi/agent-node-server/trash/`（或至少记录被删会话的 id/path），让误删可回溯。
3. 可选：与 CLI 的并发风险无法完全消除（pi 侧无锁），但在响应里明确提示「正在 CLI 中使用的会话不要删除」。

### 3.5 项目自有文件（pi 不认识，仅位置问题）

已确认 **pi CLI 不支持 MCP**（SDK dist 中无 `modelcontextprotocol` 引用），且 pi 认识的文件只有 `auth.json` / `settings.json` / `models.json` / `models-store.json` + `sessions/` `skills/` `prompts/` `agents/` `extensions/` `bin/`。

| 文件 | 写入位置 | 判定 |
| --- | --- | --- |
| `mcp.json` | `~/.pi/agent/` | ✅ 无冲突（纯本项目） |
| `node-server-presets.json` | `~/.pi/agent/` | ✅ 无冲突 |
| `node-server-workspaces.json` | `~/.pi/agent/` | ✅ 无冲突 |

三项功能上都不影响 CLI。仅从**命名空间卫生**角度建议迁至 `~/.pi/agent-node-server/`；若你认可「共享目录里放本项目文件」这个约定，保持现状也完全可行（无功能风险）。

### 3.6 审计结论

| 原判 | 修正 |
| --- | --- |
| V1 `models.json` 覆盖 = 硬违规 | ✅ **改判：合规且实现正确，可作范本** |
| V2 会话删除 = 硬违规 | ⚠️ **改判：语义合理，需加固原子性与可恢复性** |
| V3–V5 越界写入 = 违规 | ✅ **改判：无功能影响，仅命名空间卫生** |
| V6 新增会话 = 需复核 | ✅ **改判：符合"共享会话"设计意图** |

**不存在任何「必须先修才能进 M1」的阻塞项。** 原先的 M0.5 整改里程碑可以取消。

### 3.7 trace 与 CLI 的隔离性证明

trace 采集能做到**对 CLI 零影响**，而且是结构性的，不依赖于人工克制。完整数据流：

```
pi SDK 会话（进程内）
   → session.subscribe(cb)            agent-registry.ts:497
   → AgentRegistry.publish()          agent-registry.ts:799  ← 唯一插桩点
   → SessionLedger.record(entry,payload)   【M1 新增】
   → 内存写入队列（250ms / 200 条 batch）
   → ~/.pi/agent-node-server/platform.db
```

| 隔离维度 | 保证 |
| --- | --- |
| **写入面** | 全程**不写任何 pi 文件**。唯一的磁盘写入目标是本项目自己的 `platform.db` |
| **读取面** | 会话订阅是进程内事件回调，不是文件监听；不打开/不锁定/不解析 pi 的 JSONL |
| **失败面** | `record()` 必须 fire-and-forget + 异常降级为 warn。**绝不能冒泡到 agent loop**，否则 trace 故障会中断用户会话 |
| **性能面** | M0 实测批量 200 行 p95 = 0.65ms，在事件循环上的占用可忽略 |
| **可见性** | 不影响 CLI：平台不写入 `models.json` / `sessions/` / `settings.json`，pi 端看不到任何变化 |
| **开关** | `PI_NODE_STORE=memory` 可整体降级为内存实现；关闭 trace 后行为与改造前完全一致 |

**唯一的间接耦合点**是 `publish()` 在 SDK 事件热路径上。因此 M1 的验收必须包含一条硬指标：

> 1000 次 `record()` 的同步耗时 p95 < 5ms，且任何异常都被吞掉（写入 mock 故意抛错后 agent loop 仍能正常跑完）。

> **一句话回答**：trace **可以完全独立于 CLI**。它只读 SDK 的内存事件、只写自己的库文件。唯一需要纪律的是「不得拖慢或打断 agent loop」。

---

## 4. 扩展加载审计：Plan 与 Subagent 存在双重实现

### 4.1 实测：web 会话实际加载 4 个扩展

`DefaultResourceLoader` 在传入 `extensionFactories`（内联）的同时，**仍会自动发现** `~/.pi/agent/extensions/`。生产环境下每个 web 会话的实际加载结果（`spike/05-extension-conflict.mjs`）：

| 顺序 | 扩展 | 钩子 | 工具 | 命令 |
| --- | --- | --- | --- | --- |
| 1 | `~/.pi/agent/extensions/plan-mode/index.ts`（官方） | `tool_call` `context` `before_agent_start` `turn_end` `agent_end` `session_start` | — | `plan` `todos` |
| 2 | `~/.pi/agent/extensions/subagent/index.ts`（官方，**已被改造成可在 server 内运行**） | — | **`subagent`** | — |
| 3 | `<inline:1>` 项目 `PlanModeService` | `tool_call` `before_agent_start` `turn_end` `agent_end` `session_start` | — | — |
| 4 | `<inline:2>` 项目 `ToolApprovalBroker` | `tool_call` | — | — |

**关键**：文件扩展先于内联扩展注册 → 结合 M0-④ 的「首个 `{block:true}` 短路」语义，**官方 plan-mode 的 bash 拦截实际先于项目实现生效**，项目自己的 `isSafePlanCommand()` 对 bash 几乎从未执行。

### 4.2 官方 plan-mode 与项目 PlanModeService 的对照

| 维度 | 官方扩展 | 项目 `PlanModeService` |
| --- | --- | --- |
| 激活方式 | `--plan` CLI flag，或从会话 JSONL 的 `customType: "plan-mode"` 条目恢复 | `plan_enable` 命令（前端开关） |
| 默认值 | `planModeEnabled = false` | `planning = false` |
| 计划解析 | `Plan:` 标题 + 编号列表（`utils.ts`） | `Plan:` / `计划：` 标题 + 编号/无序列表（正则更宽） |
| 步骤完成 | `[DONE:n]` | `[DONE:n]` |
| 工具限制 | `getPlanModeTools(toolsBeforePlanMode)` 快照 | `restrictTools()` 快照 |
| bash 白名单 | `SAFE_PATTERNS`（含 `rg`/`fd`/`sed -n`/`awk`/`jq`/`curl`/`bat`） | `isSafePlanCommand()`（正则黑+白名单） |
| 无 UI 时 | `agent_end` 中 **`if (!ctx.hasUI) return`** → web 下不建 todos、不弹确认 | 无此限制，照常解析 |
| 清理陈旧上下文 | ✅ 有 `context` 钩子，过滤自己的 `plan-mode-context` | ❌ **无 `context` 钩子**，`web-plan-context` / `web-plan-execution-context` 永久累积在会话历史里 |

### 4.3 三个具体缺陷（可直接定位）

**D1 —— 共享会话导致的“隐形 plan mode”（最严重，但**前置条件是 `session_start` 能被触发**）**

CLI 里执行 `/plan` → 向共享会话 JSONL 写入 `customType: "plan-mode", enabled: true`。之后在 web 里打开同一会话：

```
官方扩展 session_start → planModeEnabled = true
                      → tool_call 开始拦截 bash（基于 SAFE_PATTERNS）
项目 PlanModeService   → 读的是 customType "web-plan-mode"，找不到 → 认为处于 normal
前端                   → 显示“普通模式”
```

> **重要修正（M0-⑥）**：上述路径的**前置条件**是 `session_start` 会被触发，而实测它**从未被触发**
> （SDK 里 `bindExtensions()` 只被三种 CLI mode 调用，而它是 `session_start` 的唯一发出点）。
> 因此修复前官方扩展实际是**休眠**的，D1 并未发生——但它同时也意味着**项目自己的 Plan 模式完全不可用**
> （`plan_enable` 永远 409）。两者是同一个根因的两面。
> 修复 `session_start` 会**激活** D1，所以两项修复必须同时上线。
> 完整分析与实施见 [`node-plan-extension-ownership.md`](./node-plan-extension-ownership.md)。

**D2 —— `[PLAN MODE ACTIVE]` 上下文重复注入且永不清理**

两个扩展都钩 `before_agent_start` 并各自注入一条 `[PLAN MODE ACTIVE]`。模型每轮收到**两份**规划期上下文。退出后，官方扩展的 `context` 钩子只清理自己的 `plan-mode-context`，**项目的 `web-plan-context` 因为项目没有 `context` 钩子而永久留在会话历史里**。反复切换会不断累积。

**D3 —— P6（验证类命令被拦）有**两个**独立成因**

官方 `SAFE_PATTERNS` 与项目 `isSafePlanCommand()` **都不包含** `tsc --noEmit` / `pnpm test` / `npm run build` / `node -e`。因此即使只保留其中一个实现，P6 依然存在——M4 的「能力分类」重构是必要的，不是重复劳动。

### 4.4 Subagent：M5 方案与现有实现的关系

`~/.pi/agent/extensions/subagent/index.ts`（36KB，**已被改造**）已提供：

| 维度 | 官方 subagent 扩展 | 规划中的 M5 |
| --- | --- | --- |
| 工具名 | **`subagent`** | `task` |
| 执行方式 | **spawn 独立 `pi` 子进程** | 进程内 `SessionManager.create({parentSession})` |
| 预设 | `scout`/`planner`/`reviewer`/`worker`（`~/.pi/agent/agents/*.md`） | `explore`/`verify`/`general` |
| 模式 | single / parallel（max 8，并发 4）/ chain | parallel fan-out |
| 审批继承 | ❌ **无**（子进程无 web 审批通道） | ✅ 共享同一 `ToolApprovalBroker` |
| Trace 集成 | ❌ 子进程事件不进父会话 SSE | ✅ `run.parent_run_id` |
| Web 适配 | ✅ 已适配（`getPiInvocation()` 专门处理“跑在 node-pi server 内”的情况） | — |

**判定**：M5 的进程内设计**值得保留**（审批继承 + trace 树是子进程方案做不到的），但**必须**：
1. 复用已有的 `~/.pi/agent/agents/*.md` 定义与命名（`scout`/`planner`/`reviewer`/`worker`），而不是另起 `explore`/`verify`/`general`；
2. 评估工具名用 `task` 还是沿用 `subagent`（后续有命名冲突风险）；
3. 决定两个实现是共存（按 preset 开关切换）还是替换。

### 4.5 M4 的前置决策（必须先进）

> **在写 M4 的任何代码之前，必须先定：web 用官方 `plan-mode` 扩展，还是用自己的内联 `PlanModeService`？**

| 选项 | 优点 | 代价 |
| --- | --- | --- |
| A. 完全用官方扩展 | 与 CLI 行为一致、零重复代码 | 官方实现只支持 `Plan:` + `[DONE:n]`，而且 `!ctx.hasUI` 使 web 下 `agent_end` 直接 return；需要改官方文件（侵入用户目录） |
| B. 完全用自己的内联实现 | 可控、可重构（即规划中的 M4） | **必须显式阻止官方扩展加载**，否则 D1/D2 继续存在 |
| C. 两者共存并同步状态 | — | ❌ 不推荐：状态机双写、钩子短路语义不可预测 |

**选项 B 的实现要点**（若选它）：`DefaultResourceLoader` 需要传 `extensionsOverride` 过滤掉 `~/.pi/agent/extensions/plan-mode`（`resource-loader.d.ts:84` 已有此选项），而不是依赖“官方默认关闭”。因为 D1 已经证明它会因共享会话而被间接打开。

> **把这项作为 M4 的第一个任务，而不是最后一个。** 否则 M4 的新契约会叠加在一个隐形冲突之上，回归测试无法解释失败原因。

---

## 5. 对里程碑规划的影响

| 影响 | 里程碑 | 动作 |
| --- | --- | --- |
| `node:sqlite` 风险降级，批量 flush 参数可放宽（250ms 仍是合理值） | M1 | 更新 `docs/node-platform-plan.md` 第 7 节风险表 |
| 需新增 `@earendil-works/pi-ai` 直接依赖（已加） | M1/M4/M5 | 已落地；`npm run spike` 已作为 CI 门禁防回归 |
| `steps` 表必须区分「策略阻断」与「工具失败」 | M1 | 新增 `blocked_by` 字段，否则 `byTool.errorRate` 从第一天就错 |
| `platform.db` 路径改为 `~/.pi/agent-node-server/` | M1 | 修正规划的 3.1 / 4.1.6 |
| 前端 `tool_execution_blocked` 为 Node 侧死代码 | M4 | 清理或标注 |
| 会话删除的两阶段提交 + 可恢复删除 | M2/M3 顺带 | 非阻塞项，见 3.4 |
| **M4 首任务改为「Plan 扩展归属决策 + 阻止双重加载」** | **M4** | 见 4.5；否则隐形 plan mode 会污染 M4 的回归测试 |
| 补充 `context` 钩子清理陈旧 plan 上下文 | M4 | 修 D2 |
| 复用 `~/.pi/agent/agents/*.md` 预设，不另起命名 | M5 | 见 4.4 |

---

## 6. 复现清单

```bash
cd node-pi/server
npm run spike        # 全部 6 个脚本，离线，临时目录
npm run typecheck && npm test && npm run build
```

| 脚本 | 验证内容 |
| --- | --- |
| `spike/00-resolve.mjs` | `@earendil-works/pi-ai` 可 ESM 解析，`fauxProvider` 可用 |
| `spike/01-sqlite-p95.mjs` | `node:sqlite` WAL 写入 p95 + 无索引聚合代价 |
| `spike/02-faux-agentloop.mjs` | faux → `registerNativeProvider` → 完整 agent loop（含工具） |
| `spike/03-parent-session.mjs` | `parentSession` 写入 header + `listAll` 回填 |
| `spike/04-tool-hook-order.mjs` | 钩子顺序 + 扩展工具是否走钩子链 |
| `spike/04b-block-semantics.mjs` | `{ block: true }` 的精确语义（工具体未执行 + reason 回传模型） |
| `spike/05-extension-conflict.mjs` | web 会话实际加载哪些扩展、钩子/工具冲突面 |
