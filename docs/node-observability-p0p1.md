# 可观测性扩容 P0/P1：白捡事件 + 人机等待拆分 + 请求形状/注入审计

更新日期：2026-09-27
适用范围：`node-pi/server`（采集/存储/查询）+ `web/`（用量面板）
前置阅读：[`node-observability-m1.md`](node-observability-m1.md)、[`node-plan-cache-stability.md`](node-plan-cache-stability.md)

---

## 1. 为什么做这次扩容

M1 的可观测底座只接了 10 种 SDK 事件，`AgentRegistry.publish()` 收到的其余事件全部落进
`default: break` 被丢掉。同时有两个口径问题一直没有答案：

| 问题 | 今天的答案 |
| --- | --- |
| 一个 run 跑了 8 分钟，其中多少在等真人点确认？ | **不知道**：`durationMs` 把人机等待和机器耗时混在一起，p95 被污染 |
| `docs/node-plan-cache-stability.md` 定的「计划工具常驻、不增删」这条硬约束，有没有数据守着？ | **没有**：只有 `cacheReadTokens` 一个总数在侧面印证，无法归因是工具集变了还是系统提示词变了 |
| 自动重试到底救回来了没有？ | **不知道**：只记了 `run.meta.retries` 次数 |
| plan 状态注入、`[TASK RESUME]` 注入占了 prompt 多少位置？ | **完全黑盒**（它们是 `display: false` 的隐藏消息） |
| 用户提问（`ask_user`）等了多久？ | **没入账**（只有审批有） |

P0 收「事件已经送到 `publish()`、只是没接」的信号 + 把人机等待拆出来；
P1 收「必须新增钩子才能拿到」的请求形状与注入审计。两批都不改 agent loop、不新增 SSE 事件类型。

---

## 2. 新增的观测项

### 2.1 P0：零采集成本（事件早就在手里）

| SDK 事件 | 记账行为 | 落点 |
| --- | --- | --- |
| `turn_end` | 本轮 `toolResults.length` 累加 | `run.meta.toolResults` |
| `message_start` | user / assistant 各自计数 | `run.meta.userMessages` / `assistantMessages` |
| `tool_execution_update` | 首次进度输出耗时 + 次数 | `tool_call.meta.firstOutputMs` / `progressUpdates` |
| `auto_retry_end` | 成功/失败计数 | `run.meta.retriesSucceeded` / `retriesFailed` |
| `summarization_retry_scheduled`（及 `_attempt_start` / `_finished`） | 计数 | `run.meta.summaryRetries` |
| `queue_update` | steer / followUp 队列最大深度 | `run.meta.maxSteerQueue` / `maxFollowUpQueue` |
| `entry_appended` | run 期间追加的会话条目数 | `run.meta.entries` |
| `thinking_level_changed` | 一条 `config_change` 步骤 | `steps.kind='config_change'` |
| `agent_end` | 一次 run 里跑了几次 agent loop | `run.meta.agentEnds` |
| 审批结算 | 等待时长累加进 run | `runs.wait_ms` |
| 提问挂起/结算（`QuestionBroker` → 账本） | 一条 `question` 步骤 + 等待时长累加 | `steps.kind='question'`、`runs.wait_ms` |

`model_select`（run 中途换模型）走和 `thinking_level_changed` 同一条 `config_change` 路径，
但它只在扩展钩子里可见，所以归到 P1 的钩子里注册（见 2.2）。

**刻意跳过的两个事件**（在 §6 说明原因）：`session_info_changed`（只是重命名）、
`bash_execution_update`（交互式 bash 的逐块输出，与 `tool_execution_update` 重复）。

### 2.2 P1：新增钩子

`services/observability/observability-extension.ts` 原来只挂 2 个钩子，现在挂 5 个：

| 钩子 | 记账行为 |
| --- | --- |
| `before_provider_headers`（原有） | provider HTTP 请求发出时刻 |
| `after_provider_response`（原有） | HTTP status + 首字节耗时 |
| **`before_provider_request`** | 请求形状 → 本次 `llm_call.meta`：`promptMessages` / `promptTools` / `promptToolNames` / `promptSystemChars` / `toolsChanged` / `systemChanged`；变化次数记 `run.meta.promptShapeChanges` |
| **`context`** | 识别持续存在的注入消息（`customType`）→ 一条 `context_injection` 步骤（`chars` + 正文指纹） |
| **`model_select`** | 一条 `config_change` 步骤（`field: 'model'`，带 `from` / `to` / `source`） |

