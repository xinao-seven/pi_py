# M2 任务领域（TaskService 复活）实现说明

更新日期：2026-08-21
适用范围：`node-pi/server`（领域 + 存储 + REST + SSE）+ `web/`（任务面板）
前置阅读：[`node-platform-plan.md`](node-platform-plan.md) §4.2、[`node-observability-m1.md`](node-observability-m1.md)

---

## 1. 目标与边界

把「任务」变成一等公民：它既是 **Plan 的载体**（M4 把计划的步骤映射成任务的步骤），
也是 **断点续跑的控制面**（M3 的租约/心跳/在飞动作挂在 `execution` 上）。

| 交付 | 落地 |
| --- | --- |
| 领域模型 | `services/platform/task-model.ts`：`TaskRecord` / `TaskStep` / 状态常量 / 纯函数 |
| 持久化 | `services/platform/task-repository.ts`：SQLite（migrations v3）+ 内存双实现 |
| 用例与并发 | `services/task-service.ts`：状态聚合、`ifRevision` 乐观并发、变更广播 |
| 接口 | `routes/tasks.ts`：8 个接口 + 409/404/422 语义 |
| 实时推送 | SSE `task_updated`（`AgentRegistry.announceTask`）+ `web/src/components/TaskPanel.vue` |
| trace 关联 | `runs.task_id`（账本在 run 开始时从注册表取会话当前任务） |

**不在 M2**：真正的「执行/恢复」——`/resume`、`/recovery`、执行租约与心跳属于 **M3**；
`verification` 的**校验执行**（跑命令、查产物）属于 **M4** 的完成工具，M2 只存下来并回显。

---

## 2. 数据模型

```sql
tasks(id, title, goal, status, origin, session_id, cwd, revision,
      blocked_reason, conclusion, execution, created_at, updated_at)
task_steps(task_id, id, position, title, details, status, verification, evidence,
           blocked_reason, started_at, completed_at, PRIMARY KEY (task_id, id))
```

- `status ∈ {pending, in_progress, blocked, completed, cancelled}`（`TASK_STATUSES`）；
  `step.status ∈ {pending, in_progress, completed, blocked, skipped}`（`STEP_STATUSES`）。
- `origin ∈ {user, plan}`：区分手工任务与 Plan 产物（M4 用）。
- `revision`：乐观并发版本号，从 1 开始，每次成功写入 +1。
- `verification` / `evidence` / `execution` 以 JSON 文本存储（结构由 `task-model.ts` 定义）。
- 时间在模型里是 ISO 字符串（与规划 §4.2.1 一致），SQLite 里存 epoch 毫秒，
  **转换只发生在仓储的读写映射处**。
- 迁移 v3 建表；`TARGET_SCHEMA_VERSION = 3`。

**存储选型**：规划曾考虑 `tasks.json` 原子串行写，但 M1 先把 `platform.db` 落地了，
于是按规划结论「**直接进 SQLite，二者不并存**」处理：任务与 trace 同库不同表，
换来的是 `runs.task_id` 关联与单语句乐观锁。

---

## 3. 状态语义（唯一真相源＝步骤）

`deriveTaskStatus(steps)` 的优先级：

```
空步骤                      → pending
全部 completed / skipped     → completed
任一 blocked                 → blocked        （需要人介入，比 in_progress 更该被看到）
已有步骤被处理过（≠pending） → in_progress
其余（全是 pending）          → pending
```

两个刻意的取舍：

1. **「已开工」不能只看 `in_progress`**：模型通常是一步完成、下一步还没开始时才更新状态；
   若只认 `in_progress`，「2 步里做完 1 步」的任务会显示成「尚未开始」，与实际相反。
2. **只有 `cancelled` 冻结，`completed` 由步骤派生**：
   - `cancelled` 是显式的用户意图（`cancel()` 专属），步骤变更不能把它拉回来；
   - `completed` 是聚合结果，删掉未完成的步骤就可能回到 `pending`/`in_progress`
     ——这正是规划 §4.2.3 的 DoD「删除唯一未完成步骤后任务状态回落为 pending」。
   - 代价：手工 `PATCH status=completed` 之后若再改步骤，状态会被重新聚合。
     这是有意的：「状态只有一个真相源」，不存在「任务说完成、步骤还挂着」的隐藏状态。

