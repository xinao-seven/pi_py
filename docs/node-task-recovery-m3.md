# M3 断点续跑（Durable Execution）实现说明

更新日期：2026-08-21
适用范围：`node-pi/server`（租约 / 在飞动作 / 恢复清单 / 续跑）+ `web/`（中断提示与一键继续）
前置阅读：[`node-platform-plan.md`](node-platform-plan.md) §4.3、[`node-task-domain-m2.md`](node-task-domain-m2.md)

---

## 1. 目标与边界

进程崩溃或重启后，未完成的任务要能被**识别、解释并安全继续**——而不是靠人回忆「刚才跑到哪了」。

| 核心问题 | 机制 | 落地 |
| --- | --- | --- |
| 谁在跑？会不会双跑？ | 执行租约 | `services/task-lease.ts` + `TaskService` 的 acquire/renew/release |
| 崩溃时那个动作落地了吗？ | 在飞动作 + 副作用分级 | `services/task-recovery-extension.ts` + `task-recovery.ts` 的 `classifySideEffect` |
| 现在该怎么恢复？ | 恢复清单（只列不跑） | `TaskRecoveryService.scan()` + `GET /api/tasks/recovery` |
| 怎么安全地继续？ | 恢复上下文注入 + 续跑执行器 | `services/task-runner.ts` + `POST /api/tasks/:id/resume` |

**不在 M3**：`replan`（进入 Plan 重构路径）属于 **M4**，接口显式返回 `409 replan_unavailable`；
`verification.kind='command'` 的**执行**属于 **M4** 的完成工具（M3 只做只读的文件存在性校验）。

---

## 2. 三个机制

### 2.1 执行租约（`task-lease.ts`）

```ts
owner = `${pid}-${bootId}`   // bootId 每次进程启动生成一次
TTL = 30s，每 10s 续期一次（TTL 的 1/3，容忍单次续期失败或事件循环卡顿）
```

- 存储在任务的 `execution.lease = { owner, expiresAt }` 里，随任务一起持久化——
  不需要额外的锁表或进程表。
- `acquireLease` 被别的**活跃** owner 持有时返回 `409 task_leased`（任务只读）；
  过期租约自动可抢占。
- `owner` 含 bootId ⇒ **重启后旧租约必然过期**，因此不需要记录「上次是谁在跑」。
- 正常结束（`agent_settled`）释放；优雅关闭（`dispose()`）也释放；
  崩溃/强杀则留给 TTL 过期——这正是恢复清单的入口条件。

`isInterrupted(task, now) = status === 'in_progress' && !isLeaseActive(lease)`。
刻意只认「进行中且没人持有」：崩溃、强杀、优雅退出在库里长得一模一样。
`blocked` 的任务不进清单——它已经在面板上等人处理，不是「静默中断」。

### 2.2 在飞动作与副作用分级

内联扩展（`buildTaskRecoveryExtension`）监听四个钩子，写入 `execution.inFlight`：

| 钩子 | 写入 |
| --- | --- |
| `turn_start` | `{ kind:'turn', stepId, sideEffect:'none' }`（模型思考阶段没有副作用） |
| `tool_execution_start` | `{ kind:'tool', toolCallId, toolName, stepId, sideEffect }` |
| `tool_execution_end` | 清 `inFlight` |
| `agent_settled` | 清 `inFlight` + 通知执行器释放租约 |

副作用分级（`classifySideEffect`）：

| 工具 | 判定 | 理由 |
| --- | --- | --- |
| `read/grep/find/ls/glob/search/questionnaire` | `none` | 只读 |
| `edit/write/multi_edit/apply_patch/notebook_edit` | `write` | 写类工具 |
| `bash` 命中**审批规则** | `write` | 复用 `classifyBashCommand`（删除、重定向写、依赖变更…） |
| `bash` 未命中规则 | `unknown` | 普通命令也可能是写（`python -c "open(...)"`）——不能证明只读，也不该假设无害 |
| MCP / 未知工具 | `unknown` | 同上 |

> **比规划更保守的一处（刻意偏离）**：规划写的是「`tool_execution_end` 清除标记」。
> 但那一刻**步骤还没被标记完成**——「写完文件、还没打勾就被杀」如果只看 `inFlight`，
> 会被判成「两步之间，可自动继续」，续跑就会重复写。因此额外保留
> `execution.lastSideEffect`，并且只在它属于**当前步骤的本次尝试**
> （`at >= step.startedAt`）时才生效；步骤被 `retry_step` 重置后 `startedAt` 更新，
> 旧标记自然失效——不需要额外的清理代码。

### 2.3 恢复动作与恢复清单