「形状」的提取是纯函数（`services/observability/prompt-shape.ts`），只取**长度与 sha256 前 12 位**：

- 消息条数**不参与**「变化」判定（每轮都会涨，参与进去等于每轮都报变化）；
- 工具集指纹 = 工具名排序后 join（顺序无关，增删才变）；
- 系统提示词指纹 = 脱敏后 sha256 前 12 位。

注入识别**从消息数组尾部往前扫**，同 `customType` 取最后一条——这与 SDK 侧
（`plan-mode-service` / `task-recovery-extension`）「只留最后一条注入」的策略一致，
输出按生效位置排序；正文先脱敏再取指纹，**正文本身不落库**。

---

## 3. 人机等待拆分（口径修正）

```
duration_ms   总时长（含等人）
wait_ms       等真人：审批等待 + 提问等待（只有这两处是真人阻塞点）
active_ms     max(0, duration_ms - wait_ms)：机器真正干活的时长
```

- `runs.duration_ms` 语义**不变**（仍是总时长），新增两列而不是改写旧列（历史 run 保持 NULL）。
- 面板的 p95 仍看总时长，新增「机器耗时 p95」与「等人 p50 / 累计」，两者差得越大越说明瓶颈在人在回路。
- `wait_ms` 同时进 `run_rollups`，因此**明细被 prune 之后「累计人工等待」仍然完整**
  （与其它累计指标同源）。
- `durationSamples` / `activeSamples` / `waitSamples` 三个分位数样本口径一致：
  只有**有值的 run** 才进样本，所以老数据的 `activeSamples` 为空、`p95ActiveDurationMs` 为 0。

---

## 4. 数据模型与契约变更（全部是追加）

**迁移 v4**（`platform/migrations.ts`，`TARGET_SCHEMA_VERSION = 4`）：

```sql
ALTER TABLE runs ADD COLUMN wait_ms INTEGER;
ALTER TABLE runs ADD COLUMN active_ms INTEGER;
ALTER TABLE run_rollups ADD COLUMN wait_ms INTEGER NOT NULL DEFAULT 0;
```

已发布的 DDL 一律不改写，只追加新版本（M1 定的规矩）。

**REST 追加字段**（`GET /api/observability/summary` → `totals`）：

| 字段 | 含义 |
| --- | --- |
| `p95ActiveDurationMs` | 机器耗时 p95（样本为空时为 0） |
| `p50WaitMs` | 等人 p50 |
| `humanWaitMs` | 累计等人时长（预聚合来源） |

**run 载荷追加**：`waitMs` / `activeMs`（老记录为 `null`）。
**步骤类型追加**：`question` / `context_injection` / `config_change`。
**步骤 meta 追加**：`firstOutputMs` / `progressUpdates`（工具）、`customType` / `chars` / `digest`（注入）、
`field` / `from` / `to` / `source`（配置变更）、`cacheHitRate` / `prompt*` / `toolsChanged` / `systemChanged`（LLM）。
**run meta 追加**：§2.1 的计数器（为 0 的键不写，避免 meta 里堆零）。

前端同步点：`web/src/types/index.ts`（`ObservabilitySummary.totals` / `ObservabilityRun` /
`ObservabilityStep.kind`）、`web/src/components/ObservabilityPanel.vue`。

### 4.1 前端可见性对照（“记了”是否等于“看得到”）

第一版只把 3 个 KPI 与新增的步骤类型搬上了面板，大量字段「入了库但界面上看不到」
（只能直接调 REST）。现已补齐前四项：

