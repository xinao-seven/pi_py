# Pi Agent Web 项目面试 Q&A

> 面试模拟记录：按简历口径回答，附源码溯源位置。部分条目标注了「简历 vs 现状」的出入。

---

## Q1：你说对 Pi Agent Runtime 进行服务化封装，具体是怎么封装的？

### 面试者回答

我封装的思路不是重写 Pi 内核，而是给原版 Pi SDK 包一层「HTTP + SSE 的服务门面」——把原来 CLI 那种「进程内、交互式」的用法，改造成一个常驻进程、通过 REST/SSE 访问的后端服务。整体分三层：

- **路由层（薄）**：只做参数校验和协议转换，不碰业务、不创建会话。典型入口是 `POST /api/agent/new`（创建会话并发首条 prompt）、`POST /api/agent/:sessionId`（统一命令下发）、`GET /api/agent/:sessionId/events`（SSE 事件流）。
- **服务层（封装核心）**：先定义一个 `PiSession` 门面接口，把 Pi SDK 的复杂类型（`AgentSession`、`AgentSessionEvent` 等）全部屏蔽，路由层只跟这个接口打交道。下面两个关键类：
  - `OriginalPiSessionFactory`：SDK 适配器。负责把 `auth.json` 里的凭据、`models.json` 里的模型目录组装成 `createAgentSession()` 需要的依赖（ModelRuntime / ResourceLoader / SettingsManager），并支持从磁盘 JSONL 恢复已持久化的会话。
  - `AgentRegistry`：会话注册表。每个会话一个活跃 AgentSession，用 `Map<sessionId, entry>` 管理，负责订阅 SDK 事件、维护事件缓存、广播给 SSE 订阅者。
- **SDK 层**：真正干活的是 `createAgentSession` / `SessionManager` / `ModelRuntime`。

封装过程中最有价值的是把 Pi 的**事件模型服务化了**。Pi SDK 是订阅回调模型（`subscribe(listener)`），我把它转成 SSE 事件流：每个会话内存缓存最近 256 条事件，前端断线重连时通过 `Last-Event-ID` 从缓存补发；像 `prompt` 这种长任务不阻塞 HTTP——`202` 先接收，结果通过 SSE 推送，这样接口语义和 CLI 保持一致。

另外两个设计点：一个是 `command()` 统一命令分发，把前端传来的 `{ type: "prompt" | "abort" | "set_model" | ... }` 翻译成具体的 `PiSession` 方法调用，前端不需要关心内部组织；另一个是依赖注入与生命周期，`app.ts` 只做装配、`server.ts` 只做启动，关闭时 `close()` 统一释放会话、事件订阅和审批挂起项。

### 源码位置

