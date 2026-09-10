# 项目进度（PROGRESS）

> **新会话请先读本文件**，再读 `CLAUDE.md`（行为准则）与 `docs/node-platform-plan.md`（完整规划）。
> 本文件只记录"现在在哪、下一步做什么、哪些决策已经冻结"，不重复规划内容。

|            |                                                                 |
| ---------- | --------------------------------------------------------------- |
| 当前里程碑 | **M4（含 4.1 提问通道）已完成** → 下一步 **M5 Subagent**           |
| 上一提交   | `e47ed1f fix: 长会话读取不再爆栈——分支树改为扁平节点 + depth`      |
| 运行时     | Node **v24.18.0**（`node:sqlite` 可用）                          |
| 测试基线   | Node 后端 **373** / Web **128**，全绿；spike 30 项断言 + eval 11 个用例全过 |
| 工作分支   | `master`                                                        |

---

## 1. 协作约定（用户明确要求，必须遵守）

1. **每完成或修复一个问题，就立即 git 提交**，按 Conventional Commits 写中文描述，一个提交只做一件事，代码与文档分开提交。
2. **每个改动都要在 `docs/` 下写一份说明文档**，讲清"如何实现的"，并在 `README.md` / `CLAUDE.md` 的文档索引里登记。
3. **不得影响 CLI 上运行的原版 pi**。边界见第 4 节，是硬约束。
4. 提交时**不要**带上 `interview-qa.md` 与 `pi_design.md`（用户自己的改动，与本项目工作无关）。
5. 在本机（Windows）跑 Python 小工具时用 `python`（不是 `python3`）并设 `PYTHONIOENCODING=utf-8`：
   否则带中文的 `print` 会因控制台编码失败而**静默中断脚本**（M4 期间被这个坑过两次）。

---

## 2. 里程碑状态

| 里程碑                  | 状态        | 说明                                  |
| ----------------------- | ----------- | ------------------------------------- |
| **M0** 验证性 spike     | ✅ **完成** | 4 项验证 + 2 个阻塞性修复 + CI        |
| **M0.5** 持久化边界整改 | ✅ **取消** | 重新审计后无阻塞项，详见 3.2          |
| **M1** 可观测底座       | ✅ **完成** | SessionLedger + 存储 + 4 个 REST + 用量面板，详见 3.6 |
| **M2** 任务领域         | ✅ **完成** | 领域 + 存储 + 8 个 REST + SSE + 任务面板，详见 3.7 |
| **M3** 断点续跑         | ✅ **完成** | 租约 + 在飞动作 + 恢复清单 + 一键续跑，详见 3.8 |
| **M4** Plan 重构        | ✅ **完成** | 工具驱动计划 + 任务视图 + 能力集权限 + 评测，详见 3.9 |
| **M5** Subagent         | ✅ **完成** | 内联子会话 + 预算 + 审批继承 + trace 树 + 委派卡片，详见 3.12 |

---

## 3. 已完成的工作

### 3.1 M0 四项验证结论（`docs/node-platform-m0-spike.md`）

| #   | 结论                                                                  | 对规划的影响                                                   |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| ①   | `node:sqlite` 批量 200 行 p95 = **0.65ms**                            | 规划中「同步写入阻塞事件循环」的**高风险评级被证伪**，降级为低 |
| ②   | `fauxProvider` 可离线驱动完整 agent loop（含工具调用）                | M4 评测 / M5 测试的驱动层成立                                  |
| ③   | `parentSession` 写入 JSONL header，`listAll` 正确回填                 | M5 子会话无需额外实现即可被前端树识别                          |
| ④   | 扩展工具同走 `tool_call` 钩子链；首个 `{block:true}` **短路后续钩子** | M4 权限模型地基成立                                            |

> **⚠️ 修正 ①②：真正的风险不是写入，而是无索引全表聚合（20 万行 GROUP BY = 96ms）。
> M1 必须走预聚合表，不能在请求里跑全表扫描。**
>
> **⚠️ 修正 ④：`{block:true}` 的表现是 `tool_execution_end(isError=true)` + reason 文本，
> SDK 不发 `tool_execution_blocked`。因此 M1 的 `steps` 表必须加 `blocked_by` 字段，
> 否则「被策略正确拦截」会被统计成「工具失败」，`byTool.errorRate` 从第一天就是错的。**

### 3.2 共享态边界重新审计（推翻了我最初的判断）

用户澄清：Web 与 CLI **共享会话与配置**，扩展与 trace 各自独立；原则不是"严格只读"，而是：

> **共享态的增量写入允许，破坏性写入禁止。**

| 文件                              | pi 侧行为                         | 本项目行为       | 判定              |
| --------------------------------- | --------------------------------- | ---------------- | ----------------- |
| `auth.json` / `settings.json`     | 读 + 写（`proper-lockfile` 加锁） | 只读             | ✅                |
| `models.json`                     | **只读**                          | 读 + 增量写      | ✅ **是实现范本** |
| `models-store.json`               | 写（`FileModelsStore`）           | 只读             | ✅                |
| `sessions/*.jsonl`                | 读 + 追加（**无文件锁**）         | 读 + 新增 + 追加 | ⚠️ 见下           |
| `mcp.json` / `node-server-*.json` | **pi 不认识**                     | 读写             | ✅ 无冲突         |

- `models.json` 写入**合规且正确**：`validate()` 用 `{ ...candidate }` spread **保留未知字段**，
  `sanitize()` 白名单**只作用于读方向**（防密钥外泄），原子写，而 pi 侧对它只读不写 → 无锁冲突。
  **后续所有共享态写入都以它为参考实现。**
- 唯一需加固的是 **会话删除**（`routes/sessions.ts:116` `reparentAndDelete`）：
  循环里逐个改写子会话 header，中途失败会留部分变更；`rm` 不可恢复。
  **非阻塞项**，建议 M2/M3 顺带做「两阶段提交 + 移入 trash」。

### 3.3 Plan 扩展归属与 `session_start` 修复（`docs/node-plan-extension-ownership.md`）

**用户已拍板方案 B：内联实现接管 `plan-mode`。**

挖出的真实根因（比"双状态机冲突"更严重）：

> **`session_start` 扩展事件在 Node 后端从未被触发。**
> SDK 里 `bindExtensions()` 只被 `interactive/print/rpc` 三种 CLI mode 调用，
> 而它是 `session_start` 的唯一发出点；Node 后端直接走 `createAgentSession()`。
> 后果：`PlanModeService` 状态机从不登记 → **`plan_enable/disable/execute/refine` 全部 409
> `plan_unavailable`，Plan 模式在生产环境完全不可用**。这是 P1–P8 的共同上游根因。

已实施三个修复：

| #   | 修复                                                                                      | 位置                   |
| --- | ----------------------------------------------------------------------------------------- | ---------------------- |
| A   | `register()` 派发 `session_start`（先 `entries.set` 再派发；异常只记 warn，不阻断建会话） | `agent-registry.ts`    |
| B   | `extensionsOverride` 按目录名抑制被内联实现接管的扩展（`INLINE_OWNED_EXTENSION_DIRS`）    | `agent-registry.ts`    |
| C   | 新增 `context` 钩子：按模式清理 plan 注入，**同类型只留最后一条**                         | `plan-mode-service.ts` |

> **⚠️ 排序约束（不可遗忘）：A 和 B 必须同时上线。**
> 官方 `plan-mode` 扩展的两条激活路径都依赖 `session_start`，所以修复前它是**休眠**的；
> 单独修 A 会把双状态机激活，引入「共享会话导致的隐形规划期」（CLI 敲过 `/plan` 的会话
> 在 Web 侧静默进入规划期）。

**修复 B 的边界**：`extensionsOverride` 只影响**本服务的资源加载**，不修改、不删除磁盘文件，
CLI 仍照常加载官方扩展。过滤函数 `dropInlineOwnedExtensions` 已导出，spike 里用的是**构建产物的真实实现**。

