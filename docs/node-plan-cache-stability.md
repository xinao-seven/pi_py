# Plan 模式的缓存稳定性 + `propose_plan`（模型提议、用户拍板）

> 类型：行为变更（Plan 工具激活策略 + 新增 `propose_plan`）+ 前端展示补充。
> 三条 M4 不变量一条没动：**只有用户能确认执行**、**步骤完成必须有证据**、**规划期只读**。

## 1. 问题：开关 Plan 会打掉整段前缀缓存

请求体顺序是 `[tools…, system, messages…]`，而前缀缓存（prompt caching）从**最前面**开始比对：

| 事实 | 证据 |
| --- | --- |
| 改 `activeTools` 会重建 system prompt（含 `Available tools` 列表） | `agent-session.js:643` → `_rebuildSystemPrompt()`；`system-prompt.js:40-43` |
| anthropic 系在 **tools 尾 / system / 最后一条 user** 三处打 `cache_control`；最前面一变，后面的断点也全部失效 | `pi-ai/dist/api/anthropic-messages.js:968-1019`、`openai-completions.js:691-700` |
| DeepSeek（本项目默认 `openai-completions` + 未配 `cacheControlFormat`）走**自动前缀缓存**，同样要求前缀逐字节一致 | `~/.pi/agent/models.json`；`openai-completions.js:1065` 解析 `prompt_cache_hit_tokens` |

旧实现对工具列表动手的时机（`plan-mode-service.ts` 的 `applyPlanTools` / `restorePlanTools`）：

1. 会话创建：白名单并入 4 个计划工具（`agent-registry.ts` 的 `withInlineTools`）→ 它们**从第一轮就激活**；
2. `plan_start`：关掉 `edit` / `write`（+MCP）；
3. 计划结束（完成/放弃）：`edit` / `write` 回来、4 个计划工具**收回**。

一次计划 2~4 次列表变化 = 2~4 次**整段前缀 miss**（tools 变了，后面所有断点也失效）。

## 2. 更贵的第二个漏点：计划上下文的「每轮删旧加新」

`before_agent_start` 每轮注入一条规划/执行上下文，`onContext` 又把旧的**全删掉**（只留最后一条）。
而 custom 消息会被转成 **user 消息夹进历史中间**（`pi-agent-core` `harness/messages.js:70-77`）：

```
第 1 轮: […, U1, Ctx₁]           ← 注入在用户消息之后
第 2 轮: […, U1, A1, U2, Ctx₂]   ← Ctx₁ 被删掉
                    ↑ 与上一轮的公共前缀在 Ctx₁ 的位置就断了
```

于是规划期间**每一轮都从计划开始处整段重算**——计划越久越贵，比工具列表抖动贵得多。

## 3. 修法

### A. 工具集恒定（`plan-mode-service.ts`）

计划生命周期**完全不再调用 `setActiveTools`**：差集相关的 `toolsAdded` / `toolsDisabled` /
`applyPlanTools` / `restorePlanTools` 全部删除。规划期只读由 `evaluateToolCall`（`tool_call` 钩子）
兑现——它本来就是「权限的最终约束点」，覆盖 `edit/write`、`mcp__*`、`subagent` 只读预设、`bash` 能力分类。

- **代价（刻意接受）**：模型在规划期会「看得到」写工具，可能试一次并被拦（多一轮 + 一条
  可读的 block 理由）。一次被拦的调用远比整段前缀失配便宜。
- **收益**：`tools` + system prompt 在整个会话生命周期内恒定（除了用户显式 `set_tools` / MCP 配置变更）。

### B. 注入去抖（`beforeAgentStart`）

注入前先读历史里**最后一条同类注入**的正文（`sessionManager.getEntries()` → `custom_message`），
内容相同就返回 `undefined`＝不注入。于是：

- 状态没变：历史一字不动 → 前缀连续，缓存命中；
- 状态跃迁（drafting → proposed → executing / paused，或 revision 变化）：改写一次 → 每次计划最多 2~3 次失配。