| 情况 | action | 行为 |
| --- | --- | --- |
| 无未决副作用（含「两步之间」） | `auto_resume` | 可直接继续 |
| 写副作用 + 步骤声明了 `verification.kind='file'` | `verify_then_resume` | 先 stat 产物：在 → **补记为完成**（绝不重跑）；不在 → 见下 |
| 写副作用但无法验证 / `unknown` | `manual_only` | 必须人工确认（`confirmSideEffect: true`）才能继续 |

`GET /api/tasks/recovery` 返回的每条包含：任务与当前步骤、中断说明、`sideEffect`、
`action`、`requiresConfirmation`、租约视图、待验证产物（路径 + 是否存在）。

**只列不跑**：启动扫描（`onReady`）只把数量写进日志，不自动执行——模型可能在无人时做不可逆操作。

---

## 3. 续跑流程（`POST /api/tasks/:id/resume` → 202）

```
1. 校验（TaskRecoveryService.assertResumable）
     replan → 409 replan_unavailable（M4）
     终态 → 409 task_not_resumable          被别人持有 → 409 task_leased
     无会话 → 409 task_session_missing      无待推进步骤 → 409 task_not_resumable
     manual_only 且未确认 → 409 task_needs_confirmation
2. 取租约（attempt + 1）
3. 未决写副作用：验证产物
     通过        → 补记该步骤为完成（evidence 写明「恢复时验证产物已存在」），不重跑
     不通过 + continue  → 释放租约、把任务标 blocked（原因含「产物状态需人工确认」）→ 409 task_artifact_unverified
     不通过 + retry_step → 继续，但恢复摘要里注明「产物未找到，先核对工作区」
4. 打开会话（`registry.open(sessionId)`）
     失败 → 释放租约、任务标 blocked → 409 task_session_missing（不崩）
5. 注入恢复上下文：`tracker.setPendingResume()` → 扩展在 `before_agent_start` 以
   `display:false` 的自定义消息注入 `[TASK RESUME]`（模型可见、界面不显示、只注入一次），
   并用 `context` 钩子保证同类型消息只留最后一条
6. 发 prompt（`continue`: 继续当前步骤；`retry_step`: 先把当前步骤重置为 pending）
7. 保活：启动租约续期；`agent_settled` 时停续期 + 释放租约
```

`[TASK RESUME]` 摘要包含：任务标题与目标、第几次尝试、已完成步骤及证据、当前步骤、
后续步骤、中断说明、**副作用处理说明**，以及要求（先复述状态确认无冲突、
只推进当前步骤、如实汇报证据）。

恢复清单还会通过 SSE 在**会话首个连接**时补推一条 `task_recovery_required`
（走注册表 publish，有正确递增 id 且进入重放缓存；已有订阅者不重复推）。

---

## 4. REST 与 SSE 契约

| 接口 | 说明 |
| --- | --- |
| `GET /api/tasks/recovery` | 待恢复清单（只读） |
| `POST /api/tasks/:id/resume` | `{ mode: 'continue'|'retry_step'|'replan', confirmSideEffect?: boolean }` → **202** `{ ok, task, recovery, mode }` |

错误码与语义：

| 码 | 状态 | 含义 |
| --- | --- | --- |
| `task_leased` | 409 | 别的进程正在跑（响应带 owner/expiresAt） |
| `task_not_resumable` | 409 | 终态，或没有待推进的步骤 |
| `task_session_missing` | 409 | 任务未绑定会话，或会话文件已不存在（任务同时被标 blocked） |
| `task_needs_confirmation` | 409 | 未决副作用需要人工确认（带 sideEffect/step/artifact） |
| `task_artifact_unverified` | 409 | 写中断且声明的产物不存在（任务同时被标 blocked） |
| `replan_unavailable` | 409 | `replan` 由 M4 提供 |
| `recovery_unavailable` | 409 | 未装配恢复服务（旧调用方/测试注入场景） |

SSE 新增：`{ type: 'task_recovery_required', tasks: TaskRecoveryItem[] }`。
前端 `reduceAgentEvent` **刻意不处理**它（与 `task_updated` 一致）——
恢复清单由独立 ref 维护，不能污染「Agent 在不在跑」的判断。

---

## 5. 前端

- `TaskPanel` 新增「上次运行被中断」提示块：当前步骤、中断说明、待验证产物（存在/未找到），
  以及 [继续执行] / [重试当前步骤]；需要确认时明确写「需要你确认副作用风险后再继续」。
- 任务被 `blocked` 时也给出同一组入口（例如产物未验证导致的 blocked）。
- `ChatWindow` 的 `actTask` 现在会**对 409 task_conflict 自动刷新后重试一次**：
  执行器（续跑、在飞动作）也会写任务并升高 `revision`，用户点击时手里的版本可能刚落后，
  不这样做就会出现「我什么都没改却被拒绝」。
- 续跑遇 `409 task_needs_confirmation` → 用户确认后带 `confirmSideEffect: true` 重试；
  遇 `task_artifact_unverified` → 只提示，**不重放**写操作（服务端已把任务标 blocked）。