### 3.4 CI（`.github/workflows/ci.yml`）

```
node-backend: npm ci → format:check → typecheck → test → build → spike
web:          npm ci → typecheck → lint → test → build
eval:         npm ci → npm run eval --if-present   (needs: node-backend)
```

- `spike` 是**离线确定性能力的回归门禁**，不是探索脚本：守住 `fauxProvider` 可解析性、
  `node:sqlite` 可用性、父子会话识别、`tool_call` 钩子链与阻断语义。M4/M5 的评测建立在其上。
- `eval` 用 `--if-present` 让 job 现在为 no-op；**M4 加入 `npm run eval` 后自动生效，不用改 CI**。
- 尚未在 GitHub 上跑过一次（本地验证通过）。`npm ci` 在 Windows 上偶发文件占用失败，Ubuntu 不受影响。

### 3.5 存储选型（M0 冻结，M1 已按此落地，见 3.6）

```
trace（runs / steps / 预聚合表）  →  SQLite
tasks（tasks / task_steps）       →  同一 SQLite 库，不同表
workspaces / presets              →  保持 JSON 原子写（现状不动，<100 条、极低频）
会话历史（sessions/*.jsonl）       →  pi 的资产，只读
```

库文件位置：**`~/.pi/agent-node-server/platform.db`**（`PRAGMA journal_mode=WAL`）。
规划的 `~/.pi/agent/platform.db` 不破坏 pi，但会占用其命名空间，建议改掉。

**如果坚持避开 SQLite**：`append-only JSONL + 内存 + 定时快照` 可行，但**只在只保留预聚合
rollup、不保留原始 step 时成立**；M4/M5 的量化指标都要 step 级下钻，所以选 SQLite。

---

### 3.6 M1 可观测底座（已完成，`docs/node-observability-m1.md`）

#### 交付物

| 层 | 内容 |
| --- | --- |
| 存储 | `services/platform/`：`migrations` / `trace-model` / `trace-repository`（写入队列）/ `sqlite-trace-storage` / `memory-trace-storage` / `store` |
| 采集 | `services/observability/`：`session-ledger`（事件 → runs/steps）/ `redact` / `metrics` / `observability-extension`（provider HTTP 观测） |
| 接口 | `routes/observability.ts`：summary / runs / runs/:id / DELETE runs |
| 前端 | `web/src/components/ObservabilityPanel.vue`（设置 → 用量）+ types + api |
| 插桩 | `AgentRegistry.publish()` 尾部一行；审批/Plan 各自上报拦截；prompt() 失败也记 error run |

#### 已冻结的新决策（都是实施中发现的，比规划更具体）

1. **run 的边界取 `agent_settled`**：SDK 的 `_runAgentPrompt()` 在自动重试/压缩/续跑时会多次发
   `agent_start`，只有 `agent_settled` 在所有自动行为收敛后发一次。取错边界会把一次请求拆成多个 run。
2. **聚合表用 `run_rollups(day, cwd, provider, model)`**，取代规划里的 `day_rollups`：
   原设计下 `totals` 只能从 `runs` 明细算，一旦 `prune` 清理明细，`totals` 与 `byTool` 口径立刻矛盾
   （已被测试暴露）。改后 `totals`/`byModel`/`daily` 同源，**清理明细后聚合历史完整保留**。
3. **聚合的时间分辨率是「天 + cwd」**，未结算的 running run 不计入聚合；分位数是唯一走明细的部分，
   口径为「范围内最近 2000 条样本」（不足即精确值）。理由：SQLite 无 percentile 函数，而全表排序
   就是 M0 实测的 96ms 风险点。
4. **策略拦截与工具失败分离**：`steps.blocked_by`（approval / plan_mode / policy）+ 三处归因，
   `byTool.errorRate` 只统计真实失败；被正确拦下的调用单独计 `blocked`。
5. **`prune` 只删明细、不动预聚合**：明细用于下钻，聚合用于长期趋势。
6. **`createApp()` 不传 trace 配置就不写盘**：这是测试安全的默认值；生产由 `server.ts` 传
   `config.trace`（默认开启 SQLite，库文件 `~/.pi/agent-node-server/platform.db`）。
7. **队列溢出与失败都不抛**：超限丢最旧并计数；连续 flush 失败 3 次进入 degraded 并丢弃后续写入，
   面板显示告警——trace 永远不会把 agent loop 拖垮。

#### 实测数据（写进 doc 与测试门禁）

- `record()` 同步开销（SQLite 后端、200 条攒批）：**p50 0.004ms / p95 0.011ms / max 5.5ms**，
  max 来自每 200 条一次的批量 flush（`lastFlushMs ≈ 3.4ms`），由 `session-ledger.test.ts` 守门。
- 真实 SDK + `fauxProvider` 跑完整 agent loop（`ledger-e2e.test.ts`）：1 run / 2 turns / 2 个
  llm_call（`meta.httpStatus=200`）/ 1 个 tool_call，summary 有数——provider 观测扩展在真实扩展
  加载器下确实被触发。
- 迁移规则（已写进代码注释与 M1 文档）：**已发布的 DDL 不得改写，只能追加新版本迁移**。
  过渡期 v1 建的是 `day_rollups`，重构后直接改写 v1 会让已建好的库缺 `run_rollups`
  （聚合查询直接报错）——现已追加 v2 迁移修复，并在真实 dev server 上验证过 1 → 2 自动升级。

---

### 3.7 M2 任务领域（已完成，`docs/node-task-domain-m2.md`）

#### 交付物

| 层 | 内容 |
| --- | --- |
| 模型 | `services/platform/task-model.ts`：`TaskRecord` / `TaskStep` / `deriveTaskStatus` / `nextStepId` / `applyStepStatus` |
| 存储 | `services/platform/task-repository.ts`：SQLite（migrations v3）+ 内存双实现，语义等价 |
| 用例 | `services/task-service.ts`：状态聚合、`ifRevision` 乐观并发、变更广播 |
| 接口 | `routes/tasks.ts`：8 个接口（list/create/detail/patch/cancel/steps 增改删） |
| 推送 | SSE `task_updated`（`AgentRegistry.announceTask`）+ `web/src/components/TaskPanel.vue` |
| 关联 | `runs.task_id`（账本在 run 开始时取会话当前任务） |

#### 已冻结的决策（实施中定的，比规划更具体）

1. **状态唯一真相源＝步骤**：`completed` 由步骤聚合（删掉未完成步骤可以回落），
   **只有 `cancelled` 冻结**。手工设置的 `status` 会在下一次步骤变更时被重新聚合——
   不保留隐藏状态。
2. **「已开工」不能只看 `in_progress`**：否则「2 步做完 1 步」会显示成「尚未开始」。
3. **任务写入不走 trace 的写入队列**：trace 可丢可降级，任务是用户可见状态，
   必须同步落库、错误必须冒泡；两者共用同一个 `DatabaseSync` 连接（单线程同步，不交错）。
4. **乐观并发用单语句**：`UPDATE ... SET revision = revision + 1 WHERE id = ? AND revision = ?`，
   按 `changes` 判定，409 带 `currentRevision`。
5. **步骤 id `s{n}` 删除后不复用**；步骤表整批重写（几十条，重写比 diff 稳）。
6. **`/resume` 与 `/recovery` 不占位**：半成品接口会让调用方以为功能已存在（M3 才做）。
7. **SSE 广播规则**：绑定 `sessionId` → 只推该会话；否则推给 `cwd` 匹配的活跃会话。
   任务变更**不进流式状态机**（`reduceAgentEvent` 刻意不处理），避免误判「Agent 在跑」。
8. **trace 开关与任务解耦**：`PI_NODE_TRACE=0` 只关观测明细，任务照常落 `platform.db`；
   `createApp()` 不传配置时仍是「不落盘」的空存储（测试安全默认值）。