任务层 `blockedReason` 在聚合为 `blocked` 而自身为空时，从第一个阻塞步骤复制过来，
避免面板显示「已阻塞但没有原因」。

---

## 4. 并发与错误语义

乐观并发用**单条语句**完成，不需要额外事务隔离级别：

```sql
UPDATE tasks SET ..., revision = revision + 1
WHERE id = :id AND revision = :expectedRevision
```

`changes === 0` → 版本过期 → `409 task_conflict`，响应带
`details: { expectedRevision, currentRevision }`，前端可据此提示「被其它窗口改过」。

| 场景 | 返回 |
| --- | --- |
| 缺少 / 非法 `ifRevision` | `422 validation_error` |
| 版本过期 | `409 task_conflict` |
| 任务不存在 | `404 task_not_found` |
| 步骤不存在 | `404 task_step_not_found` |
| 修改已取消的任务 | `409 task_cancelled` |
| 删除已完成步骤而未带 `force` | `409 step_completed` |
| 步骤置为 `blocked` 但没有原因 | `422 validation_error` |

`cancel()` 的细节：先校验版本再谈幂等——不带 `ifRevision` 的重复取消是幂等 no-op，
带了陈旧版本号则报 `409`，不会把「过期写入」悄悄变成 no-op。

**写入与 trace 的差异（重要）**：任务写入**不走写入队列**。trace 是可丢的观测，
任务是用户可见的控制面——写入必须立刻持久化、失败必须冒泡成 API 错误。
两者共用同一个 `DatabaseSync` 连接，单线程同步执行，不会交错。

---

## 5. REST 契约

| 接口 | 说明 |
| --- | --- |
| `GET /api/tasks?status&sessionId&cwd&limit` | 列表，按 `updatedAt` 倒序（limit 1–500，默认 100） |
| `POST /api/tasks` | `{ title, goal, origin?, sessionId?, cwd?, steps?[] }` |
| `GET /api/tasks/:taskId` | 详情 |
| `PATCH /api/tasks/:taskId` | `{ title?, goal?, status?, blockedReason?, conclusion?, ifRevision }` |
| `POST /api/tasks/:taskId/cancel` | `{ ifRevision?, reason? }`，幂等 |
| `POST /api/tasks/:taskId/steps` | `{ title, details?, verification?, position?, ifRevision }` |
| `PATCH /api/tasks/:taskId/steps/:stepId` | `{ title?, details?, status?, position?, evidence?, blockedReason?, ifRevision }` |
| `DELETE /api/tasks/:taskId/steps/:stepId?force=true` | `{ ifRevision, force? }` |

成功响应统一返回**整条任务**（`{ task }`／列表 `{ tasks }`），前端不需要自己合并增量；
步骤 id 形如 `s1`，**删除后不复用**（`nextStepId` 取现有最大值 +1）。

`GET /api/tasks/recovery` 与 `POST /api/tasks/:taskId/resume` **故意没有占位**：
半成品接口会让调用方以为功能已经存在（M3 实现）。`execution` 字段已随任务返回。

---

## 6. 实时推送（SSE `task_updated`）

本服务的 SSE 通道是**按会话**的，没有全局事件流，因此广播规则必须明确：

- 任务绑定了 `sessionId` → 只推给该会话；
- 没有绑定 → 推给所有 `cwd` 匹配（或任务未指定 `cwd`）的活跃会话；
- 未打开的会话不会收到推送，但它们重新打开时面板通过 REST 拉到最新状态。

前端：`useAgentSession` 用 `task` ref 单独维护任务（REST 首载 + SSE 增量），
`reduceAgentEvent` **刻意不处理** `task_updated`——任务变更不等于「Agent 在跑」，
不能污染流式状态机（有测试固化这一契约）。

---

## 7. 前端面板（`TaskPanel.vue`）

放在 `PlanProgress` 旁的同一条 strip（输入框上方）：

