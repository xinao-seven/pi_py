# M4 Plan 模式重构：实现说明

更新日期：2026-08-21
适用范围：`node-pi/server/src/services/{plan-mode-service,plan-tools,plan-policy,plan-model,step-verification}.ts`
+ `web/src/components/{PlanProgress,ChatInput,ChatWindow,AgentControls}.vue`
对外契约：[`node-web-plan-mode.md`](node-web-plan-mode.md)（本文讲「为什么这么做」与验证证据）

---

## 1. 为什么重构：8 个缺陷与一个根因

M4 之前，Plan 模式把**状态机的迁移条件交给了模型的文风**：

| # | 缺陷 | 后果 |
| --- | --- | --- |
| P1 | 必须先开全局开关、再发消息；新会话无法规划 | 顺序错了白跑一回合；心智与「先表达意图」相反 |
| **P2（根因）** | 计划靠正则从回答里抠 `Plan:` 列表 | 模型不写标题 → 解析不到 → 「确认并执行」必然 409，面板永远停在「正在生成计划」 |
| P3 | 步骤完成靠模型写 `[DONE:n]` | 漏写一次执行态永不收敛；系统层面对「完成」没有任何验证能力 |
| P4 | 执行期不可修改、不可暂停 | 第 3 步发现第 5 步方案不对，只能 abort 或退出；退出后计划蒸发 |
| P5 | 每次状态变化都往 JSONL 追加完整快照 | JSONL 膨胀，而界面上没有任何历史计划 |
| P6 | 工具权限用「快照 + 无条件恢复」 | 规划期用户改过工具会被旧快照覆盖；白名单还拦掉了 `tsc --noEmit`、`pnpm test`、`npm run build` |
| P7 | Plan 与 Task 是两套模型 | 重复建模、状态可能互相矛盾 |
| P8 | 重启后无法感知未完成的计划 | 无人知晓「上周那个计划做到哪了」 |

M4 的方向：**Plan 是 Task 的受控视图 + 结构化工具契约 + 能力集权限**。

---

## 2. 分层与数据流

```
模型 ──工具调用──► PlanToolbox ──► TaskService ──► SQLite(tasks)
                    │                  │
                    │                  └──广播──► AgentRegistry ──SSE──► 前端计划面板 / 任务面板
                    └──onChanged──► PlanSession.publish() → PlanView

用户 ──POST /api/agent/:id { type: plan_* } ──► AgentRegistry ──► PlanModeService.command()
                                                       │
                              plan_execute/resume ─────┴──► TaskRunner.start()（租约 + 绑定会话 + prompt）
```

| 文件 | 职责 |
| --- | --- |
| `platform/plan-model.ts` | 纯投影：`PlanView` / `PlanStatus` / `derivePlanStatus` / `toPlanView` |
| `platform/step-verification.ts` | 纯判定：证据是否满足 `verification`（M3 的恢复产物校验也用它） |
| `plan-policy.ts` | 规划期能力分类与 `PlanPolicy` |
| `plan-tools.ts` | 五个计划工具 + `PlanToolbox`（用例层，可脱离 Pi 会话单测） |
| `plan-mode-service.ts` | 会话状态机（工具差集 + 上下文注入 + 拦截）、命令分发、视图广播 |
| `task-runner.ts` | 计划执行复用租约/在飞动作（`start` / `stop`） |

---

## 3. 关键决策（已冻结）

### 3.1 计划一进入规划就落库，而不是等提交

`plan_start` 立刻创建 `origin='plan'` 的空步骤任务（`drafting`）。理由：
「Agent 正在调研」这个阶段同样需要被持久化和被面板看到；只在提交计划时才落库的话，
崩溃/刷新后连「刚才在规划什么」都找不到，等于把 P8 的坑换个地方挖。
空步骤任务由 `deriveTaskStatus` 聚合为 `pending`，不会与「空闲」混淆。

### 3.2 `planId === taskId`，不维护第二套 id

契约里同时给 `planId` / `taskId` 是为了语义清晰与将来的扩展，但实现上它们是同一个 id：
多一套映射就多一处可能不同步的状态。

### 3.3 状态只存「任务状态表达不了的意图」

落库的只有 `drafting | proposed | executing | paused` 四种意图；
`completed` / `abandoned` 由任务状态（`completed` / `cancelled`）推导。
少存一份状态就少一处可能自相矛盾的地方。`blocked` 的任务推导为 `paused`——
「有步骤阻塞，在等人」与「用户暂停」在界面上需要同一个动作（继续/处理），不必分两种状态。

### 3.4 按标题复用进度（`replacePlanSteps`）

`update_plan` 常见于「执行到一半要改后面几步」。若整体重建步骤，已完成步骤的
status/evidence 会被清空（等于忘掉刚做完的工作）。因此规则是：**标题（归一化后）相同的
步骤沿用原 id、状态与证据**；其余按新步骤创建（id 取现有最大编号 +1，不复用已删编号）。