#### 顺带修掉的两个真实问题

- **连接泄漏**：trace 关闭 + sqlite 时，没人关闭 `DatabaseSync`（任务共用该连接）。
  测试清理临时目录失败暴露了它，`PlatformStore.close()` 现在显式关闭后端。
- **客户端错误返回 500**：请求体不合法（如 Content-Length 不匹配、JSON 解析失败）走全局错误处理器
  被统一成 `500 internal_error`，还会把 Fastify 原始 message（含请求体片段）回给客户端。
  现在 4xx 保留状态码、机器码归一为 `invalid_request`，只回固定文案。

#### 真机验证（临时 agent 目录 + 临时库）

create（rev1，含 verification）→ 加步骤（rev2）→ 完成 s1（任务聚合 in_progress，rev3）
→ 陈旧 `ifRevision` 返回 `409 + currentRevision=3` → cancel（rev4）；
`platform.db` 里 `user_version=3`、`tasks` / `task_steps` 已落库。

---

### 3.8 M3 断点续跑（已完成，`docs/node-task-recovery-m3.md`）

#### 交付物

| 层 | 内容 |
| --- | --- |
| 租约 | `services/task-lease.ts`：owner = `pid-bootId`、TTL 30s、每 10s 续期、`TaskLeaseKeeper` |
| 在飞动作 | `services/task-recovery-extension.ts`：turn/tool 钩子 → `execution.inFlight`；副作用分级在 `task-recovery.ts` |
| 恢复判定 | `services/task-recovery.ts`：扫描、`assertResumable`、只读产物验证、`markInterrupted` |
| 续跑 | `services/task-runner.ts`：校验 → 取租约 → 注入 `[TASK RESUME]` → 发 prompt → 续期保活 |
| 接口 | `GET /api/tasks/recovery`、`POST /api/tasks/:id/resume`（202）、SSE `task_recovery_required` |
| 前端 | 任务面板「上次运行被中断」+ [继续执行]/[重试当前步骤]，409 确认流 |

#### 已冻结的决策

1. **恢复清单只列不跑**：启动扫描只写日志，续跑必须由人点（模型可能在无人时做不可逆操作）。
2. **比规划更保守的一处**：`lastSideEffect` 在步骤完成前一直保留（规划是
   `tool_execution_end` 清 `inFlight` 就完事）——否则「写完文件、还没打勾就被杀」
   会被判成「两步之间」而自动重跑，正是重复副作用的来源。它只在属于当前步骤本次尝试时生效。
3. **`bash` 副作用用审批规则判定**：命中危险/敏感规则 → `write`；未命中 → `unknown`
   （普通命令也可能是写，宁可多要一次确认）。
4. **产物验证只做只读 stat**：`verification.kind='command'` 等于绕过审批跑任意 shell → 留给 M4。
5. **产物在 → 补记完成（绝不重跑）；不在 → 标 blocked**；`retry_step` 是唯一逃生门。
6. **`replan` 不占位**：直接 409 `replan_unavailable`（M4 接管）。
7. **执行态写入也走 `TaskService`（乐观锁 + 广播）**：否则面板手里的 `revision` 会静默落后，
   用户下一次点击就会莫名 409；前端也顺手做了「409 自动刷新后重试一次」。

#### 真机验证（临时目录 + `kill -9`）

启动日志 `WARN count=1` → `GET /recovery` 给出 `sideEffect=write`/`action=manual_only`/
`requiresConfirmation=true` → 不带确认 resume 得 `409 task_needs_confirmation` →
声明了 file 产物的任务在产物存在时把步骤**补记为 completed（附证据）**、
随后因会话文件缺失得 `409 task_session_missing` 且任务 blocked（不崩）。
「202 + 模型真的跑起来」由 fake session 集成测试覆盖（真机无模型凭据）。

#### 顺带修掉的两个问题

- **漏提交文件导致 HEAD 不能编译**：上一个提交漏了 `session-ledger.ts` 里的联合成员，
  本地工作区能过、HEAD 过不了。教训写进提交信息：提交前要跑完整门禁，别只看工作区。
- **`requiresConfirmation` 判定错误**：产物已存在时执行器会直接补记完成、不需要人确认，
  清单却仍标 `true`，面板白提示一次。

---

### 3.9 M4 Plan 模式重构（已完成，`docs/node-plan-mode-m4.md`）

#### 交付物

| 层 | 内容 |
| --- | --- |
| 领域 | `platform/plan-model.ts`（`PlanView` + `derivePlanStatus`，纯投影）、`platform/step-verification.ts`（证据判定，M3 恢复也复用）、`execution.plan` 落库（无新迁移） |
| 工具 | `services/plan-tools.ts`：`submit_plan` / `update_plan` / `complete_step` / `block_step` / `ask_user`（TypeBox + promptSnippet/Guidelines） |
| 权限 | `services/plan-policy.ts`：能力分类（审批规则 → 拆段 → 程序名归类），未归类即不放行 |
| 状态机 | `services/plan-mode-service.ts` 重写：工具差集撤销、上下文注入（规划/执行两种，每轮去重）、`tool_call` 拦截、命令分发 |
| 执行 | `TaskRunner.start/stop`：计划执行复用 M3 的租约与任务绑定 |
| 接口 | `plan_start/execute/pause/resume/refine/abandon`（`plan_enable/disable` 弃用别名）、`prompt.mode`、SSE `plan_updated` → `PlanView` |
| 前端 | 计划面板（证据/验证声明/暂停/继续/改名/跳过/删除）、输入框 `[直接执行 \| 先规划]` + `/plan` 前缀、移除 Plan 预开关 |
| 评测 | `npm run eval`：7 个 golden 用例 + pass@1 / 计划一次通过率 / 零残留旧标记 三项门禁 |

#### 已冻结的决策（详见 M4 文档 §3）

1. **计划一进入规划就落库**（空步骤任务 `drafting`）——否则「正在调研」这段状态不可持久化。
2. **`planId === taskId`**；落库状态只有四种意图，`completed`/`abandoned` 由任务状态推导。
3. **按标题复用进度**；执行期允许调整还没开始的步骤，但**不能删除或重命名已开始/已完成的步骤**。
4. **证据校验分级**：`file` 查产物、`command` 只验「跑过且如实上报」（不重跑，避免绕开审批）、`manual` 要结论。
5. **权限差集撤销**：只撤销自己造成的工具改动，用户改动不被吞；计划自然完成时也收回计划工具。
6. **版本号＝用户可见内容的版本**：心跳/在飞不占用 revision；`mutate` 的「change 返回原对象=无变化」让幂等命令不写库。
7. **JSONL 只写 `web-plan-ref` 指针**，旧快照保留不删也不再写（CLI 兼容）。

#### 验证证据

- **spike ⑦**（真实 SDK + fauxProvider，进 CI）：模型零标记完成「规划 → 确认 → 执行 → 完成」；
  证据三连（缺口令/错退出码/缺产物被拒 → 补齐后通过）；执行期/规划期工具集差异；放弃后记录保留。
- **eval**（`npm run eval`）：pass@1 100%、计划一次通过率 100%、工具调用失败率 16.7%、
  平均步骤证据覆盖率 64.3%、残留旧标记 0。
- 单测：Node **286 passed**（+80），Web **99 passed**（+19）。

#### 过程里抓到的真实缺陷（都已修，且都是单测看不出来的）