| 数据 | 面板位置 | 状态 |
| --- | --- | --- |
| `p95ActiveDurationMs` / `p50WaitMs` / `humanWaitMs` | KPI「机器耗时 p95」+ 提示行 | ✅ |
| `question` / `context_injection` / `config_change` 步骤 | 详情步骤表的 kind 列 | ✅ |
| **`llm_call` 请求形状**（`promptMessages` / `promptTools` / `toolsChanged` / `systemChanged` / `cacheHitRate`） | 步骤表新增的「详情」列；工具名清单放进 `title` 悬浮提示 | ✅ |
| **`runs.meta` 计数器**（重试成败 / steer 峰值 / 注入次数 / 会话条目 / `promptShapeChanges`，以及 M5 的 `preset` / `depth`） | 详情头部的 chips（只为有值的键渲染） | ✅ |
| 每条 run 的 `waitMs` / `activeMs` | 列表行「+等人 x」+ 详情头部「总 / 机器 / 等人」拆分 | ✅ |
| `tool_call.meta.firstOutputMs` / `progressUpdates` | 步骤表「详情」列 | ✅ |
| `context_injection.meta.chars` / `digest`、`config_change.meta.from` / `source`、`question.meta.questions` / `answers` | — | ❌ 仍仅 REST 可查 |
| 提问等待的**独立聚合**（按类型分开的等待分位数） | — | ❌ 需新增 `question_rollups` 表 + REST 字段（后端改动） |

窄屏（≤760px，与仓库既有断点一致）下：运行行与步骤表改为**横向滚动**而不是压扁列宽
（规则一，见 [`web-mobile-adaptation.md`](web-mobile-adaptation.md)）——等人列在窄屏下被压掉就等于没采。

**教训（写下来避免重犯）**：P1 花力气采回来的数据如果界面上看不到，就等于只有我自己能用。
新增观测字段时，除了「入库 + 类型同步」，还要明确一句：**它显示在哪里**。

---

## 5. 新增的可观测钩子接口

- `RuntimeObserver`（原名 `ProviderObserver`，语义已扩到「运行期观测」，保留别名不破坏外部引用）：
  新增 `noteProviderPayload` / `noteContextMessages` / `noteModelSelect`。由 `SessionLedger` 实现。
- `QuestionTraceSink`（`services/agent/user-question.ts`）：`noteQuestionStart` / `noteQuestionDecision`，
  与 `ApprovalTraceSink` 同形——接口留在提问中枢自己的文件里，账本按结构实现，不引入反向依赖；
  调用方用 `notify()` 包住，**观测抛错不影响提问链路**（有测试守门）。
- `agent-registry.ts` 里把提问中枢也接上账本：`questions?.setTraceSink(ledger)`。

仍然只有两处埋点：`SessionLedger.record()`（事件流）与 `observability-extension.ts`（钩子）。
所有新入口都经 `guard()`，异常只记 warn。

---

## 6. 已知限制与取舍

| 项 | 说明 |
| --- | --- |
| `toolsChanged` 是**run 内相对上一次请求**判定 | 跨 run（第二个 prompt 起）没有可比对象，第一次调用一律 `false`。工具名集合本身每轮都记在 `llm_call.meta.promptToolNames` 里，跨 run 比较可以离线做 |
| 注入审计的扫描是 O(消息数) | 每次调用读一遍 `customType`（属性读，不做字符串处理），长会话下总量可观但单次极廉价；注入正文只在命中时脱敏 + 取指纹 |
| 注入正文不落库 | 只记字符数与指纹，因此「注入内容变了」可查、「变了什么」不可查（与默认不落正文的口径一致） |
| `session_info_changed` / `bash_execution_update` 未入账 | 前者只是重命名，后者与 `tool_execution_update` 的语义重复；要接随时可加 |
| 历史 run 没有 wait/active | 迁移不回溯，老记录两列为 NULL、不进样本 |
| 面板仍不实时 | 与 M1 一致：REST + 手动刷新，不新增 SSE 事件类型 |
| `config_change` 只在 run 进行中记 | 两次 prompt 之间切模型没有活动 run，凭空造 run 会污染运行次数；这种切换在下一轮 run 的 `provider/model` 上体现 |

---

## 7. 测试与验证

