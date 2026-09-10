# M5：子任务委派（Subagent）实施说明

> 目标：让模型能把「自包含但会污染上下文」的活派出去做，**同时不失去**任何既有约束
> （审批、trace、任务、预算）。
>
> 对应规划：[`node-platform-plan.md`](node-platform-plan.md) §4.5。
> 前序：[`node-observability-m1.md`](node-observability-m1.md)（trace 底座）、
> [`node-task-domain-m2.md`](node-task-domain-m2.md)（任务领域）、
> [`node-task-recovery-m3.md`](node-task-recovery-m3.md)（租约/在飞动作）、
> [`node-plan-mode-m4.md`](node-plan-mode-m4.md)（Plan 契约）、
> [`node-question-channel.md`](node-question-channel.md)（人机交互通道）。

---

## 1. 为什么不是「把官方扩展接进来」

官方 `subagent` 文件扩展（用户级 `~/.pi/agent/extensions/subagent/`）的功能是完整的，
但它是**另一个进程里的另一个 pi**：

| 事实（实测） | 后果 |
| --- | --- |
| 四个预设都写死 `model: claude-sonnet-4-5` / `claude-haiku-4-5`，本机只鉴权了 `deepseek` | 子进程直接退出：`Model "claude-sonnet-4-5" is ambiguous across providers: anthropic/..., opencode/... No matching provider is authenticated` —— 委派 100% 失败，且看不出为什么 |
| `spawn('pi', ['--mode','json','-p','--no-session', …])` | 拿不到 Web 的审批通道、不进 M1 的 trace 树、不受 M3 的租约约束、不落盘（`--no-session` 连回看都没有） |
| 子进程只回 JSONL 事件流，用量靠父进程累加 | 我们的账本/指标看不到这次委派的成本；评测（faux provider 离线）更没法驱动它 |
| 它被 SDK 自动发现并加载进**每个** Web 会话 | 工具列表里出现一个必然报错的 `subagent`，模型会反复踩 |

所以结论是**内联实现 + 同名接管**：注册自己的 `subagent` 工具，并把 `subagent` 加进
`INLINE_OWNED_EXTENSION_DIRS`——这是 M4 对 `plan-mode` 用过的同一机制：
**只影响本服务的资源加载，不动你磁盘上的文件，CLI 照常加载它自己的那份**。

---

## 2. 架构：子会话就是一个会话

```
父会话（AgentRegistry 里的普通条目）
  │  模型调用 subagent 工具
  ▼
SubagentService.run(request)                        services/subagent-service.ts
  ├─ 预设发现（~/.pi/agent/agents/*.md + {cwd}/.pi/agents/*.md）   subagent-presets.ts
  ├─ 模型解析（解析不到就回退父会话模型 + 说明原因）                subagent-models.ts
  ├─ 并发闸门（全局 3 / 每父会话 4，超限排队）
  ├─ 预算（轮数 / token / 成本 / 时限，按事件计数，硬中止）
  ├─ 子会话创建：registry.create({ …, subagent: { parentSessionId, parentRunId, preset, depth } })
  │     └─ OriginalPiSessionFactory：SessionManager.create(cwd, <私有目录>, { parentSession })
  │        工具集 = 预设工具集（不并入 MCP / 计划 / ask_user / subagent）
  │        扩展集 = { approval: true, planMode: false, questions: false }
  ├─ await child.prompt(task)  ← 子会话跑完（含自动重试/压缩收敛）
  └─ 摘要（截断 8000 字符）+ 用量 + 轨迹 → 工具结果
```

关键点：**子会话走的是和用户会话完全一样的创建路径**（`AgentRegistry.create` →
`OriginalPiSessionFactory.create` → `createAgentSession` → `bindExtensions`），
因此审批、SSE、账本、任务绑定天然生效，不需要为它开任何旁路。

### 2.1 三条不变量

1. **不能递归是结构保证**：`depth >= maxDepth`（默认 1）的子会话，`loader()`
   根本不注册 `subagent` 扩展——模型连「试一下」的机会都没有，而不是运行时拦截。
2. **只读预设真的只读**：子会话的工具白名单就是预设的工具白名单，
   **不并入** MCP 工具 / 计划工具 / `ask_user`，否则「scout」会悄悄拿到写能力。
3. **一定要收尾**：成功 / 失败 / 超预算 / 超时 / 取消 / 服务关闭，子会话都会被
   `registry.remove()` 释放（JSONL 留在磁盘上供回看）。

