# Web Plan 模式

更新日期：2026-08-18

## 目的与边界

Plan 模式不是一个可手工勾选的任务看板，而是一次 Pi Agent 会话的**受约束工作流**：

1. 用户在已有会话中开启 Plan 模式；
2. Agent 只能阅读、检索和讨论，不能编辑项目；
3. Agent 在回复中提出 `Plan:` 编号计划；
4. 用户可要求细化，或显式确认；
5. 只有确认后，Agent 才恢复完整工具权限并按序执行；每完成并验证一步，在回复中输出
   `[DONE:n]`，系统据此更新进度。

这保留了原版 Pi `examples/extensions/plan-mode` 的核心设计，同时将原先 TUI 的确认菜单改为 Web
面板和 REST/SSE 协议。它不替代一般的用户指令：用户始终可以停止会话或放弃计划；但 Agent 在未确认
阶段没有可写工具，不能绕过确认直接改动文件。

## 组件与数据流

```text
Vue PlanProgress（输入框上方内联面板）
  ├─ GET /api/agent/:sessionId/plan              ← 会话加载/恢复时 REST 拉取
  └─ POST /api/agent/:sessionId { type: plan_* } ← 用户决定
                         │
                         ▼
PlanModeService（按会话持有 PlanMachine 状态机）
      │                │
      │ command()      │ buildExtension() 注入 tool_call / before_agent_start 等钩子
      ▼                ▼
  状态快照          Pi 生命周期钩子（Plan 工具权限的最终约束点）
      │
      └─ SSE { type: "plan_updated", plan } → useAgentSession
```

- `PlanModeService.buildExtension()` 生成内联扩展，为每个会话注册一套 Pi 生命周期钩子，钩子委托给
  按会话隔离的 `PlanMachine`（`node-pi/server/src/services/plan-mode-service.ts`）——这是 Plan
  工具权限的最终约束点。
- `PlanModeService` 按 sessionId 持有状态机，是状态快照的权威来源；`command()` 直接调用状态机的
  enable/disable/execute/refine，不经过事件总线（内联扩展与后端共享模块实例，可直接调用）。
- `AgentRegistry` 把状态变化翻译为 `plan_updated` SSE 事件，供已连接的客户端即时刷新；
  `useAgentSession` 在会话加载时通过 REST 快照恢复 Plan 状态，并在 SSE 收到 `plan_updated` 时实时
  更新内联面板，SSE 断连或会话从 JSONL 恢复后仍能通过快照兜底。

## Agent 层行为

### 规划期

`plan_enable` 后，扩展先记录当前活动工具集，再移除 `edit`、`write`，并仅加入阅读和检索工具。
对 `bash` 额外执行只读白名单校验；诸如 `rm`、重定向写入、`npm install`、Git 写入等都会被
`tool_call` 钩子阻断。每次 Agent 启动前，`before_agent_start` 注入一个不可见上下文，要求先讨论/调查，
再以编号的 `Plan:` 段落输出方案，且不得修改文件。

`agent_end` 从最新 assistant 文本提取 `Plan:` 下的编号项（支持 `Plan:`、`**Plan:**` 和
`## Plan:`），生成待确认步骤。用户执行 `plan_refine` 后，扩展清除待确认标记并向当前会话追加
follow-up，让 Agent 根据反馈生成新计划。

### 执行期

`plan_execute` 只有在存在待确认步骤时才会通过；服务端否则返回
`409 plan_not_ready`。扩展恢复原工具集，发送一个带剩余步骤的隐藏 follow-up，并触发下一轮 Agent。
每轮前继续注入执行上下文，要求按顺序推进并在**完成且验证后**写出 `[DONE:n]`。

`turn_end` 解析标记并更新对应步骤。全部步骤完成时，扩展退出执行态并清空当前计划；用户可在下次开启
Plan 模式讨论新的任务。

## HTTP 与 SSE 契约

| 接口/事件 | 说明 |
| --- | --- |
| `GET /api/agent/:sessionId/plan` | 打开（必要时恢复）会话，返回 `{ plan: { sessionId, mode, todos, awaitingConfirmation } }`。 |
| `POST /api/agent/:sessionId` + `plan_enable` | 进入只读规划期。 |
| `POST /api/agent/:sessionId` + `plan_refine` | 仅对待确认计划有效；`message` 为必填非空字符串。 |
| `POST /api/agent/:sessionId` + `plan_execute` | 仅对待确认且非空计划有效。 |
| `POST /api/agent/:sessionId` + `plan_disable` | 放弃当前规划并恢复原工具集。 |
| SSE `plan_updated` | 载荷为 `{ type: "plan_updated", plan }`，与 GET 的 `plan` 结构一致。 |

`mode` 取值为 `normal`、`planning`、`executing`；每个待办项为
`{ step: number, text: string, completed: boolean }`。前端不得自行把步骤改为完成，必须等待 Agent 的
`[DONE:n]` 状态事件。

## 与 Session JSONL 持久化的关系

扩展通过 `pi.appendEntry("web-plan-mode", ...)` 将模式、原工具集、待办和确认状态写入当前 Session
JSONL。这是**会话内容持久化的一部分**：同一会话恢复后，扩展在 `session_start` 重建 Plan 约束和
进度。

它不同于一个全局“任务状态库”：没有跨会话的任务 ID、分配、队列或独立生命周期；Plan 只服务于其所属
对话，并与该对话的上下文、消息树和工具权限一起恢复。若未来需要跨会话协作或长期排程，应另建任务
领域服务，而不是扩大这个扩展的职责。

## 接入与测试

- Plan 内联扩展由 `OriginalPiSessionFactory.loader()` 通过 `extensionFactories` 注入每个会话，
  无需在 `app.ts` 逐项注册；预设可关闭（`extensions.planMode: false`）。
- 主入口位于聊天输入框上方的 **开启 Plan 模式**：先点击开关，再在原输入框发送需求；该消息会在
  只读规划上下文中驱动 Agent 生成 `Plan:`。激活后，内联面板 `web/src/components/PlanProgress.vue`
  固定在输入框上方始终可见，实时展示规划/确认/执行进度并高亮当前步骤；再次点击开关即退出 Plan
  模式（执行中会先弹确认），面板内也有"退出 Plan 模式"按钮。
- 修改状态形状或权限规则时，同步更新 `PlanModeService`、前端类型/API 和本文档。
- 关键契约测试位于 `node-pi/server/test/services/plan-mode.test.ts`；前端面板测试位于
  `web/test/components/PlanProgress.test.ts`。