| # | 缺陷 | 修法 |
| --- | --- | --- |
| 1 | SDK 的 `tools` 是**可用工具白名单**：带预设的会话里 `submit_plan` 直接 "not found"，MCP 工具同理 | 白名单并入内联扩展工具名（`withInlineTools`） |
| 2 | 计划自然完成后计划工具不收回 | 终态即撤销差集；计划工具一律登记为「本次会话打开」 |
| 3 | 心跳/在飞写入顶掉 `revision` → 模型思考期间手里的版本就过期，`update_plan`/面板编辑频繁 409 | 版本号语义修正（`keepRevision`） |
| 4 | 幂等命令（`plan_resume`）也写库顶版本号 | `mutate` 的「无变化」约定 |
| 5 | 初版一刀切禁止执行期替换步骤，把 P4 要修的场景也挡掉了 | 改为只保护已开始/已完成的步骤 |

---

### 3.10 M4.1 向用户提问的交互通道（已完成，`docs/node-question-channel.md`）

用户反馈 `ask_user` 只显示一句问题、不能选选项，因此把它从「计划面板上的一行字」
升级为独立的交互通道（与危险命令审批并列）。

#### 交付物

| 层 | 内容 |
| --- | --- |
| 后端 | `services/user-question.ts`：`QuestionBroker`（挂起队列 + 10 分钟超时 + abort/会话关闭/服务关闭结算）+ `ask_user` 工具（一次最多 8 题，选项/多选/自由输入） |
| 契约 | SSE `question_pending` / `question_resolved`；命令 `answer_question`；会话状态 `pendingQuestion`（刷新可恢复弹窗） |
| 前端 | `QuestionDialog.vue`（多题一屏、N/M 已答、未答按跳过、「让 AI 自己决定」）+ reducer/ChatWindow 接线 |
| 移除 | `PlanView.question*` 与 `execution.plan.question`：**「谁在等用户」只有一个真相源**（挂起队列） |

#### 已冻结的决策

1. **挂起而不是结束本轮**：答案作为工具返回值回流，模型在同一次工具调用里继续；
   旧做法（结束本轮 + 用户自由文本回复）会让模型猜「这条消息是回答还是新需求」。
2. **提问与 Plan 无关**：工具属于通用通道，任何会话都激活，计划结束后依然可用；
   因此 `PLAN_TOOL_NAMES` 只剩四个，`ask_user` 单独注册（并进 tools 白名单）。
3. **必须有确定的失败路径**：超时/取消/中止/会话关闭都按「未回答」结算，
   并明确要求模型「按最合理假设继续并写明假设」，而不是报错或永久挂起。
4. **一次只允许一个挂起提问**：前端只有一个弹窗；需要并行问多件事就把它们放进同一次调用。
5. **默认允许自由输入**：选项永远可能不全，逼用户在预设项里选是最讨厌的交互。
6. **选项用 button + aria-checked**：原生 `label > input` 点击会同时触发 label 激活与
   change，容易变成「点一下切换两次」（测试与浏览器都踩过）。

#### 验证

- 单测：`user-question.test.ts` 18 例、路由 2 例、`QuestionDialog.test.ts` 10 例、
  reducer 3 例、api 1 例。
- 真机 HTTP：`state.pendingQuestion` 出现在状态快照；无挂起提问时 `answer_question` → 404。
- **eval 用例 `ask-user-roundtrip`**：真实管线里边跑边答（工具挂起 run → 轮询到挂起问题 →
  回答 → 答案回流进模型下一次 `complete_step` 的证据），8/8 通过。
- 遗留缺陷（2026-09-10 用户实测发现，已修）：前端 `assignStream` 逐字段拷贝漏掉 `pendingQuestion`，
  SSE 的提问状态被静默丢弃→模型挂起等待但界面不弹窗（后端与 eval 均正常，只有真实浏览器能发现）。
  修法与回归防线见 `docs/node-question-channel.md` §5.1。坑在于修完还得 `npm run build` 重建 `web/dist`
  并硬刷新，否则线上加载的仍是旧 bundle（已重建，133 条前端用例全绿）。

---

### 3.11 MCP 模板库（已完成，`docs/node-mcp-guide.md` §3「推荐模板库」）

用户反馈「支持的 MCP 比较少」。排查后确认：**协议层本来就能加任意 server**（stdio + http 静态头、
两层配置、预设白名单、每 server 审批都已就绪），缺的是**目录**——用户得自己知道包名/参数/环境变量。
因此这一节交付的是「模板库」，不是新协议能力。

#### 交付物

| 层 | 内容 |
| --- | --- |
| 后端 | `services/mcp/mcp-templates.ts`：18 个模板 / 7 组 + `assertTemplateTable()` 自检 + `@fixture:` 动态路径解析 |
| 契约 | `GET /api/mcp/templates` → `{ templates }`，每条附 `requiresCredentials` / `canAddDirectly` |
| 安全 | `mcp-client-manager` 的 **args 也做 `$ENV` 插值**：很多 server 只能用 `--access-token=...` 传凭据，不插值就意味着密钥明文写进与 CLI 共享的 mcp.json |
| 前端 | `McpConfig.vue` 模板库面板：分组卡片 + 风险徽标 + 一键添加 / 填入表单 / 文档链接 |

#### 已冻结的决策

1. **凭据只能是 `$ENV` 引用**（env、headers、args 三处都是），由 `assertTemplateTable()` 守住；
   配置文件里永远没有明文密钥——该文件与原版 CLI 共享。
2. **`needsInput` 的模板不允许一键添加**（filesystem 缺根目录、uvx 系缺项目路径）：
   否则会加出一个起不来的 server，比「多一步填表」更糟。
3. **如实标注能力**：`access`（只读 / 本地写 / 外部副作用）+ `suggestApproval`（外部写一律建议审批）
   + `toolCountHint`（工具都会进系统提示词，装太多会分散注意力）。
4. **只收录静态凭据可用的 server**：仓库只支持静态请求头鉴权，因此 GitHub 用 PAT 版、
   Sentry 用 `--access-token`，OAuth-only 的托管 server 不收录。
5. **自带 `debug-echo` 模板**指向仓库 fixture（服务端动态解析路径）：排错第一步先确认它能连上。

#### 验证

- 单测：模板形状自检 11 例（重复 id、缺 command/url、明文密钥、组别、Python 依赖标注、
  外部写必建议审批）+ 列表派生字段 + `@fixture:` 路径解析 + 路由 1 例。
- 前端：模板库 6 例（分组渲染、徽标、一键添加的 payload、需凭据只填表、needsInput 提示、
  拉取失败降级）。
- **真机**（临时实例 + 真实 npx）：`GET /api/mcp/templates` 返回 18 模板 / 7 组 / 5 个可一键添加；
  用模板原样添加 `debug-echo` → 连上并列出 3 个工具；添加 `memory` → 9 个工具；
  落盘 `mcp.json` 中无任何明文密钥。

---

### 3.12 M5 子任务委派（已完成，`docs/node-subagent-m5.md`）

#### 为什么不是「把官方扩展接进来」

官方 `subagent` 文件扩展在本机**一调用就失败**：四个预设写死 `model: claude-sonnet-4-5` /
`claude-haiku-4-5`，而本机只鉴权了 deepseek → 子进程直接以
`Model "claude-sonnet-4-5" is ambiguous across providers … No matching provider is authenticated`
退出。它还有三个结构性缺陷：spawn 独立 `pi` 进程（`--mode json --no-session`）导致
拿不到 Web 审批通道、不进 trace 树、不受租约约束，且无法离线评测。
因此**内联实现 + 同名接管**（`subagent` 加进 `INLINE_OWNED_EXTENSION_DIRS`，
只影响本服务加载，CLI 照常）。

#### 交付物