---

## 6. 测试与验证

| 测试 | 覆盖 |
| --- | --- |
| `test/services/task-recovery.test.ts` | 副作用分级（含 bash 走审批规则、未知工具 → unknown）、清单筛选与活跃租约、写副作用需确认、`lastSideEffect` 的失效规则、文件产物验证、`assertResumable` 各分支、`markInterrupted` |
| `test/services/task-recovery-extension.test.ts` | 四个钩子的 in-flight 行为、一次性隐藏注入、上下文去重、写失败不冒泡 |
| `test/services/task-runner.test.ts` | **重启后恢复**（真实 SQLite：关库 → 重开 → 扫描 → 续跑）、租约防双跑、产物缺失 → blocked 且 `retry_step` 是逃生门、产物存在 → 补记完成不重跑、`unknown` 需确认、会话缺失 → blocked、优雅关闭释放租约、`dispose` 后不再续期 |
| `test/routes/tasks-routes.test.ts` | recovery/resume 路由、202 语义、确认门、`replan_unavailable`、首个 SSE 连接补推且不重复 |
| `web/test/components/TaskPanel.test.ts` | 中断块渲染与两种 mode 的 emits、副作用确认与产物展示、阻塞任务入口、其它任务/会话的条目忽略 |
| `web/test/lib/api.test.ts` / `agent-events.test.ts` | recovery/resume 封装与 409 解析、`task_recovery_required` 不影响流式状态 |

**真机验证**（临时 agent 目录 + 临时库，未触碰真实数据；`kill -9` 强制终止，无优雅关闭）：

```
① 重启后启动日志：WARN tasks interrupted by a previous run are waiting for recovery {"count":1}
② GET /api/tasks/recovery → 1 条，sideEffect=write / action=manual_only / requiresConfirmation=true
   理由文案：「中断时正在执行写操作（edit），且没有可自动验证的产物声明；必须人工确认后才能继续。」
③ POST /resume（不带确认）→ 409 task_needs_confirmation（带 sideEffect/step 详情）
④ 声明了 file 产物的任务：产物存在 → requiresConfirmation=false；
   resume 时先把该步骤补记为 completed（evidence：「恢复时验证产物已存在：…」），
   随后因会话文件缺失 → 409 task_session_missing 且任务标 blocked（不崩）
```

> 真机环境没有可用模型凭据，因此「202 + 模型真的跑起来」这一段由 **fake session 的集成测试**
> 覆盖（`task-runner.test.ts`）——与规划 §4.3.3 要求的做法一致。

---

## 7. DoD 对照

| DoD | 结果 |
| --- | --- |
| 手工 kill 掉进程后重启，任务面板提示「1 个任务中断」 | ✅ 启动扫描 + 日志 WARN；`GET /api/tasks/recovery`；SSE 首个连接补推 `task_recovery_required`；面板显示「上次运行被中断」 |
| 可一键继续 | ✅ 面板 [继续执行] / [重试当前步骤]；`POST /resume` → 202；恢复上下文以隐藏消息注入 |
| 不产生重复副作用 | ✅ 写副作用在步骤完成前一直留标记（比规划更保守）；产物在 → 补记完成不重跑；产物不在 → 停下要人或显式 `retry_step`；`unknown` 一律要确认 |
| 租约未过期时第二个进程 acquire 失败 → 任务只读 | ✅ 409 `task_leased`（单测覆盖） |
| 产物校验失败 → blocked 且原因含中断说明 | ✅ 409 `task_artifact_unverified` + `blockedReason`（单测 + 真机） |
| 会话文件已被删除 → 409 `task_session_missing`，标记 blocked 而非崩溃 | ✅ 单测 + 真机验证 |
| 测试不触碰真实 `~/.pi` | ✅ 全部注入临时目录（含真机 smoke） |

---

## 8. 已知限制与后续

| 项 | 说明 |
| --- | --- |
| `verification.kind='command'` 不自动执行 | 等于绕过审批跑任意 shell；M4 的完成工具会把它接进工具调用与审批链路。M3 只做只读 stat。 |
| `replan` 未实现 | 返回 `409 replan_unavailable`，由 M4 的 Plan 重构接管。 |
| 续跑只驱动「当前步骤」 | 一次 resume 推进一步；多步连跑依赖模型在会话里继续（M4 的计划执行会做得更细）。 |
| 恢复清单是全局的 | 面板按会话过滤展示；跨会话视图留给需要时再加。 |
| 租约 TTL 不可配置 | 常量 30s/10s；需要时再加 `PI_NODE_*` 配置（目前没有必要）。 |
| 崩溃后最多 30s 才「过期」 | 判定依赖 TTL；启动时的扫描通常会晚于这个时间，因此不影响恢复体验。 |