`onContext` 的「同类只留最后一条」保留（清历史遗留 + 防膨胀）。

### C1. `propose_plan`：提议权给模型，决定权留给用户

新增第 5 个计划工具（`plan-tools.ts` 定义文案，`plan-mode-service.ts` 实现）：

| 参数 | 行为 |
| --- | --- |
| `{ goal?, reason? }` | 走提问通道（`QuestionBroker`）问一句：「要不要先进入规划模式？」，选项 `先规划` / `直接做` |

- 用户选**先规划** → 服务端 `startPlanning(goal ?? 最近一条用户消息)` → 工具结果里直接带上规划期说明
  （`buildPlanningContext`），模型本轮就知道下一步是调研 + `submit_plan`；
- 用户选**直接做** / 超时未答 / 取消 → 如实汇报「按不规划处理」，**不建计划、不进只读态**；
- 会话已有计划（drafting/proposed/executing/paused）→ 抛错让模型改用 `submit_plan` / `update_plan`；
- 未接入提问通道（测试/自定义装配）→ 返回 `status: 'unavailable'`，不把工具弄成错误。

为什么不做「`submit_plan` 无计划时自建」（更自动的那档）：简单任务也会弹确认面板（过度规划），
且模型一提计划就把自己锁进只读态直到用户确认（自锁）。C1 不动这两条风险，也不需要任何新的
SSE / REST / 前端契约——提问弹窗与 `plan_updated` 都是现成的。

## 4. 验证证据

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm test`（node-pi/server） | exit 0；**379** 用例全绿（含 6 条新增） |
| `npm run spike` | **36** 项断言全绿（原 30 项 + 新增 6 项），第 ⑦ 个 spike 新增「工具集一字不变」与 `propose_plan` 端到端 |
| `npm run eval` | **12/12** pass@1（新增 `propose-plan-accepted`），三项门禁全过 |
| `npm run typecheck / lint / test`（web） | exit 0；**134** 用例全绿（新增缓存命中率 2 条） |

新增/改写的关键断言：

- `test/services/plan-mode.test.ts`：计划全生命周期 `setActiveTools` **从未被调用**；用户 `set_tools`
  的改动一字不动；`propose_plan` 的同意 / 拒绝 / 超时 / 已有计划 / 无通道五条分支；注入去抖（内容相同不注入、状态变了才注入）。
- `spike/07-plan-tool-loop.mjs`：规划期、执行期、计划完成、放弃后四个时点的工具列表**完全一致**；
  规划期 `edit` 的 `tool_call` 确实被 block；`propose_plan` 在真实 SDK 会话里挂起 → 回答 → 开启规划。
- `test/services/agent-registry-factory.test.ts`：白名单顺序即请求里的工具数组顺序（`propose_plan` 在最前）。

## 5. 怎么量化效果

「用量」面板新增 **缓存命中** KPI：`cacheReadTokens / (inputTokens + cacheReadTokens)`。
`inputTokens` 已扣除命中部分（`pi-ai` 的解析口径），所以分母就是实际发出的提示词总量。
改工具集 / 系统提示词一类的优化，看这个数字前后对比即可（同一会话、同等轮数下比较）。

## 6. 已知限制

1. 规划期模型可能**尝试**一次写工具再被拦——这是换取缓存稳定性的显式取舍；拦截理由文本里已写明
   「先让用户确认执行（plan_execute）」，模型据此改用只读方式或等确认。
2. 计划上下文在**状态跃迁**时仍会改写一次（revision / 状态变化），该处的历史前缀会失配一次；
   与「每轮失配」相比已从 O(轮数) 降到 O(状态数)。
3. 用户显式 `set_tools`、MCP server 增删（`reload_resources`）仍会改变工具数组——那是用户的显式动作，
   不在本次优化范围内（面板的命中率会如实反映出来）。