### 2.2 文件与契约

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 预设 | `services/subagent-presets.ts` | `discoverSubagentPresets` / `isReadOnlyPreset`；与官方扩展同契约（frontmatter: `name`/`description`/`tools`/`model` + 正文即系统提示词）；项目级同名覆盖用户级 |
| 模型 | `services/subagent-models.ts` | `resolveSubagentModel`：`provider/model` 要求已鉴权；裸 id 要求唯一命中且已鉴权；否则**回退父会话模型并在结果里说明** |
| 服务 | `services/subagent-service.ts` | `SubagentService`：`run()` / `abortAll()` / `abortAllSessions()` / `listForSession()` / `listPresets()` / `isReadOnlyPreset()` / `buildExtension({ depth })` |
| 工具 | `services/subagent-tools.ts` | `SUBAGENT_TOOL_NAME='subagent'`、参数 schema、结果渲染、`executionMode: 'parallel'` |
| 接线 | `services/agent-registry.ts` | `CreateSessionInput.subagent`（`SubagentLink`）、`RegistryEntry.subagent`、`excludeTools`、子会话工具集特例、`ledgerContext` 带上 `parentRunId`/预设/深度、`abortSession()` 级联、`announceApproval` 挂到父会话 |
| 接线 | `services/tool-approval.ts` | `PendingToolApproval.parentSessionId/agent`、`setParentResolver`、`decide` 的父会话回退查找、`cancelSession` 连带子会话 |
| 接线 | `services/observability/session-ledger.ts` | `LedgerSessionContext.parentRunId` → `runs.parent_run_id`；`currentRunId` / `lastRunId` |
| 接线 | `services/plan-mode-service.ts` + `plan-policy.ts` | 规划期委派门禁（`allowSubagentDelegation` + 只读预设判定） |
| 前端 | `web/src/components/SubagentCallBlock.vue` | 委派卡片（预设/深度/用量/轨迹/回退说明/摘要） |

#### 工具契约

```ts
subagent({
  preset: string,          // ~/.pi/agent/agents/*.md 里的 name
  task: string,            // 自包含说明（子会话看不到父会话的上下文）
  cwd?: string,            // 默认当前工作区；非绝对路径直接拒绝
  model?: string,          // provider/model、裸 id 或 inherit
  budget?: { maxTurns?, maxTokens?, maxCostUsd?, timeoutMs? },
})
```

- **不做 chain / parallel 参数**：一次调用 = 一个子任务；并行由模型在同一轮里发多个调用
  （`executionMode: 'parallel'`），服务端按并发上限排队。少一个参数维度就少一类
  「参数写错却看起来在跑」的失败。
- 返回文本以 `[子任务 完成|超预算中止|超时中止|已取消|失败] 预设 <name>（深度 n）` 开头，
  随后是模型 / 用量 / 轨迹 / 摘要；**失败/超预算/超时是「结果」而不是「异常」**
  （只有「连子会话都没起来」才抛错），这样父会话能自己决定重试、换预设还是自己干。
- 工具结果 `details`（前端与 trace 用）：`status`/`preset`/`depth`/`subagentSessionId`/
  `runId`/`model`/`usage`/`durationMs`/`trajectory`/`note`/`reason`。

#### SSE 契约（唯一改动）

`tool_call_pending` 增加三个**可选**字段（老客户端忽略即可）：

| 字段 | 含义 |
| --- | --- |
| `sessionId` | 真正要执行工具的会话（子会话 id） |
| `parentSessionId` | 弹窗显示在哪个会话上 |
| `agent` | 子会话的预设名（弹窗上写「子任务 scout 请求执行 …」） |

`approve_tool` 命令不变：前端仍然只发 `{ toolCallId, approved }` 到**父会话**，
审批中枢按「这个挂起项属于该父会话」回退匹配（见 §4）。

---

## 3. 已冻结的决策（开工前定的 4 项）

| # | 决策 | 取值 | 理由 |
| --- | --- | --- | --- |
| 1 | 官方扩展的去留 | **内联替换 + 同名接管** | 保留共存 = 保留一个必然报错的工具；按预设切换 = 两套行为 |
| 2 | 工具名 | **`subagent`** | 与 CLI/官方一致；叫 `task` 会和 M2 的任务领域（`taskId`/租约）撞概念 |
| 3 | 预设来源 | **只用 `~/.pi/agent/agents/*.md` + 项目级 `.pi/agents/`** | 用户已有的 scout/planner/reviewer/worker 直接可用；CLI 与 Web 共享同一份定义；不引入 `explore`/`verify`/`general` 第二套名字 |
| 4 | 预设 `model:` 解析 | **能解析就用，解析不了回退父会话模型 + 说明** | 官方扩展就是死在这里（预设写死 claude-\*，本机只有 deepseek）；静默回退比整条链路哑掉好，必须让人看见 |

### 实施中定的默认值