| 层 | 内容 |
| --- | --- |
| 服务 | `services/subagent-service.ts`（子会话创建/预算/并发闸门/取消级联/`buildExtension`）、`subagent-presets.ts`（预设发现 + 只读判定）、`subagent-models.ts`（模型解析与回退） |
| 工具 | `services/subagent-tools.ts`：`subagent` 工具（单任务 + 平行调用靠 `executionMode: 'parallel'`） |
| 接线 | `agent-registry`（`CreateSessionInput.subagent`、子会话工具集特例、`parentRunId` 进账本、`abortSession()` 级联、审批挂父会话）、`tool-approval`（父会话回退查找）、`session-ledger`（`currentRunId`/`lastRunId`）、`plan-mode-service`+`plan-policy`（规划期委派门禁）、`task-runner`（`stop()` 级联） |
| 前端 | `SubagentCallBlock.vue`：预设/深度/用量/轨迹/回退说明/摘要；`ToolCallBlock` 分流 |
| 评测 | `eval/` 3 个用例 + 新门禁；**harness 改跑真实工厂**（新增 `useRuntime()` 注入口） |

#### 已冻结的决策

1. **内联替换 + 同名接管**（保留共存 = 保留一个必然报错的工具）。
2. **工具名 `subagent`**（叫 `task` 会与 M2 任务领域撞概念）。
3. **预设只用 `~/.pi/agent/agents/*.md` + 项目级 `.pi/agents/`**（与官方扩展同契约，
   你已有的 scout/planner/reviewer/worker 直接可用；不另立 explore/verify/general）。
4. **预设模型解析不了就回退父会话模型 + 在结果里说明**（官方就是死在这里，必须让人看见）。
5. **不能递归是结构保证**：到 `maxDepth` 的子会话根本不注册该工具。
6. **只读预设真的只读**：子会话工具集就是预设工具集，不并入 MCP/计划/ask_user。
7. **子会话落 `~/.pi/agent-node-server/subagents/`**（不进 CLI 的会话列表）。
8. **预算以轮数 + token + 时限为主**（deepseek 上报成本恒为 0，美元上限形同虚设），
   超限 abort 并**带回已产出的摘要**。
9. **审批弹窗挂到父会话**（子会话没有自己的界面），`approve_tool` 仍只用父会话 id。
10. **取消级联的五个入口**：父 abort / 计划暂停·放弃 / 会话删除 / 服务关闭 / `TaskRunner.stop`。
11. **规划期只放行结构上只读的预设**（`tools ⊆ read/grep/find/ls`）。

#### 实施中抓到的真实缺陷

- **子会话审批发到了没人订阅的流上**（父会话看不到弹窗 → 30 秒超时按拒绝 → 委派失败）。
- **`finishRun` 抹掉 run 元信息**（M1 遗留）：`UPDATE runs … meta = :meta` 在收尾不带 meta
  时写 NULL，`{parentSessionId, preset, depth}` 全丢 → SQL 改保留原值 + 内存后端同步 +
  账本收尾改为合并；补了回归测试。
- **`withInlineTools` 对子会话必须关掉**：否则「只读预设」会悄悄拿到 MCP 与写工具。
- **工具结果里塞进了完整 Model 对象**（含 baseUrl/api）：规整为 `{provider, id}`。

#### 验证

- 单测 +36（预设发现 7 / 模型解析 8 / 服务 19 / 审批继承 4 / 注册表·账本 8 /
  规划门禁 2 / 租约级联 1 / meta 回归 1）→ 368 passed。
- `npm run eval` 11/11 + 四项门禁（新增「子任务 trace 关联率」3/3）；
  `npm run spike` 30 项断言仍全过。
- **真机**：模型自己调用 `subagent` 委派 scout → 子会话 3 轮 `bash×2` 回摘要「45 个 .ts」，
  工具结果里带「预设模型 claude-haiku-4-5 不可用，改用父会话模型」与用量；
  父会话随后用 bash 复核数字；平台库里子 run 的 `parent_run_id` → 父 run、
  `meta = {parentSessionId, preset: scout, depth: 1}`。

---

### 3.13 长会话读取崩溃修复：分支树扁平化（已完成，`docs/node-session-tree-flat.md`）

**现象**：`GET /api/sessions/:sessionId` 打开超长会话时 500，
`RangeError: Maximum call stack size exceeded`，栈顶是 Fastify 的 `JSON.stringify`。

**根因**：Pi 会话树是「一条消息一个节点」的链表，嵌套深度 = 条目数（实测 2395 条目 → 深度 2391）。
`JSON.stringify` 是递归实现，该节点形状约 **2300 层触顶**（2400 层必崩）。
同一个响应里 `tree` 还重复了整份会话内容（6.5 MB vs `context.messages` 1.4 MB）。

**修法（已冻结的决策）**：

1. `tree` 从嵌套数组改为**扁平数组 + `depth`**（先序，父在前）；节点不带 `children`。
2. 节点只带导航所需字段：`id / parentId / depth / type / role / text(≤120 字符摘要) / label / labelTimestamp`；
   正文一律走 `context.messages`，**不得**再塞回 `tree`。
3. 服务端用显式栈拍平（`services/session-tree.ts`）——服务端自己也不能递归。
4. 前端在 **API 层**归一化（`lib/session-tree.ts`）：Node 扁平直接用，Python 嵌套用显式栈拍平；
   组件只面对扁平节点（`BranchNavigator` 不再递归、`ChatWindow` 节点数直接取长度）。
   这样冻结的 Python 后端不需要改。

**证据**：同一会话 `tree` 6.53 MB → 0.53 MB，完整详情 1.9 MB，序列化正常。

**测试**：Node +5（`session-tree` 单测 4 + 路由端到端回归 1，后者在改动前必 500 已验证）、
Web +4（归一化 4 例，含 5000 层不爆栈）→ Node 373 / Web 128。

**已知限制**：Python 后端仍返回嵌套树（其 `json.dumps` 在 ~1000 层 `RecursionError`）——
`pi-python` 已冻结，只在前端兜底；生产走 Node 后端。

---

## 4. 硬约束速查：与原版 pi 的边界

```
共享态（可以增量写，禁止破坏性写）
├── auth.json          只读
├── settings.json      只读
├── models.json        读 + 增量写（spread 保留未知字段 + 原子写 + 校验前置）
├── models-store.json  只读
└── sessions/*.jsonl   读 + 新增 + 追加；禁止删除、禁止改写既有 header

项目私有态（pi 不认识）
├── trace / tasks      →  ~/.pi/agent-node-server/platform.db   【trace 已建（M1，WAL）；tasks 待 M2】
├── mcp.json           →  pi 不支持 MCP，纯本项目
├── node-server-presets.json / node-server-workspaces.json
└── 内联扩展            →  内存注入，不落盘

四条红线
1. 禁止删除 pi 的文件（会话 JSONL）
2. 禁止写入时剥离未知字段
3. 禁止写入 pi 无法解析的内容；禁止把明文密钥写进共享配置
4. trace 必须对 CLI 零影响：ledger.record() 一律 fire-and-forget + 异常降级 warn，
   绝不能冒泡到 agent loop
```

---

## 5. 下一步

> **M5（Subagent）已完成**：交付物、决策与验证见 §3.12 与
> [`docs/node-subagent-m5.md`](docs/node-subagent-m5.md)（含 DoD 对照与「已知未做」）。

### 5.1 目前没有既定的下一个里程碑

规划里的 M5 是最后一个里程碑，之后只剩三类可选工作（都**不是**必须先做的）：

| 方向 | 内容 | 价值 |
| --- | --- | --- |
| 委派可视化加深 | 侧栏会话树（子会话缩进）、子会话轨迹回看页、观测面板的「按 `parent_run_id` 分组」视图 | 现在只有工具卡片摘要（`docs/node-subagent-m5.md` §6 已记） |
| 会话删除加固 | 两阶段提交 + 移入 trash（第 6 节 #2） | 误删会话不可恢复目前是唯一「破坏性」缺口 |
| 命名空间卫生 | `mcp.json` / `node-server-*.json` 迁到 `~/.pi/agent-node-server/`（第 6 节 #3） | 无功能风险，纯卫生 |
| Plan 期放行只读 MCP | `PlanPolicy` 加只读 MCP 白名单 | 规划期能用 context7/tavily 查资料 |