由此得到执行期修改的准确边界：**不能删除或重命名已经开始/已完成的步骤**，
但可以自由调整还没开始的部分。之前实现里「执行中一律禁止替换步骤」太粗——
它把 M4 明确要修的场景（P4）也挡掉了。

### 3.5 证据校验强度分级（不做假的「强校验」）

`file` 查产物存在（最强）；`command` 只验证「证据里确有这条命令且退出码符合预期」；
`manual` 要人读的结论。**服务端不自己重跑 `command`**——那等于绕开审批链路执行任意 shell，
与「危险命令必须人工确认」的约束直接冲突。因此文档里明确写：`command` 验证的是
「确实跑过并如实上报」，不是「跑对了」。等 M5 把完成工具接进工具调用与审批链路后可以加强。

### 3.6 权限用能力集 + 差集撤销（P6）

- 分类判定（审批规则 → 拆段 → 程序名归类），**未归类即不放行**；
- 退出时只撤销自己造成的差集（`toolsAdded` / `toolsDisabled`），不写回旧快照；
- 计划自然完成时也要收回计划工具（否则 `submit_plan` 会永远挂在 activeTools 里，
  变成「已经在做的计划旁边还挂着一个可随时新建计划的入口」）。

### 3.7 版本号语义修正：只给用户可见内容记版本

M3 起每个 `turn_start` / 工具 / 心跳都会写 `execution`（在飞动作、租约），
而 M2 的版本号规则是「每次写入 +1」。于是**模型在思考期间手里的 revision 就过期了**，
`update_plan` 与面板编辑动不动 409——这是写 eval 时抓到的真实问题。

现在：`keepRevision` 让运行时写入（租约/心跳/在飞）**不占用版本号**（仍落库、仍广播），
内容写入照常 +1；并且 `mutate` 的 `change()` 返回原对象即「无变化」——
不写库、不广播、不动版本号（`plan_resume` 在已经是 executing 时因此是幂等的）。

安全性来自一个不变式：**所有写入都先重新读一次记录再改**（`mutate` / `commit` 都如此），
因此不会用陈旧副本覆盖运行时字段。跨进程只读一致性仍由 M3 的租约保证（同一时刻只有一个写者）。

### 3.8 JSONL 只留指针（P5）

计划创建/采纳时写一条 `web-plan-ref`（`{ planId, taskId, sessionId }`），
不再随状态变化追加快照；旧的 `web-plan-mode` 快照**保留不删**（审计痕迹，
CLI 侧也不会解析它），新的不再写。

### 3.9 上下文注入只剩两种，每轮刷新并去重

- `web-plan-context`（规划期）：只读约束 + 「用工具产出计划」的用法；
- `web-plan-execution-context`（执行期）：当前步骤/进度/证据 + 推进方式。

按类型只保留最后一条（否则随轮数线性膨胀），旧的 `web-plan-execute` 类型一律丢弃。
执行期上下文**每轮**注入，而不是像 M3 的恢复摘要那样一次性注入：状态永远是最新的，
不会出现「一次性注入的内容已经过期」的问题。

### 3.10 M3 的 `replan` 只对计划任务开放

`assertResumable` 里 replan 若任务 `origin !== 'plan'` → `409 replan_unavailable`；
计划任务则把状态打回 `drafting`，让模型用 `update_plan`/`submit_plan` 重交，
恢复摘要仍会注入（模型要先复述中断前的状态）。

---

## 4. 验证证据

### 4.1 单元/集成测试

| 测试 | 覆盖 |
| --- | --- |
| `platform/plan-model.test.ts`（11） | 状态推导（含 blocked→paused、终态、缺省）、视图投影、标题提取 |
| `platform/step-verification.test.ts`（11） | 三种 kind 的通过与拒绝、未知 kind、相对路径解析 |
| `plan-policy.test.ts`（14） | 三条被误拦的验证命令放行、写操作/联网/未知程序拦截、逐段判定、策略开关与危险规则优先级 |
| `plan-tools.test.ts`（18） | 五个工具的参数校验与领域校验、证据三连（缺口令/错退出码/缺产物）、执行前拒绝推进、执行期修改的保护规则、陈旧 revision、无计划时的提示 |
| `plan-mode.test.ts`（18，重写） | 只读拦截（写工具/MCP/危险命令 vs 验证命令）、工具激活、上下文注入与去重、命令生命周期（start→submit→execute→complete / pause→resume / abandon）、差集恢复（用户改动被保留）、重启接管、策略与观测 |
| `task-runner.test.ts`（+4） | `start` 取租约 + 绑定 + 发 prompt、无会话/双跑拒绝、`stop` 释放、replan 打回 drafting 并改 prompt、非计划任务仍拒 replan |
| `task-recovery.test.ts`（+1） | 计划任务的 replan 放行 + `origin` 字段 |
| `tasks-routes.test.ts`（+2） | `mode:'plan'` 透传、非法 mode 422、命令到 action 的映射、pause/abandon/enable/disable 都会 abort |
| `task-service.test.ts`（+5） | 计划创建/步骤替换的按标题复用/编号不回收/Lifecycle/activePlanForSession/放弃保留；版本号语义（运行时写入不动版本号、内容写入 +1、幂等命令不写库） |
| web：`PlanProgress.test.ts`（14）、`ChatInput.test.ts`（+3）、`AgentControls.test.ts`（+1）、`api.test.ts`（+2）、`agent-events.test.ts`（+1） | 面板状态/证据/验证声明/澄清问题/各阶段动作/编辑删除/终态只读；发送方式与 `/plan` 前缀；无 Plan 预开关；命令映射；`plan_updated` 不进流式状态机 |