| 事项 | 默认 | 说明 |
| --- | --- | --- |
| 子会话落盘 | `~/.pi/agent-node-server/subagents/` | 可查、可展开；**不进 CLI 的会话列表**（共享 `~/.pi/agent/sessions` 会让 CLI 凭空多出一堆子会话） |
| 预算计量 | 轮数 + token + 时限为主，成本仅当 provider 上报时才生效 | 本机 deepseek 上报的 `cost.total` 恒为 0，只靠美元上限等于没有预算 |
| 预算默认值 | scout 12 轮 / planner 8 / reviewer 8 / worker 20；token 10 万–30 万；时限 10 分钟 | 按预设档位给默认，工具参数可覆盖 |
| 并发 | 全局 3、每父会话 4，超限**排队** | 子任务不该因为「同时有 4 个」直接失败 |
| 深度 | 1（子会话不能再委派） | 结构保证，见 §2.1 |
| Plan 期委派 | 只放行**结构上只读**的预设（`tools ⊆ read/grep/find/ls`） | 子会话是独立会话、不受计划策略约束，所以不能信任预设的自觉 |
| 子会话能否 `ask_user` | 不能（不注入提问扩展） | 弹窗归属会混乱、父会话被卡住；让它「返回摘要说明缺什么」 |
| 危险命令审批 | 共用同一个 `ToolApprovalBroker`，弹窗在**父会话**界面 | 权限继承，子会话无法绕过 |
| 取消级联 | 父 abort / 计划暂停·放弃 / 会话删除 / 服务关闭 / `TaskRunner.stop` | 任一入口漏掉都会留下还在改工作区的子任务 |

> ⚠️ **注意**：你现在的 `scout.md` 带 `bash`，因此**规划期**会被拦（执行期正常）。
> 想让 scout 在规划期也能用，把它的 `tools` 里的 `bash` 去掉即可（或改用 `planner`）。

---

## 4. 实施中发现的真实缺陷（单测全绿也发现不了）

1. **子会话审批发到了没人订阅的流上**（早期版本）：`announceApproval` 只按
   `pending.sessionId` 找条目 → 子会话的流没有订阅者 → 用户看不到弹窗 → 30 秒超时按拒绝处理，
   表现为「委派莫名其妙失败」。修法：`PendingToolApproval` 带上 `parentSessionId`/`agent`，
   事件发到**父会话**的流，`decide()` 增加父会话回退查找。
2. **`finishRun` 抹掉 run 的元信息**（M1 遗留，M5 才暴露）：`UPDATE runs … meta = :meta`
   在收尾时不带 meta 就写 NULL，于是 `runs.meta` 里 run 开始时写入的
   `{parentSessionId, preset, depth}` 全丢，执行树看不出「谁派出来的」。
   修法：SQL 改 `meta = CASE WHEN :meta IS NULL THEN meta ELSE :meta END`，
   内存后端同步；账本收尾改为与开始时的 meta **合并**（`retries` 不再覆盖）。
3. **预设白名单与内联工具的冲突**（M4 发现的同一类问题，M5 反向利用）：
   `withInlineTools` 会把 MCP/计划/ask_user 并入白名单——对**子会话**必须关掉这个行为，
   否则「只读预设」会悄悄拿到 MCP 与写工具。
4. **子会话工具结果里塞进了完整 Model 对象**：`resolveSubagentModel` 返回的是
   `runtime.getModel()` 的 `Model`（含 `baseUrl`/`api`/`cost` 等），一路带到了前端与
   trace；修法：服务侧规整为 `{provider, id}`、工具侧给前端的 `details` 用 `{provider, modelId}`。

---

## 5. 验证

### 单测（Node 368 passed，+36 相对 M4.1 基线）

| 文件 | 覆盖 |
| --- | --- |
| `test/services/subagent-presets.test.ts` | frontmatter 解析、缺 name/description 跳过、项目级覆盖用户级、向上查找、只读判定 |
| `test/services/subagent-models.test.ts` | `provider/model` 已鉴权/未鉴权、裸 id 唯一/同名多 provider、模型不存在、无目录可校验、无父模型 |
| `test/services/subagent-service.test.ts` | 子会话创建输入（落盘目录/扩展集/工具集/深度/parentSession）、摘要与用量、工具轨迹、**超轮数/超 token/超时中止**、模型报错、未知预设、超深度拒绝、未装配时 unavailable、并发排队（全局+每父会话）、abortAll（在跑+排队）、signal 取消、服务关闭 |
| `test/services/tool-approval.test.ts` | 子会话审批打上父会话与预设、父会话可结算子会话挂起项、无关会话仍 404、父会话关闭连带结算 |
| `test/services/agent-registry-subagent.test.ts` | 子会话审批发到父会话流（含字段）、顶层会话不带 parentSessionId、父取消连带拒绝、**子 run 挂到父 run + meta**、子会话继承父任务 |
| `test/services/plan-mode.test.ts` | 规划期只放行只读预设（未注入判定器时一律拦）、策略关闭委派时拦 |
| `test/services/task-runner.test.ts` | `stop()` 级联停子任务 |
| `test/services/platform/trace-store.test.ts` | 回归：run 开始时写入的 meta 在收尾时不被抹掉 |