### 5.2 M5 之后若要继续，建议的顺序

1. **（可选）委派可视化**：M5 已经把数据都存下来了（`parent_run_id` + `meta`），
   做视图是纯前端/一个 REST 的事，改动小、收益直观。
2. **会话删除加固**：这是目前唯一会「破坏性」丢数据的路径，值得提前做。
3. 其余按需。

### 5.3 继续时的既有约束（不变）

- 子会话必须走 `AgentRegistry`（审批/租约/trace/任务绑定都要生效），不要旁路。
- 共享态（`~/.pi/agent/sessions`、`models.json`）只做增量写入；本项目私有态落
  `~/.pi/agent-node-server/`。
- 新能力落地时必须补：单测（正常 + 边界）、`npm run spike`/`eval` 门禁、
  `docs/` 说明并在 README/CLAUDE 索引登记。

---

## 6. 待用户决策

| #   | 事项                           | 选项                                                                  | 影响                                                                                                                                                                                                                       |
| --- | ------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~官方 `subagent` 扩展的去留~~ | ✅ **已决策（M5）**：内联实现替换 + 同名接管                          | 已落地，见 §3.12 / `docs/node-subagent-m5.md`                                                                                                                                                                              |
| 2   | 会话删除的加固                 | 两阶段提交 + 移入 trash                                               | 非阻塞；目前唯一会破坏性丢数据的路径（误删不可恢复）                                                                                                                                                                       |
| 3   | PI 命名空间                    | `mcp.json` / `node-server-*.json` 是否迁到 `~/.pi/agent-node-server/` | 仅卫生，无功能风险                                                                                                                                                                                                         |

---

## 7. 验证命令

```powershell
# Node 后端（工作目录 node-pi/server）
npm run format:check && npm run typecheck && npm test && npm run build && npm run spike
#   → 期望：format OK / 无类型错误 / 368 passed / 构建成功 / spike 全过 / eval 门禁全过

# 前端（工作目录 web）
npm run typecheck && npm run lint && npm test && npm run build
#   → 期望：无类型错误 / 0 error / 124 passed / 构建成功

# 起服务
cd node-pi/server && npm run dev      # http://127.0.0.1:8001
cd web && npm run dev                 # http://127.0.0.1:5173
```

> **spike 的意义**：`npm run spike` 里的 8 个脚本是**能力守护**，不是探索脚本。
> 依赖升级若破坏 `fauxProvider` 可解析性、`node:sqlite`、父子会话或钩子链语义，
> 它会立刻失败。改动 `package.json` 依赖后必须跑一遍。

---

## 8. 文件地图

### M1 新增（可观测底座，2026-08-21）

```
node-pi/server/src/services/platform/
  migrations.ts                 建表 + PRAGMA user_version 迁移（runs/steps/三张预聚合表）
  trace-model.ts                领域模型与共享纯函数（isRealError / dayOf / 游标）
  trace-repository.ts           接口契约 + QueuedTraceRepository（250ms/200 条）+ NullTraceRepository
  sqlite-trace-storage.ts       SQLite 后端：批量事务写、预聚合增量维护、有界样本查询
  memory-trace-storage.ts       内存后端（与 SQLite 语义等价，有等价性测试）
  store.ts                      装配入口：选后端、建库、套队列、失败回落内存
node-pi/server/src/services/observability/
  session-ledger.ts             事件 → runs/steps（唯一埋点逻辑，异常一律降级）
  redact.ts                     三层脱敏 + digest/字节数/预览
  metrics.ts                    分位数与 REST 整形（纯函数）
  observability-extension.ts    provider 层钩子（HTTP status / 首字节耗时）
node-pi/server/src/routes/observability.ts
node-pi/server/test/services/platform/trace-store.test.ts
node-pi/server/test/services/observability/{session-ledger,registry-ledger,ledger-e2e,metrics}.test.ts
node-pi/server/test/services/agent-registry-state.test.ts
node-pi/server/test/routes/observability-routes.test.ts
web/src/components/ObservabilityPanel.vue
web/test/components/ObservabilityPanel.test.ts
docs/node-observability-m1.md                  M1 实现说明（口径/取舍/契约/DoD 对照）
```

### M1 改动（关键位置）

```
node-pi/server/src/services/agent-registry.ts
  · publish() 尾部调用 ledger.record()        ← 唯一插桩点
  · close()/remove() 收尾未结算 run            · start() 上报 prompt() 失败
  · state() 透传 getContextUsage/getSessionStats（零成本修复）
node-pi/server/src/services/tool-approval.ts
  · ApprovalTraceSink（挂起/结算上报）          · settle 区分 user/timeout/abort/session/disposed
node-pi/server/src/services/plan-mode-service.ts
  · PlanTraceSink（规划期拦截上报 blocked_by）
node-pi/server/src/app.ts
  · PlatformStore + SessionLedger 装配          · /api/observability 注册      · onClose 关存储
node-pi/server/src/config.ts / src/server.ts
  · PI_NODE_DATA_DIR + PI_NODE_TRACE_* 配置     · server.ts 传入 config.trace
web/src/components/{SettingsDialog,AgentControls,ChatWindow}.vue
  · 设置新增「用量」分类                         · ContextUsage 可空处理（不再显示 NaN%）
web/src/types/index.ts / src/lib/api.ts
  · 可观测性类型与 4 个接口封装
```

### M2 新增（任务领域，2026-08-21）

```
node-pi/server/src/services/platform/task-model.ts       领域模型与纯函数（状态聚合/步骤 id/状态迁移）
node-pi/server/src/services/platform/task-repository.ts  SQLite + 内存双实现（乐观锁、步骤整批替换）
node-pi/server/src/services/task-service.ts              用例层（聚合、ifRevision、广播）
node-pi/server/src/routes/tasks.ts                       8 个任务接口
node-pi/server/src/services/platform/migrations.ts       v3：tasks / task_steps
node-pi/server/test/services/platform/task-repository.test.ts
node-pi/server/test/services/task-service.test.ts
node-pi/server/test/routes/tasks-routes.test.ts
web/src/components/TaskPanel.vue
web/test/components/TaskPanel.test.ts
docs/node-task-domain-m2.md                              M2 实现说明（语义/契约/DoD 对照）
```

### M2 改动（关键位置）

```
node-pi/server/src/services/agent-registry.ts
  · announceTask（SSE task_updated 广播）      · setActiveTask（run↔task 关联）
node-pi/server/src/services/observability/session-ledger.ts
  · LedgerSessionContext.taskId → runs.task_id
node-pi/server/src/services/platform/store.ts
  · PlatformStore.tasks；trace 开关与任务解耦；close() 显式关闭后端（修泄漏）
node-pi/server/src/app.ts
  · TaskService 装配 + /api/tasks 注册 + 关闭时 dispose
  · 全局错误处理器：4xx 客户端错误 → invalid_request（不再一律 500）
web/src/composables/useAgentSession.ts   · task ref + refreshTask + task_updated 归约
web/src/lib/agent-events.ts              · task_updated 不进流式状态机（契约注释）
web/src/components/ChatWindow.vue        · 任务面板接线与 6 类操作
web/src/types/index.ts / src/lib/api.ts  · 任务类型与 7 个接口封装
```

### M3 新增（断点续跑，2026-08-21）

```
node-pi/server/src/services/task-lease.ts                租约与续期（owner = pid-bootId）
node-pi/server/src/services/task-recovery.ts             恢复清单、副作用分级、产物验证
node-pi/server/src/services/task-recovery-extension.ts   在飞动作内联扩展 + 隐藏恢复上下文注入
node-pi/server/src/services/task-runner.ts               续跑执行器（校验→租约→注入→prompt→保活）
node-pi/server/test/services/task-recovery.test.ts
node-pi/server/test/services/task-recovery-extension.test.ts
node-pi/server/test/services/task-runner.test.ts         重启恢复 / 防双跑 / 副作用四类分支
web/test/components/TaskPanel.test.ts                    （新增恢复块用例）
docs/node-task-recovery-m3.md                            M3 实现说明 + DoD 验证记录
```