| 测试 | 覆盖 |
| --- | --- |
| `test/services/observability/prompt-shape.test.ts`（新） | 形状提取（含 OpenAI `function` 包装、去重、无 system）、`undefined` 输入不抛错、指纹稳定性、注入取最后一条 / 去抖 / 脱敏先于摘要 / limit / 垃圾输入 |
| `test/services/observability/observability-extension.test.ts`（新） | 5 个钩子全部注册、转发参数正确、`model_select` 归一化、拿不到 sessionId 时跳过且不抛错 |
| `test/services/observability/session-ledger.test.ts` | 人机等待拆分（提问 / 审批）、P0 计数器落 meta 且 0 不写、中途换模型/思考级别、run 外事件被忽略、工具首字节耗时、请求形状与 `cacheHitRate`、工具集变化标记、注入去抖、垃圾输入不抛错 |
| `test/services/platform/trace-store.test.ts` | 两个后端 `waitMs`/`activeMs` 往返、三个分位数样本与 `humanWaitMs` 聚合、v4 迁移幂等 |
| `test/services/agent/user-question.test.ts` | 提问挂起/结算上报、超时原因、sink 抛错不影响提问 |
| `test/services/observability/metrics.test.ts` | 新 totals 字段整形 |
| `test/services/observability/ledger-e2e.test.ts` | 真实 SDK + `fauxProvider`：run 状态/turns/tokens、`waitMs=0` / `activeMs=durationMs`（注：faux 不经过 provider 的 `onPayload`，请求形状由 `spike/09` 守门） |
| `web/test/components/ObservabilityPanel.test.ts` | 新 KPI 渲染、非工具步骤的标签来自 meta、请求形状/工具首字节的「详情」列、run.meta chips（只为有值的键渲染）、等人 vs 机器耗时拆分、老记录缺 waitMs 时的占位 |
| `spike/09-observability-hooks.mjs`（新，15 项断言） | provider 层仍调 `onPayload`、扩展钩子接线、真实载荷形状提取、SQLite 落库与聚合 |

验证命令（全绿）：

```powershell
cd node-pi/server && npm run format:check && npm run typecheck && npm test && npm run build && npm run spike
cd web && npm run typecheck && npm run lint && npm test && npm run build
```

Node 后端测试从 **399 → 427**，Web 从 **149 → 150**。

### 7.1 为什么还需要一个 spike

P1 的请求形状依赖 `before_provider_request`，而它只在**真实 provider 的 `onPayload` 钩子**里被触发；
`fauxProvider` 直接产出响应、不经过 payload 组装（也不发 `model_select`），所以 e2e 证明不了它。
`spike/09-observability-hooks.mjs`（已进 `npm run spike` 门禁）补这一段：

1. **静态校验**：`@earendil-works/pi-ai` 的 10 个 provider 实现仍调用 `onPayload`、`streamSimple`
   仍透传该选项、coding-agent 仍派发 `before_provider_request` —— SDK 升级把这行删掉时 CI 立刻报错，
   而不是悄悄少一份数据；
2. 用真实的 anthropic / openai 载荷形状验证 `promptShapeOf`；
3. 用**真 SQLite 库**验证 `wait_ms` / `active_ms` / `question` 步骤 / 请求形状 / `cacheHitRate`
   确实落库、可聚合读出。

> 副作用发现（已记录）：`openPlatformStore` 的批量写失败会**丢掉整批**。spike 早期把 `model` 误写成
> 对象（`LedgerSessionContext.model` 是字符串）时，整批 4 条 op 一起被丢。这是队列的既有取舍
> （见 `node-observability-m1.md` §6），但它提醒：**喂给账本的字段类型要真的对**，错一个可能不是少一条
> 而是少一批。

---

## 8. DoD 对照

| DoD | 结果 |
| --- | --- |
| 「这次 run 有多少时间在等人」可查 | ✅ `runs.wait_ms` / `active_ms` + summary 的 `p50WaitMs` / `humanWaitMs` / `p95ActiveDurationMs`，面板有 KPI |
| 「等用户回答」与审批**同口径**入账 | ✅ `steps.kind='question'`（等待时长、结算原因、答案条目数），与审批一样计入 `wait_ms` |
| 「缓存前缀是不是被打穿」可归因 | ✅ 每次 `llm_call` 记工具集/系统提示词指纹 + `toolsChanged`/`systemChanged`/`cacheHitRate`，run 级 `promptShapeChanges` |
| 「模型看到的东西是谁塞进来的」可审计 | ✅ `context_injection` 步骤（`customType` + `chars` + 指纹，去抖） |
| 「重试救回来了吗」可查 | ✅ `retriesSucceeded` / `retriesFailed`，另有 `summaryRetries` |
| 不改主链路、异常不冒泡 | ✅ 仍只有 2 个埋点，全部经 `guard()`，钩子侧 `notify()` 兜底；有专门用例喂垃圾输入断言不抛错、不产生告警噪声 |
| 面板不新增 SSE 事件类型 | ✅ 只用 REST，前端只加字段与 KPI |