- 无任务：内联「新建任务」（标题 + 目标）；
- 有任务：状态徽标、完成计数、目标、阻塞原因、结论；
- 步骤行：状态、细节、阻塞原因、完成证据、验证声明 + 按状态给不同动作
  （待开始→开始/阻塞/删除；进行中→完成/阻塞/删除；已完成→重开/删除；阻塞→解除/删除）；
- 阻塞必须填原因（内联表单，不用 `window.prompt`）；删除已完成步骤需确认（对应服务端 `force`）；
- 终态（completed / cancelled）隐藏所有编辑入口；折叠态只留一行摘要；
- 写入串行化（`busy`），`409 task_conflict` 等错误显示在面板内。

---

## 8. 测试与验证

| 测试 | 覆盖 |
| --- | --- |
| `test/services/platform/task-repository.test.ts` | 双后端 CRUD、嵌套字段往返、乐观锁、步骤整批替换、过滤与排序、**等价性** |
| `test/services/task-service.test.ts` | 状态聚合与冻结规则、`ifRevision` 强制、409 细节、取消幂等、已完成步骤 force、重排、监听器失败降级 |
| `test/routes/tasks-routes.test.ts` | 8 个接口、并发冲突、步骤管理、取消冻结、参数校验/404、**task_updated 广播规则**、**run.task_id 关联** |
| `test/app.test.ts` | 客户端错误契约（非法 JSON → 400 `invalid_request`，不泄露请求体） |
| `web/test/components/TaskPanel.test.ts` | 新建、渲染证据/验证、各状态动作、阻塞原因校验、加步骤/刷新、删除确认、终态只读、错误与 busy、折叠 |
| `web/test/lib/api.test.ts` | 任务接口 URL/方法/`ifRevision`/409 解析 |
| `web/test/lib/agent-events.test.ts` | `task_updated` 不影响流式状态 |

真机验证（临时 agent 目录 + 临时库，未触碰真实数据）：

```
POST /api/tasks（含 verification）      → 200 rev1，步骤 s1/s2
POST /:id/steps                        → rev2，s1/s2/s3
PATCH /:id/steps/s1 status=completed   → 任务聚合为 in_progress，rev3
PATCH /:id（ifRevision=1）             → 409 task_conflict + currentRevision=3
POST /:id/cancel                       → status=cancelled，rev4
platform.db                            → user_version=3，tasks/task_steps 已落库
```

---

## 9. DoD 对照

| DoD | 结果 |
| --- | --- |
| 任务可增删改查 | ✅ 8 个接口 + 面板；步骤支持增删改与重排 |
| 重启后不丢 | ✅ SQLite（`platform.db`）持久化；真机验证重启后仍可查询 |
| 并发 `PATCH` 携带过期 `ifRevision` → 409 | ✅ 单语句乐观锁 + `task_conflict` + `currentRevision` |
| 删除唯一未完成步骤后任务状态回落为 `pending` | ✅ 删空步骤 → `pending`（测试同时固化「只剩已完成步骤 → completed」） |
| SSE 变更实时推送到前端任务面板 | ✅ `task_updated` 按会话/工作区广播 + 面板增量刷新 |
| 损坏数据降级、不影响 Agent 启动 | ✅ 任务读取与 Agent 主链路无关；单一任务记录字段异常由仓储按缺失处理 |

---

## 10. 已知限制与后续

| 项 | 说明 |
| --- | --- |
| `verification` 不校验 | 只存声明；M4 的完成工具会根据它跑命令/查产物，把「模型自报完成」变成可验证事实。 |
| `execution` 只有默认值 | `attempt: 1`；租约、心跳、在飞动作与恢复扫描属于 M3。 |
| 无 `/resume`、`/recovery` | 同上（M3），故意不占位。 |
| 任务与 run 的关联时机 | 只在 run **开始**时写入 `runs.task_id`；执行中绑定任务不会回溯已有的 run。 |
| 没有全局任务列表界面 | 面板只显示当前会话的任务；`GET /api/tasks` 已支持跨会话查询，UI 留给需要时再加。 |
| 步骤顺序重排 | 支持 `position`，但面板暂未提供拖拽（只能通过接口调整）。 |