### M3 改动（关键位置）

```
node-pi/server/src/services/platform/task-model.ts   · TaskLease/currentStep/isLeaseActive/isInterrupted
                                                     · execution.lastSideEffect（比规划保守的一处）
node-pi/server/src/services/task-service.ts          · acquireLease/renewLease/releaseLease/setInFlight
                                                     · markInterrupted/resetCurrentStep/completeStepWithEvidence
                                                     · mutate()：执行态写入也走乐观锁 + 广播
node-pi/server/src/services/agent-registry.ts        · 工厂第 7 参（恢复扩展）· announceRecovery/hasSubscribers
node-pi/server/src/routes/tasks.ts                   · GET /recovery、POST /:id/resume（202）
node-pi/server/src/routes/agent.ts                   · SSE 首个连接补推 task_recovery_required（remindRecovery）
node-pi/server/src/app.ts                            · 装配 owner/tracker/recovery/runner；onReady 扫描；onClose 释放租约
web/src/composables/useAgentSession.ts               · recovery ref + refreshRecovery + SSE 归约
web/src/components/{TaskPanel,ChatWindow}.vue        · 中断提示与一键继续；409 自动刷新重试
web/src/types/index.ts / src/lib/api.ts              · TaskRecoveryItem 等类型与 2 个接口封装
```

### M4 新增（Plan 重构，2026-08-21）

```
node-pi/server/src/services/platform/plan-model.ts         PlanView/PlanStatus/derivePlanStatus（纯投影）
node-pi/server/src/services/platform/step-verification.ts  证据判定（file/command/manual，M3 恢复复用）
node-pi/server/src/services/plan-tools.ts                  五个计划工具 + PlanToolbox 用例层
node-pi/server/src/services/plan-policy.ts                 规划期能力分类与 PlanPolicy
node-pi/server/eval/harness.mjs                            评测/端到端共用的真实装配
node-pi/server/eval/run.mjs                                golden set（7 用例 + 三项门禁）
node-pi/server/spike/07-plan-tool-loop.mjs                 端到端：模型零标记走完完整旅程
node-pi/server/test/services/plan-{policy,tools}.test.ts
node-pi/server/test/services/platform/{plan-model,step-verification}.test.ts
docs/node-plan-mode-m4.md                                  M4 实现说明 + 验证证据
```

### M4 改动（关键位置）

```
node-pi/server/src/services/plan-mode-service.ts      · 删除 extractPlan/markDone/[DONE:n]
                                                      · 工具差集撤销 + 两种上下文注入 + 能力集拦截
                                                      · 命令：plan_start/execute/pause/resume/refine/abandon
node-pi/server/src/services/platform/task-model.ts    · execution.plan（四种意图，无新迁移）
node-pi/server/src/services/task-service.ts           · createPlan/setPlanState/replacePlanSteps/abandonPlan
                                                      · 版本号语义：keepRevision + 「无变化」短路
node-pi/server/src/services/platform/task-repository.ts · save 支持 keepRevision
node-pi/server/src/services/task-runner.ts            · start/stop（计划执行复用租约）；replan 只对 plan 任务
node-pi/server/src/services/task-recovery.ts          · TaskRecoveryItem.origin；replan 放行条件
node-pi/server/src/services/agent-registry.ts         · prompt.mode、plan_* 命令、PlanView 推送
                                                      · withInlineTools（预设白名单并入内联工具）
node-pi/server/src/routes/agent.ts                    · /new 与 prompt 透传 mode
node-pi/server/src/app.ts                             · plans.setTaskService/setExecutor；任务变更同步计划视图
web/src/components/PlanProgress.vue                   · 计划面板改任务视图（证据/暂停/继续/编辑）
web/src/components/{ChatInput,ChatWindow,AgentControls}.vue · 发送方式选择器 + 移除 Plan 预开关
web/src/{types,lib/api.ts,composables/useAgentSession.ts}   · PlanView 契约与 refreshPlan
web/test/components/PlanProgress.test.ts              · 重写为 14 例
```

### M4.1 新增（提问通道，2026-08-21）

```
node-pi/server/src/services/user-question.ts           QuestionBroker + ask_user 工具 + 回答渲染
node-pi/server/test/services/user-question.test.ts
web/src/components/QuestionDialog.vue                  提问弹窗（多题/选项/自由输入/取消）
web/test/components/QuestionDialog.test.ts
docs/node-question-channel.md                          通道契约与行为取舍
```

### M4.1 改动（关键位置）

```
node-pi/server/src/services/agent-registry.ts   · answer_question 命令 + question_pending/resolved 推送
                                                · 状态快照 pendingQuestion · tools 白名单并入 ask_user
node-pi/server/src/app.ts                       · 装配 QuestionBroker（可注入）
node-pi/server/src/services/plan-tools.ts       · 移除 ask_user（迁到独立通道）
node-pi/server/src/services/platform/{plan-model,task-model}.ts · 移除 question 镜像字段
node-pi/server/eval/{harness,run}.mjs           · 注入提问通道 + ask-user-roundtrip 用例
node-pi/server/spike/07-plan-tool-loop.mjs      · 改用共用 harness；断言 ask_user 独立于 Plan
web/src/lib/agent-events.ts                     · question_pending/resolved 归约 + 载荷归一化
web/src/{types/index.ts,composables/useAgentSession.ts} · 类型 + answerQuestion + 刷新恢复弹窗
web/src/components/ChatWindow.vue               · 挂载弹窗
```

### M4.2 新增（MCP 模板库，2026-08-21）

```
node-pi/server/src/services/mcp/mcp-templates.ts  18 个模板 / 7 组 + 形状自检 + fixture 路径解析
node-pi/server/test/services/mcp-templates.test.ts
web/test/components/McpConfig.test.ts             模板库 6 例（此前没有该组件的测试）
```

### M4.2 改动（关键位置）

```
node-pi/server/src/routes/mcp.ts                     GET /api/mcp/templates
node-pi/server/src/services/mcp/mcp-client-manager.ts · args 也做 $ENV 插值（凭据不进配置文件）
web/src/components/McpConfig.vue                     模板库面板（分组/徽标/一键添加/填入表单）
web/src/{types/index.ts,lib/api.ts}                  McpTemplate 类型与 getMcpTemplates()
docs/node-mcp-guide.md                               §3 新增「推荐模板库」与推荐清单表
```

### M5 新增（子任务委派，2026-08-21）

```
node-pi/server/src/services/subagent-service.ts     子会话创建/预算/并发闸门/取消级联/buildExtension
node-pi/server/src/services/subagent-presets.ts     预设发现（用户级 agents/*.md + 项目级 .pi/agents/）+ 只读判定
node-pi/server/src/services/subagent-models.ts      预设 model 解析与「回退父会话模型」策略
node-pi/server/src/services/subagent-tools.ts       subagent 工具定义与结果渲染
web/src/components/SubagentCallBlock.vue            委派卡片（预设/深度/用量/轨迹/回退说明/摘要）
node-pi/server/test/services/subagent-{presets,models,service}.test.ts
node-pi/server/test/services/agent-registry-subagent.test.ts
web/test/components/SubagentCallBlock.test.ts
docs/node-subagent-m5.md                            实施说明（决策/契约/缺陷/验证/DoD）
```

### M5 改动（关键位置）