### 4.2 端到端 spike（真实 SDK + fauxProvider，进 CI 门禁）

`npm run spike` 的 ⑦ 号脚本用真实 SDK + 真实 AgentRegistry + 真实服务跑完整旅程，
并断言「模型全程没有输出 `Plan:` 标题或 `[DONE:n]`」：

```
✅ 计划已进入 proposed / 步骤来自结构化参数 / verification 被原样保存 / awaitingUserAction
✅ 规划期写操作被拦住
✅ 执行期计划工具仍激活、写工具已放行、租约已持有
✅ 退出码不符的证据被拒（且没有写进状态）、产物缺失被拒、错误信息可照做
✅ 补齐产物后计划完成、每一步都有证据、模型零标记
✅ 计划完成后收回计划工具；放弃后记录保留（cancelled）且工具差集撤销
```

这个 spike 抓到两个真实缺陷（已修，见 §5）。

### 4.3 评测 golden set（`npm run eval`，CI 的 eval job）

7 个确定性用例（模型行为脚本化，走真实管线），指标与门禁：

```
用例：simple-two-steps / command-verification-retry / file-verification-gate /
      blocked-step-asks-user / mid-plan-edit / stale-revision-rejected / no-legacy-markers
指标：pass@1 100%、计划一次通过率 100%、工具调用失败率 16.7%（含刻意拒绝）、
      平均步骤证据覆盖率 64.3%、残留旧标记 0
门禁：pass@1 = 100%、计划一次通过率 ≥ 80%、零残留旧标记
```

指标含义：pass@1 与计划一次通过率对应规划 §9.2 的简历指标；工具调用失败率里包含
**刻意制造**的拒绝（错退出码、缺产物、陈旧 revision），因此它的绝对值不是越低越好，
而是要在多次运行之间可比。

---

## 5. 实施过程中抓到的真实缺陷（都已修）

| # | 缺陷 | 发现方式 | 修法 |
| --- | --- | --- | --- |
| 1 | **预设白名单把内联工具挡在门外**：SDK 的 `tools` 是*可用工具白名单*，不在名单里的工具不是「不激活」而是调用时 `Tool submit_plan not found`。带预设的会话里 Plan 完全不可用、MCP 工具同理 | spike ⑦ | `AgentRegistry` 把内联扩展的工具名并入白名单（`withInlineTools`，`toolNames` 未指定时保持 SDK 默认语义） |
| 2 | **计划结束后计划工具不收回** | spike ⑦ | `publish()` 发现终态即撤销差集；计划工具一律登记为「本次会话打开」 |
| 3 | **心跳顶掉 revision**：模型在思考期间手里的版本就过期，`update_plan`/面板编辑频繁 409 | eval 的 `mid-plan-edit` | 版本号语义改为「用户可见内容的版本」（`keepRevision`） |
| 4 | **幂等命令也顶版本号**：`plan_resume` 在已是 executing 时仍写库 | eval（同一用例） | `mutate` 约定「change 返回原对象 = 无变化」 |
| 5 | **执行期无法调整后续步骤**（初版一刀切禁止替换） | eval 的 `mid-plan-edit` | 改为「不能删除/重命名已开始或已完成的步骤」，其余可改 |

> 这 5 条都是「只看单测都绿也发现不了」的问题——它们要么出现在 SDK 交互边界（1），
> 要么出现在真实时序里（3/4）。这也是 M4 坚持把 spike 与 eval 作为独立门禁的原因。

---

## 6. 已知限制与后续（M5 及以后）

| 项 | 说明 |
| --- | --- |
| `command` 类验证不重跑 | 只验证「跑过且如实上报」；要变成强校验需要把它接进工具调用与审批链路（M5） |
| `ask_user` 只用对话通道 | 问题会显示在计划面板，回答走普通消息；不复用审批弹窗（审批是「允许/拒绝」语义，自由问答硬塞进去只会更乱） |
| 不支持计划内并行步骤 | 步骤是有序列表，`position` 决定顺序；子任务并行属于 M5 的 subagent 范畴 |
| 面板不支持拖拽排序 | 步骤重排接口（`PATCH position`）已就绪，UI 目前只做改名/跳过/删除 |
| `verifyCommands` 暂无工作区配置文件 | 策略字段已具备（可按预设/注入扩展），`.pi/plan-policy.json` 待需要时再加 |
| 计划历史入口 | 计划是任务，`GET /api/tasks?origin=plan` 可查；侧栏历史入口尚未做 |