- `PiSession` 门面接口：[agent-registry.ts:111-148](node-pi/server/src/services/agent-registry.ts#L111-L148)
- `OriginalPiSessionFactory`（SDK 适配：凭据/模型组装、创建/打开会话）：[agent-registry.ts:210-369](node-pi/server/src/services/agent-registry.ts#L210-L369)
- `AgentRegistry`（会话注册、事件订阅、缓存重放）：[agent-registry.ts:379-538](node-pi/server/src/services/agent-registry.ts#L379-L538)
- `command()` 统一命令分发：[agent-registry.ts:545-630](node-pi/server/src/services/agent-registry.ts#L545-L630)
- SSE 端点（`Last-Event-ID` 回放 + 15s 心跳 + 断开清理）：[routes/agent.ts:252-286](node-pi/server/src/routes/agent.ts#L252-L286)
- 长任务 `202` 接收：[routes/agent.ts:172-206](node-pi/server/src/routes/agent.ts#L172-L206)
- 依赖注入与生命周期：[app.ts](node-pi/server/src/app.ts)

---

## Q2：为什么选用 Pi 进行二次开发，而不是 langchain / langgraph 这类框架？

### 面试者回答

核心是「定位不同」和「少造轮子」两点。

- **Pi 是编码代理的产品级实现，不是通用 agent 框架。** 编码场景真正需要的东西它已经内置好了：文件工具（read/edit/write/bash）、消息树与分支、会话 JSONL 持久化、上下文压缩策略、thinking 思考等级、技能与工具发现机制。这些如果用 langchain 从零搭，工具集、会话管理、上下文压缩、消息分支全都要自己设计，工作量和成熟度都不可控。
- **我们的目标只是「CLI → Web 化 + 运行能力扩展」。** langchain/langgraph 抽象层厚，偏研究编排；而我们要做的核心其实是 Web 侧这一件事——SSE 流式、审批弹窗、MCP 接入、预设管理。站在 Pi 的肩膀上，把精力全部放在这里。
- **Pi 的扩展机制刚好能承载我们要加的定制能力。** 它提供 `InlineExtension` 和事件钩子（`tool_call`、`before_agent_start`、`agent_end` 等），我们把工具审批、Plan 模式、MCP 都做成了内联扩展注入到每个会话，属于「在既有内核上做增强」，而不是绕过它。

补充一点取舍：其实我们自己也实现了 Plan 模式的状态机（`PlanModeService`），这算是「框架该做的事」。但我们的判断是不为这一个功能引入 langgraph 那一套抽象，Pi 的事件流 + 一个小状态机就够用——这是在「用什么框架」和「不引入多余抽象」之间做务实取舍。

### 源码位置

- 直接组装 Pi SDK 依赖（`createAgentSession` / `ModelRuntime` / `SettingsManager`）：[agent-registry.ts:222-262](node-pi/server/src/services/agent-registry.ts#L222-L262)
- 扩展机制作为二次开发能力的落点：工具审批 [tool-approval.ts:234-251](node-pi/server/src/services/tool-approval.ts#L234-L251)、MCP [mcp-extension.ts:23-52](node-pi/server/src/services/mcp/mcp-extension.ts#L23-L52)、Plan 模式 [plan-mode-service.ts:334-343](node-pi/server/src/services/plan-mode-service.ts#L334-L343)
- 扩展发现与接入说明：[docs/node-extension-system.md](docs/node-extension-system.md)

---

## Q3：把 CLI 迁移到浏览器端有什么意义？

### 面试者回答

有意义，本质上是把 agent 从一个「终端里的工具」升级成「可视化、可交互、可分发的服务」。具体几点：

- **体验与可视化。** CLI 的 TUI 只能展示文本流；浏览器端做成三栏 IDE——会话侧栏、聊天窗口、文件面板，加上 Markdown 渲染、代码高亮、思考块折叠、工具调用卡片。agent 的运行状态（流式输出、工具执行、Plan 进度、上下文占用）全部可视化，用户能看懂 agent 在干什么、卡在哪。
- **Human-in-the-loop 真正落地。** 危险命令审批在浏览器端体验完全不同：不是 CLI 的交互式确认，而是弹窗 + 风险分级（medium/high/critical）+ 命中规则说明 + 命令预览，还能在运行中实时 steer / follow-up 干预。这是审批机制能做到产品级的关键。
- **可分发、可访问。** CLI 要安装、要开终端；浏览器打开即用。我们还打成了 uTools 桌面插件（后端常驻 + 加载 Web 构建），甚至局域网内可以多人共享一个后端实例。
- **能力扩展的载体。** 模型切换、MCP Server 配置、会话预设、思考等级调节这些配置操作，有 GUI 才自然。浏览器端天然适合承载这些配置面板，这也是预设、MCP 这类能力能加进来的基础。

当然，Web 化也带来一些硬骨头：SSE 推送与断线续传、跨域、认证（EventSource 带不了 Authorization 头，令牌要走查询参数）、长会话流式渲染性能。这些恰好是这个项目要解决的核心问题，也是它的价值所在。

### 源码位置

- 三栏 IDE 布局：[AppShell.vue](web/src/components/AppShell.vue)、[ChatWindow.vue:244-414](web/src/components/ChatWindow.vue#L244-L414)、[SessionSidebar.vue](web/src/components/SessionSidebar.vue)、[FileExplorer.vue](web/src/components/FileExplorer.vue)
- 审批弹窗：[ToolApprovalDialog.vue](web/src/components/ToolApprovalDialog.vue)
- 实时干预 steer / follow_up：[useAgentSession.ts:298-325](web/src/composables/useAgentSession.ts#L298-L325)
- 配置面板（模型/MCP/预设）：[ModelsConfig.vue](web/src/components/ModelsConfig.vue)、[McpConfig.vue](web/src/components/McpConfig.vue)、[PresetConfig.vue](web/src/components/PresetConfig.vue)
- Plan 进度可视化：[PlanProgress.vue](web/src/components/PlanProgress.vue)
- uTools 桌面插件：[node-pi/utools](node-pi/utools/)

---

## Q4：前端 SSE 为什么选用 fetch 而不是 EventSource，也不用 WebSocket？用 fetch 怎么自己处理断线重连？

### 面试者回答

分三层讲：为什么不用 EventSource、为什么不用 WebSocket、fetch 方案的重连怎么自己扛。

**为什么不用 EventSource：**
- 最主要的是**认证头**。EventSource 是浏览器原生实现，只能发 GET、且无法携带自定义请求头。我们后端有 token 鉴权，如果走 EventSource，token 只能塞进 URL 查询参数——会出现在访问日志、代理日志里，既不安全也不干净。用 fetch 可以把 `Authorization: Bearer` 直接放进请求头，和普通 REST 请求的鉴权方式完全统一。
- 其次是**控制粒度**。EventSource 强制按 `event:` / `id:` / `data:` 的协议解析，重连策略也是浏览器黑盒（退避、超时判定、Last-Event-ID 携带方式都不能定制）。用 fetch + ReadableStream，我们手动按帧解析，事件载荷完全按我们自己的契约，还能精确控制错误处理、部分读取和背压。

**为什么不用 WebSocket：**
- WebSocket 是全双工，但我们客户端→服务端走的其实是 **REST 命令**（`prompt` / `abort` / `steer` / `approve_tool`），只有服务端→客户端是推送流。全双工能力用不上，反而要额外处理 ws 握手、帧协议、双端心跳和重连，复杂度高。
- SSE 基于普通 HTTP，**穿透代理/负载均衡好**，还天然适配 `Last-Event-ID` 断点续传语义；WebSocket 是长连接，中间代理容易超时掐断，调试和审计也不如 HTTP 直观。用 HTTP + SSE，错误处理（状态码、错误信封）和鉴权中间件都能和 REST 复用同一套。

**用 fetch 怎么自己处理断线重连：**
- **事件编号 + 断点续传**：服务端给每条事件递增一个整数 id，前端维护 `lastReceivedId`。连接断开后，重连请求在请求头里带上 `Last-Event-ID`，服务端从该序号之后补发缓存的历史事件——这样断线期间的事件不丢。后端为此在内存里给每个会话缓存了最近 256 条事件。
- **指数退避重连**：断开（`stream` 结束或读取抛异常）后进入重连状态机，按 0.5s / 1s / 2s … 封顶的指数退避重试，避免重连风暴。
- **心跳假死检测**：服务端每 15 秒发一条注释帧保持连接活性；前端用定时器检测「超过阈值没有收到任何数据」就判定连接假死，主动 abort 旧连接并重连。
- **竞态防护**：重连瞬间新旧连接可能并发，我用一个递增的 generation 序号——旧连接的读取循环发现序号不匹配就直接丢弃后续数据，保证事件不重复、不乱序。
- **触发时机**：除了被动断开，还在页面 `visibilitychange` 恢复可见时主动重连，加速恢复。

### 源码位置

- 后端事件缓存（每会话最多 256 条）+ `Last-Event-ID` 断点回放：`subscribe()` 先按 `afterEventId` 补发缓存，再加进订阅集合 [agent-registry.ts:527-538](node-pi/server/src/services/agent-registry.ts#L527-L538)；缓存写入与超限丢最旧在 `publish()` [agent-registry.ts:786-795](node-pi/server/src/services/agent-registry.ts#L786-L795)
- 后端 SSE 端点：读取 `Last-Event-ID` 请求头、`reply.hijack()`、15 秒心跳、`close` 断开清理 [routes/agent.ts:252-286](node-pi/server/src/routes/agent.ts#L252-L286)
- ✅ **本次改造已把简历口径落地为真实代码**：前端改用 fetch + ReadableStream + TextDecoder 手写解析 SSE，并自建断线重连（指数退避 + `Last-Event-ID` 续传 + 心跳假死检测 + generation 竞态防护 + `visibilitychange` 重连）：
  - `fetchAgentEvents`（`Authorization` / `Last-Event-ID` 请求头）：[api.ts:310-329](web/src/lib/api.ts#L310-L329)
  - `readStream` / `scheduleReconnect` / `forceReconnect` / `onVisibilityChange`：[useAgentSession.ts:191-306](web/src/composables/useAgentSession.ts#L191-L306)
  - `parseSseFrame`（SSE 帧解析纯函数）：[useAgentSession.ts:701-719](web/src/composables/useAgentSession.ts#L701-L719)
  - 不定高虚拟列表（TanStack Virtual，`measureElement` 动态测量）：[ChatWindow.vue:110-132](web/src/components/ChatWindow.vue#L110-L132)