```
node-pi/server/src/services/agent-registry.ts       CreateSessionInput.subagent、子会话工具集特例、
                                                    INLINE_OWNED_EXTENSION_DIRS += subagent、
                                                    ledgerContext.parentRunId、abortSession() 级联、
                                                    announceApproval 挂父会话、useRuntime() 注入口
node-pi/server/src/services/tool-approval.ts        PendingToolApproval.parentSessionId/agent、setParentResolver、
                                                    decide() 父会话回退、cancelSession 连带子会话
node-pi/server/src/services/observability/session-ledger.ts  parentRunId→parent_run_id、currentRunId/lastRunId、meta 合并收尾
node-pi/server/src/services/platform/sqlite-trace-storage.ts · run 收尾不再抹掉开始时写入的 meta
node-pi/server/src/services/plan-mode-service.ts / plan-policy.ts  规划期委派门禁（只读预设）
node-pi/server/src/services/task-runner.ts          stop() 级联停子任务
node-pi/server/src/app.ts                           装配 SubagentService（延迟绑定）+ 只读预设判定注入
node-pi/server/eval/harness.mjs                     改用真实 OriginalPiSessionFactory（+ scriptedResponses）
node-pi/server/eval/run.mjs                         direct 模式 + 3 个委派用例 + 新门禁
web/src/components/ToolCallBlock.vue                分流到委派卡片
web/src/types/index.ts                              SubagentToolDetails
```

### 长会话修复（分支树扁平化，2026-09-10）

```
node-pi/server/src/services/session-tree.ts   flattenSessionTree()：嵌套树→扁平节点 + depth（显式栈）
node-pi/server/src/routes/sessions.ts         GET /:sessionId 的 tree 改用 flattenSessionTree()
node-pi/server/test/services/session-tree.test.ts    单测（5000 层不爆栈 / 先序 / 摘要 / 坏节点）
node-pi/server/test/routes/sessions-routes.test.ts   端到端回归（3000 条目会话必须 200）
web/src/lib/session-tree.ts                   toSessionTreeNodes()：兼容 Node 扁平与 Python 嵌套
web/src/lib/api.ts                            getSession() 在 API 层归一化
web/src/types/index.ts                        SessionTreeNode（扁平）/ LegacySessionTreeNode / SessionTreeInput
web/src/components/BranchNavigator.vue        只读扁平节点（不再递归拍平）
web/src/components/ChatWindow.vue             节点数直接取数组长度
web/test/lib/session-tree.test.ts             归一化单测
```

### 与前端共享的契约文件（任何接口改动都必须同步）

```
web/src/types/index.ts        PlanView/PlanStepView/PromptMode、TaskRecoveryItem、TaskRecord…
web/src/lib/api.ts            REST 封装（统一解析 ApiError）
web/src/lib/agent-events.ts   reduceAgentEvent（SSE → 状态规约）
web/src/composables/useAgentSession.ts   plan/task/recovery 三个独立 ref
web/src/components/{PlanProgress,TaskPanel,ChatWindow,ChatInput,AgentControls}.vue
```

---

## 9. 已知尚未处理（明确记录，避免重复发现）

| 项                                            | 说明                                                                                                                         | 归属   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| ~~P6：验证类命令被拦~~ | ✅ M4 已修：能力分类放行只读与验证类命令（`plan-policy.ts`），14 例测试固化 | 已完成 |
| ~~P2：计划靠正则解析~~ | ✅ M4 已删正则，改由 `submit_plan`/`complete_step` 工具产出与推进 | 已完成 |
| ~~P1：必须预开开关~~ | ✅ M4 已改为发送时选择（发送方式按钮 + `/plan` 前缀），新会话可规划 | 已完成 |
| `tool_execution_blocked` 分支 | 对 Node 后端永不触发（只存在于 Python 后端），保留是为了两种后端共用一套规约 | 可选 |
| JSONL 里的 plan 审计痕迹                      | `web-plan-context` 会留多条（模型侧已清理）；若要压缩 JSONL 可改为不持久化                                                   | 可选   |
| CLAUDE.md 曾提到 `node-pi/server/extensions/` | 该目录已不存在（改为内联扩展），已修正 CLAUDE.md                                                                             | 已处理 |
| 聚合时间分辨率只有「天 + cwd」 | 自定义小时级窗口会按整天计入（分位数仍按精确窗口取样本）；需要小时级时给预聚合表加 `hour` 分桶 | M3 可选 |
| 进程被强杀会留下 `running` run | 正常关闭会收尾为 `aborted`；异常退出的残留记录需要清理或恢复扫描 | M3 |
| 用量面板无实时刷新 | 目前手动刷新 + 切条件自动加载；未新增 SSE 事件（避免提前改前端契约） | M2/M3 可选 |
| 子会话没有专门的 UI 入口 | 只有工具卡片摘要 + 轨迹计数；子会话 JSONL 落在 `~/.pi/agent-node-server/subagents/`，侧栏会话树/回看页未做 | M5 可选 |
| 委派统计未进观测面板 | 子 run 已挂 `parent_run_id`、`meta` 记了 preset/depth，但面板还没有「按父 run 展开」的视图 | M5 可选 |
| 规划期不能委派带 bash 的预设 | 结构上只读才放行；你的 `scout.md` 带 bash，因此规划期被拦（执行期正常）。想放行就把它改为不带 bash | M5（刻意的约束） |
| ~~规划期拦截未做端到端验证~~ | ✅ M4 已在真实 SDK 下验证（spike ⑦ 断言规划期写工具被拦、验证命令放行） | 已完成 |
| 任务与 run 的关联时机 | 只在 run **开始**时写 `runs.task_id`；执行中绑定任务不会回溯已有 run | M3 可选 |
| ~~`verification` 只存不校验~~ | ✅ M4 起 `complete_step` 会按声明校验证据（file 查产物 / command 查退出码 / manual 要结论） | 已完成 |
| 任务面板无跨会话视图 | 面板只显示当前会话任务；`GET /api/tasks` 已支持跨会话查询，UI 按需再加 | 可选 |
| 计划面板不支持拖拽排序 | 重排接口（`PATCH position`）已就绪，UI 目前只做改名/跳过/删除 | 可选 |
| ~~`replan` 未实现~~ | ✅ M4 已实现：只对 `origin='plan'` 的任务开放，打回 `drafting` 让模型重交计划 | 已完成 |
| 一次 resume 只推进当前步骤 | 多步连跑依赖模型在会话里继续（eval 里由「继续执行」驱动，未自动连跑） | M5 可选 |
| 提问的答案不支持图片/文件 | 只支持选项与文本；要附件就让用户直接发消息 | 可选 |
| 同时只有一个挂起提问 | 前端只有一个弹窗；需要并行问多件事时放进同一次调用的 questions 数组（默认上限 8 题） | 可选 |
| 提问没有独立指标 | 提问与回答会作为普通会话事件进 M1 账本，但没有「提问耗时/回答率」这类统计 | 可选 |
| ~~ask_user 弹窗不显示~~ | ✅ 已修并真机验收（前端）：`assignStream` 逐字段拷贝漏掉 `pendingQuestion`，SSE 提问状态被静默丢弃；改为整对象拷贝 + 字段完整性/SSE 链路回归测试（`docs/node-question-channel.md` §5.1） | 已完成 |
| MCP 模板库不含 OAuth server | 仓库只支持静态请求头鉴权；要做 OAuth 交互授权是独立工作量 | 可选 |
| 模板库不支持自定义/分享 | 模板是仓库内常量表；用户自己的 server 仍走手工配置 | 可选 |
| Plan 模式仍拦 MCP 工具 | 规划期无法用 context7/搜索类 server 查资料；可给 `PlanPolicy` 加只读 MCP 白名单 | 可选 |
| 租约 TTL 写死 30s/10s | 暂不需要配置项；若将来要调，走 `PI_NODE_*` 并补文档 | 可选 |
| Python 后端仍返回嵌套会话树 | `session_detail()` 的 `tree` 是嵌套结构，`json.dumps` 在约千条消息的会话上 `RecursionError`；`pi-python` 已冻结，仅由前端归一化兜底（生产走 Node） | 冻结 |
