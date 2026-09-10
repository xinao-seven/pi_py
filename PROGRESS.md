# 项目进度（PROGRESS）

> **新会话请先读本文件**，再读 `CLAUDE.md`（行为准则）与 `docs/node-platform-plan.md`（完整规划）。
> 本文件只记录"现在在哪、下一步做什么、哪些决策已经冻结"，不重复规划内容。

|            |                                                                 |
| ---------- | --------------------------------------------------------------- |
| 当前里程碑 | **M0 已完成** → 下一步 **M1 可观测底座**                        |
| 上一提交   | `40063e2 docs: 记录 M0 验证结论、Plan 扩展归属决策与平台化规划` |
| 运行时     | Node **v24.18.0**（`node:sqlite` 可用，带 experimental 警告）   |
| 测试基线   | Node 后端 **84** / Web **55**，全绿                             |
| 工作分支   | `master`                                                        |

---

## 1. 协作约定（用户明确要求，必须遵守）

1. **每完成或修复一个问题，就立即 git 提交**，按 Conventional Commits 写中文描述，一个提交只做一件事，代码与文档分开提交。
2. **每个改动都要在 `docs/` 下写一份说明文档**，讲清"如何实现的"，并在 `README.md` / `CLAUDE.md` 的文档索引里登记。
3. **不得影响 CLI 上运行的原版 pi**。边界见第 4 节，是硬约束。
4. 提交时**不要**带上 `interview-qa.md` 与 `pi_design.md`（用户自己的改动，与本项目工作无关）。

---

## 2. 里程碑状态

| 里程碑                  | 状态        | 说明                                  |
| ----------------------- | ----------- | ------------------------------------- |
| **M0** 验证性 spike     | ✅ **完成** | 4 项验证 + 2 个阻塞性修复 + CI        |
| **M0.5** 持久化边界整改 | ✅ **取消** | 重新审计后无阻塞项，详见 3.2          |
| **M1** 可观测底座       | ⬜ 下一步   | 见第 5 节                             |
| M2 任务领域             | ⬜          | 依赖 M1                               |
| M3 断点续跑             | ⬜          | 依赖 M2                               |
| M4 Plan 重构            | ⬜          | 依赖 M3；**前置项已完成**（见 3.3）   |
| M5 Subagent             | ⬜          | 需先决策与官方扩展的关系（见第 6 节） |

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

### 3.5 M1 的存储选型（已冻结，`docs/node-platform-m0-spike.md` §2）

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

## 4. 硬约束速查：与原版 pi 的边界