### 离线评测（`npm run eval`：11/11 + 四项门禁）

新增 3 个用例，全部走**真实工厂**（见下）：

- `subagent-delegation`：委派 scout → 子会话跑 bash → 只回摘要；断言工具结果非错、
  子 run 的 `parent_run_id` 指向父 run、**父会话上下文里没有子会话的执行细节**。
- `subagent-preset-isolation`：子会话工具集 == 预设工具集、没有 `subagent`/`ask_user`、
  落盘在 subagents 下、深度 1。
- `subagent-budget`：`maxTurns: 1` 时第二轮即中止，状态是结果而不是异常，摘要照样带回。

门禁新增「**子任务 trace 关联率**」（子任务数 / 已挂进执行树 ≥ 100%，当前 3/3）。

> 顺带把 `eval/harness.mjs` 从「手写的假工厂」换成**真实的 `OriginalPiSessionFactory`**
> （新增 `useRuntime()` 注入口，只换模型运行时）。原来的假工厂自己拼
> `createAgentSession`，子会话根本不在那条路径上——不换掉的话，M5 的评测只是在验证
> 评测自己的实现。

### 真机（你的 8001 实例 + 真实 deepseek）

一条 prompt：「用 subagent 工具把子任务委派给 scout：统计 node-pi/server/src/services
下的 .ts 文件数量」。观察到：

- 工具列表里 `subagent` **只有一个**（官方文件扩展被屏蔽，CLI 不受影响）；
- 模型自己调用 `subagent` → 子会话 3 轮、`bash×2`、返回摘要「共有 45 个 .ts 文件」；
- 工具结果里带 `注意：预设模型「claude-haiku-4-5」在本机不可用，改用父会话模型`
  与用量（↑743 ↓193 tokens / 3s / $0.0000）——**这正是官方扩展哑掉的那一步**；
- 父会话随后**自己用 bash 复核**了数字（系统提示词里的「把它当作线索而不是结论」生效）；
- 平台库里：子 run `parent_run_id` → 父 run，`meta` = `{parentSessionId, preset: "scout", depth: 1}`；
  父/子 run 分别记了 token 用量（成本归因可见）。

---

## 6. DoD 对照

| 规划 §4.5 的要求 | 状态 |
| --- | --- |
| `task` 工具 + 按预设创建子会话 | ✅ 工具名为 `subagent`（决策 2），`SubagentService` 按预设建子会话 |
| 预算隔离（token/成本/步数） | ✅ 轮数 + token + 成本 + 时限，超限 abort 并如实上报状态 |
| 权限继承（同一 broker） | ✅ 共用 broker，弹窗挂到父会话，`approve_tool` 走父会话 id |
| 取消传播（父 abort / 任务 cancel / 服务关闭） | ✅ `abortSession()` 统一入口 + `remove` / `close` / `TaskRunner.stop` |
| trace 树（`parent_run_id`） | ✅ 真串起来，并在 meta 里记 preset/depth |
| 前端可视化（在任务面板里展开） | ⚠️ 落在**工具卡片**里（`SubagentCallBlock.vue`），没做侧栏会话树：v1 够用，避免过早加树形 UI |
| 评测纳入 golden set | ✅ 3 用例 + 新门禁（子任务 trace 关联率） |
| 不与官方扩展同时注册同名工具 | ✅ 同名接管（`INLINE_OWNED_EXTENSION_DIRS`） |
| 子会话遵守 M4 的 Plan 契约 | ⚠️ 子会话**关掉**了 Plan（`planMode: false`）：子任务自己再起一个计划状态机只会让「谁在等我确认」变模糊。规划期委派由父会话的策略门禁管控（只读预设） |

### 已知未做（可选，未承诺）

- 侧栏会话树（子会话缩进展示）：子会话落盘了、API 也能读到，但没有专门的入口 UI。
- 子会话轨迹回看界面：目前只在工具卡片里给摘要 + 轨迹计数，完整 JSONL 在
  `~/.pi/agent-node-server/subagents/` 下（可用 MCP `sqlite`/`filesystem` 或直接读文件看）。
- 委派统计（次数/平均成本/被预算截断比例）进观测面板：子任务已进 trace 树，
  但面板还没有「按 parent_run_id 分组」的视图。