```
共享态（可以增量写，禁止破坏性写）
├── auth.json          只读
├── settings.json      只读
├── models.json        读 + 增量写（spread 保留未知字段 + 原子写 + 校验前置）
├── models-store.json  只读
└── sessions/*.jsonl   读 + 新增 + 追加；禁止删除、禁止改写既有 header

项目私有态（pi 不认识）
├── trace / tasks      →  ~/.pi/agent-node-server/platform.db   【M1 新建】
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

## 5. 下一步：M1 可观测底座

### 5.1 任务清单

| 任务                                                                                            | 落点（新增）                                                                        |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| SQLite/内存双实现 + 写入队列（250ms / 200 条 batch）                                            | `services/platform/store.ts`                                                        |
| 建表与版本迁移（`runs` / `steps` + 索引）                                                       | `services/platform/migrations.ts`                                                   |
| 事件 → runs/steps（**fire-and-forget，异常吞掉**）                                              | `services/observability/session-ledger.ts`                                          |
| 聚合查询 + 预聚合表                                                                             | `services/observability/metrics.ts`                                                 |
| 脱敏 + digest（`sha256(content).slice(0,12)`）                                                  | `services/observability/redact.ts`                                                  |
| provider 层钩子（TTFT / HTTP status）                                                           | `services/observability/observability-extension.ts`                                 |
| 4 个 REST                                                                                       | `routes/observability.ts`                                                           |
| `PI_NODE_TRACE_*` / `PI_NODE_STORE` 配置                                                        | 改 `config.ts`                                                                      |
| **零成本修复**：`agent-registry.ts` `state()` 里硬编码的 `contextUsage: null, sessionStats: {}` | 改 `agent-registry.ts`                                                              |
| 前端 Dashboard                                                                                  | 新增 `web/src/components/ObservabilityPanel.vue`，改 `types/index.ts`、`lib/api.ts` |

### 5.2 必须遵守的实现要点

1. **唯一插桩点**：`AgentRegistry.publish()` 尾部调用 `ledger.record(entry, payload)`。
2. **`steps` 表必须区分「策略阻断」与「工具失败」**（新增 `blocked_by` 字段）。见 3.1 的修正 ④。
3. **零成本修复**：`PiSession` 门面补 `getSessionStats?()` / `getContextUsage?()`，`state()` 有则透传、
   无则保持 `null` / `{}`（与 Python 后端字段兼容）。M0 已实测这两个 API 存在且返回
   `{ tokens, contextWindow, percent }`，前端 `AgentControls.vue` 的上下文仪表盘会立即有数据。
4. **性能**：写入不是瓶颈（0.65ms），**聚合才是**（无索引 96ms）。读路径必须走预聚合表。
5. **降级**：`PI_NODE_STORE=memory` 时整体降级为内存实现，保证测试与无盘环境可用。
6. **REST 契约**（必须同步 `web/src/lib/api.ts`、`web/src/lib/agent-events.ts`、Pinia store）：
   - `GET /api/observability/summary?from&to&cwd`
   - `GET /api/observability/runs?sessionId&taskId&limit&cursor`
   - `GET /api/observability/runs/:runId`
   - `DELETE /api/observability/runs?before=<iso>`
   - `summary` 返回 `{ totals, byModel[], byTool[], byApproval[], daily[] }`（字段清单见规划 §4.1.4）

### 5.3 M1 的 DoD

- 跑一个真实会话后，Dashboard 能显示成本、p95 延迟、工具成功率、审批命中率。
- 前端上下文仪表盘显示真实占用。
- 关掉 trace 配置后行为与今天完全一致（回归测试证明）。
- `1000 次 record()` 同步耗时 p95 < 5ms；写入 mock 故意抛错后 agent loop 仍能正常跑完。

### 5.4 开工前的建议检查

`parentSessionPath` 在 M0 已确认可用，但 M1 的 `runs` 表要预留 `parent_run_id`（M5 用），
建表时就加上，避免 M5 再迁移。

---

## 6. 待用户决策

| #   | 事项                           | 选项                                                                  | 影响                                                                                                                                                                                                                       |
| --- | ------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **官方 `subagent` 扩展的去留** | (a) 保留共存 (b) 内联实现替换 (c) 按预设开关切换                      | M5。现状：它注册工具 `subagent`，spawn 独立 `pi` 子进程，**拿不到 Web 审批通道、不进 trace 树**。建议复用 `~/.pi/agent/agents/*.md` 的 `scout`/`planner`/`reviewer`/`worker` 预设，而不是另起 `explore`/`verify`/`general` |
| 2   | 会话删除的加固                 | 两阶段提交 + 移入 trash                                               | 非阻塞，可 M2/M3 顺带                                                                                                                                                                                                      |
| 3   | PI 命名空间                    | `mcp.json` / `node-server-*.json` 是否迁到 `~/.pi/agent-node-server/` | 仅卫生，无功能风险                                                                                                                                                                                                         |

---

## 7. 验证命令

```powershell
# Node 后端（工作目录 node-pi/server）
npm run format:check && npm run typecheck && npm test && npm run build && npm run spike
#   → 期望：format OK / 无类型错误 / 84 passed / 构建成功 / 8 个 spike 全过

# 前端（工作目录 web）
npm run typecheck && npm run lint && npm test && npm run build
#   → 期望：无类型错误 / 0 error（有 3 个既有 warning）/ 55 passed / 构建成功

# 起服务
cd node-pi/server && npm run dev      # http://127.0.0.1:8001
cd web && npm run dev                 # http://127.0.0.1:5173
```

> **spike 的意义**：`npm run spike` 里的 8 个脚本是**能力守护**，不是探索脚本。
> 依赖升级若破坏 `fauxProvider` 可解析性、`node:sqlite`、父子会话或钩子链语义，
> 它会立刻失败。改动 `package.json` 依赖后必须跑一遍。

---

## 8. 文件地图

### 本次新增

```
.github/workflows/ci.yml                      CI 三 job
node-pi/server/.prettierignore                排除 dist/，修掉原本红色的 format:check
node-pi/server/spike/00..06-plan-session-start.mjs   8 个 M0 验证/守护脚本
node-pi/server/test/services/agent-registry-extensions.test.ts
docs/node-platform-plan.md                    用户提供的平台化规划（M0–M5）
docs/node-platform-m0-spike.md                M0 报告：验证结论 + 边界审计 + 存储选型
docs/node-plan-extension-ownership.md         Plan 扩展归属决策 + session_start 修复
PROGRESS.md                                   本文件
```

### 本次改动（关键位置）

```
node-pi/server/src/services/agent-registry.ts
  · PiSession.bindExtensions 门面            · register() 派发 session_start
  · INLINE_OWNED_EXTENSION_DIRS / dropInlineOwnedExtensions（已导出）
  · loader() 接入 extensionsOverride          · 新增可选 logger 参数
  · publish()                        ← M1 的唯一插桩点
  · state() 的 contextUsage/sessionStats  ← M1 零成本修复目标
node-pi/server/src/services/plan-mode-service.ts
  · 新增 context 钩子                  · M4 要删除 extractPlan/markDone/[DONE:n]
node-pi/server/src/app.ts
  · OriginalPiSessionFactory 传入 app.log     · onReady 钩子 ← M3 恢复扫描接入点
node-pi/server/package.json
  · devDep @earendil-works/pi-ai@0.83.0       · npm run spike
```

### 与前端共享的契约文件（任何接口改动都必须同步）

```
web/src/types/index.ts        PlanMode/PlanTodo/PlanSnapshot  ← M4 替换为 PlanView
web/src/lib/api.ts            REST 封装
web/src/lib/agent-events.ts   reduceAgentEvent（SSE → 状态规约）
web/src/composables/useAgentSession.ts
web/src/components/{PlanProgress,ChatWindow,ChatInput,AgentControls}.vue   ← M4 改造目标
```

---

## 9. 已知尚未处理（明确记录，避免重复发现）

| 项                                            | 说明                                                                                                                         | 归属   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| P6：验证类命令被拦                            | `isSafePlanCommand()` 不含 `tsc --noEmit` / `pnpm test` / `npm run build`。M0 已确认官方白名单同样不含，**这是唯一剩余成因** | M4     |
| P2：计划靠正则解析                            | `extractPlan()` / `markDone()` / `[DONE:n]` 待换成结构化工具契约                                                             | M4     |
| P1：必须预开开关                              | `AgentControls.vue` 的 Plan 预开关待改为发送时的 `mode`                                                                      | M4     |
| 前端死代码                                    | `agent-events.ts` 的 `case 'tool_execution_blocked'` 对 Node 后端永不触发（该事件只存在于 Python 后端）                      | M4     |
| JSONL 里的 plan 审计痕迹                      | `web-plan-context` 会留多条（模型侧已清理）；若要压缩 JSONL 可改为不持久化                                                   | 可选   |
| CLAUDE.md 曾提到 `node-pi/server/extensions/` | 该目录已不存在（改为内联扩展），已修正 CLAUDE.md                                                                             | 已处理 |
