# Pi Agent Web 项目面试 Q&A

> 面试模拟记录：按简历口径回答，附源码溯源位置。部分条目标注了「简历 vs 现状」的出入。
> 覆盖范围：Web 化与前端（Q1–Q7）、工具审批与 MCP（Q8–Q9）、预设与内核边界（Q10–Q14）、平台能力 M1–M5（Q15–Q23）。

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

---

## Q5：你的 SSE 方案如何解决半包和沾包问题？

### 面试者回答

半包/沾包是流式字节传输的经典问题。SSE 跑在 HTTP 流上，`fetch` 的 `reader.read()` 每次返回的 chunk 边界和 SSE 帧边界完全不对齐——一个 chunk 可能含多帧（沾包），一帧也可能被拆进多个 chunk（半包）。我的方案是**缓冲区 + 定界符切帧**：

- **缓冲区累加**：每次 `reader.read()` 拿到的 `Uint8Array` 用 `TextDecoder.decode(value, { stream: true })` 解码后追加进 `buffer`。`stream: true` 是关键的半包兜底——多字节 UTF-8 字符若被 chunk 边界切断，不带 stream 模式会解出乱码，带上则把残码留到下一次 decode 再拼。
- **按空行定界切帧**：SSE 协议约定每帧以空行（`\n\n`，兼容 CRLF）结束。`while` 循环反复 `buffer.indexOf('\n\n')` 找边界：找到就 `slice` 出一帧处理、剩下的留在 buffer；找不到说明是半包（帧还没传完），等下一个 chunk 再拼。沾包被 while 循环逐个取出，半包被 buffer 自然合并。
- **残帧保留**：切完所有完整帧后 buffer 里剩下的残缺数据不丢弃，与下一个 chunk 拼接继续解析。因为 `parseSseFrame` 是纯函数（输入完整帧、输出 `{id, data}`），残帧跨 chunk 拼合也不会有状态污染。
- **心跳帧跳过**：后端每 15s 发一条 `: heartbeat` 注释帧，`frame.startsWith(':')` 直接 continue，不进入业务解析。

### 源码位置

- 缓冲区累加 + `\n\n` 定界切帧 + 残帧保留 + 心跳跳过：[useAgentSession.ts:212-235](web/src/composables/useAgentSession.ts#L212-L235)
- `TextDecoder` stream 模式解码：[useAgentSession.ts:212-219](web/src/composables/useAgentSession.ts#L212-L219)
- `parseSseFrame` 帧解析纯函数（id/data 提取、多行 data 拼接、CRLF 容忍、非数字 id 丢弃）：[useAgentSession.ts:697-712](web/src/composables/useAgentSession.ts#L697-L712)
- 后端发送端契约（`id: N\ndata: {...}\n\n` + `: heartbeat`）：[routes/agent.ts:252-286](node-pi/server/src/routes/agent.ts#L252-L286)

---

## Q6：虚拟列表的实现原理是怎么样的？

### 面试者回答

虚拟化的本质是一个「空间换时间」的算法：列表有 N 行数据，但视口一次只放得下 M 行（M ≪ N）。全量渲染的问题在 O(N) 的 DOM 节点 + O(N) 的布局开销。虚拟列表的思路：**让浏览器以为列表有 N 行高（撑出正确的滚动条），但 DOM 里只挂载视口内的 M 行，滚动时用 JS 算窗口、换挂载的行**。

核心是四块：

- **数据层**：`items[]` 是全部消息；`sizes[]` 存每行真实高度（未测量用 `estimateSize` 粗估）；`offsets[]` 是**前缀和**——`offsets[i] = sizes[0..i-1] 之和`，即第 i 行的起始偏移，`offsets[N]` 即列表总高度。
- **窗口计算（二分）**：滚动更新 `scrollTop` 后，视口区间是 `[scrollTop - overscan, scrollTop + clientHeight + overscan]`。在 `offsets` 上**二分**找第一个 `offsets[j] > 窗口上界` 为起始行、第一个 `offsets[k] >= 窗口下界` 为结束行——渲染量从 O(N) 降到 O(M + overscan)，定位 O(log N)。
- **绝对定位 + transform**：每行 `position: absolute`，`transform: translateY(offsets[i])` 精确落到应有位置；容器高度设 `offsets[N]` 撑出滚动条。行互不挤压，渲染节点始终只有窗口内那几个。
- **不定高动态测量**：行挂载后用 `getBoundingClientRect()` 量真实高度 → 更新 `sizes[i]` → **重算 i 之后的前缀和**（前面不受影响，偏移单调递增）。这是不定高比固定行高难的地方：固定高度只需 `i * rowHeight` 一步算。

两个工程细节：**行间距不能用 margin**——`getBoundingClientRect()` 只量元素自身，margin 不参与会每行矮一截累计偏差，所以用行内 `padding-bottom` 承载间距；**流式消息不进虚拟列表**——它在持续变高，放进前缀和会让后续行偏移频繁失效、触发重测抖动，所以固定渲染在虚拟容器之外。

这套「前缀和 + 二分窗口 + 绝对定位 + 动态测量」就是虚拟列表的完整原理。落地时用 `@tanstack/vue-virtual`（其正是这套算法的成熟实现），我只做装配（`count` / `estimateSize` / `measureElement` 三个入口）。

### 源码位置

- 虚拟列表装配（count / estimateSize / overscan 窗口）：[ChatWindow.vue:113-125](web/src/components/ChatWindow.vue#L113-L125)
- `measureElement` 真实高度测量回调：[ChatWindow.vue:132-135](web/src/components/ChatWindow.vue#L132-L135)
- 双容器模板（总高度容器 + 绝对定位行 + 流式消息在外）：[ChatWindow.vue:392-420](web/src/components/ChatWindow.vue#L392-L420)
- 定位上下文 / 绝对定位 / `padding` 代替 `margin`：[globals.css](web/src/globals.css)

---

## Q7：Markdown 的安全渲染是怎么实现的？

### 面试者回答

核心是「**先渲染、后清洗**」——渲染出的 HTML 在进入 `v-html` 之前必须过 DOMPurify，否则模型/用户输入里的一条 `<img src=x onerror=...>` 或 `[点我](javascript:alert(1))` 就是 XSS 注入点。管线分三段：

- **marked 渲染**：配置 `gfm: true`（表格、删除线等 GFM 语法）、`breaks: true`，Markdown → HTML。
- **代码高亮**：自定义 `marked.Renderer` 的 `code` 方法，用 highlight.js 高亮。语言名先 `hljs.getLanguage(lang)` 校验，认不出的落回 `plaintext`——既保证高亮正确，也避免用户控制 `language` class 注入任意 HTML。
- **DOMPurify 清洗**：`DOMPurify.sanitize()` 是最后也是最重要的一道防线。按白名单剥掉 `<script>`、`<iframe>`、`on*` 事件属性、`javascript:`/`data:` 协议链接，放行 `a/img/code/pre/table` 等安全标签。即使 marked 或 renderer 存在渲染漏洞，注入内容也在进入 `v-html` 前被剥干净。

一个关键认知：Vue 的 `v-html` 本身**不做任何净化**，所以组件把「渲染 + 清洗」做成 `computed` 纯函数管线，保证进入 `v-html` 的永远是 sanitize 后的产物，`content` 一变就整体重算。

### 源码位置

- 渲染管线 + DOMPurify 清洗：[MarkdownContent.vue:12-27](web/src/components/MarkdownContent.vue#L12-L27)
- 自定义 code 渲染器 + 语言校验：[MarkdownContent.vue:14-19](web/src/components/MarkdownContent.vue#L14-L19)
- `v-html` 输出点（白名单 `eslint-disable` 标记）：[MarkdownContent.vue:30-33](web/src/components/MarkdownContent.vue#L30-L33)
- 使用方（消息正文、工具调用结果统一走此组件）：[MessageView.vue:62](web/src/components/MessageView.vue#L62)

---

## Q8：你扩展 Agent 工具执行链路，工具审批是如何实现的？主要解决了什么问题？如何判定危险工具执行？

### 面试者回答

**解决的问题**：编码 Agent 会自主执行 `bash`，一旦模型误判或幻觉，一条 `rm -rf`、`git push --force`、关机命令就可能造成不可逆损失。工具审批的本质是把「模型的自主执行权」交还给人——危险命令挂起、人确认后才放行，实现真正的 human-in-the-loop。Web 端能做成风险分级 + 命中规则说明 + 命令预览的弹窗，是审批机制产品化的关键。

**实现方式（拦截点 + 挂起队列 + 双端结算）**：

- **拦截点**：用 Pi 的内联扩展注册 `tool_call` 钩子（[tool-approval.ts:234-251](node-pi/server/src/services/tool-approval.ts#L234-L251)）。每次 bash 被调用时先做危险分类；命中规则就构造 `PendingToolApproval`（会话、工具、参数、命中规则、风险等级、类别），调 `requestApproval()` 挂起等待——钩子返回 Promise，**等待期间工具执行被真正卡住**。SDK 侧这条拦截正是落在 `beforeToolCall` 钩子上（Pi 源码 `agent-session.js` 把 `beforeToolCall` 转成 `tool_call` 事件，见 `pi_design.md` 第 3 节）。
- **挂起队列**：`ToolApprovalBroker` 是唯一真相源，用 `Map<sessionId:toolCallId, Waiter>` 维护挂起项（[tool-approval.ts:223-284](node-pi/server/src/services/tool-approval.ts#L223-L284)）。登记时触发 `onPending` 回调，注册表把它转成 `tool_call_pending` SSE 事件推给前端弹审批框。防重入：同一 `toolCallId` 重复登记直接拒绝。
- **双端结算**：`decide(sessionId, toolCallId, approved)` 由前端 `approve_tool` 命令触达（[tool-approval.ts:292-297](node-pi/server/src/services/tool-approval.ts#L292-L297)），允许 → Promise resolve true 放行；拒绝 → resolve false、钩子返回 `{ block: true, reason }` 拦截。**所有终结路径都结算**：前端决定、30 秒决策超时、`AbortSignal` 中止、会话关闭 `cancelSession`、服务关闭 `dispose`——超时/中止/关闭一律按拒绝处理，不出现挂起项泄漏。
- **边界守卫**：钩子首行 `if (ctx.hasUI) return undefined`——扩展被共享到 TUI/RPC 宿主也不会绕过其自身确认 UI。

**如何判定危险工具执行**——规则引擎，分两级（[tool-approval.ts:40-202](node-pi/server/src/services/tool-approval.ts#L40-L202)）：

- **`DANGEROUS_COMMAND_RULES`**（命中 → `critical`，必须审批）：提权删除、递归/强制删除（`rm -rf` / `Remove-Item -Force`）、磁盘格式化、直接写块设备（`dd of=/dev/...`）、关机重启、Git 强制推送、批量卸载、远程脚本管道执行（`curl | sh`）、递归改根目录权限、删注册表、fork 炸弹。按「高危优先」排序，避免强制推送被普通 Git 规则降级。
- **`SENSITIVE_COMMAND_RULES`**（命中 → `medium`/`high`，需确认）：Git 远端写操作、依赖变更、网络访问、Shell 重定向写文件。
- `classifyBashCommand` 先查危险表（→ critical）再查敏感表（→ medium/high），没命中直接放行。风险等级和类别随 `tool_call_pending` 传给前端，弹窗按等级渲染颜色和说明。

### 源码位置

- 危险/敏感规则表 + 分类函数：[tool-approval.ts:40-202](node-pi/server/src/services/tool-approval.ts#L40-L202)
- 审批中枢 `ToolApprovalBroker`（挂起队列 / 防重入 / 超时 / 结算）：[tool-approval.ts:223-323](node-pi/server/src/services/tool-approval.ts#L223-L323)
- 拦截点内联扩展（`tool_call` 钩子 + `hasUI` 守卫）：[tool-approval.ts:234-251](node-pi/server/src/services/tool-approval.ts#L234-L251)
- 审批弹窗（风险分级 / 命令预览 / 规则说明）：[ToolApprovalDialog.vue](web/src/components/ToolApprovalDialog.vue)
- 命令风险分级与审批链路文档：[docs/node-command-approval.md](docs/node-command-approval.md)
- Pi 侧拦截接线（`beforeToolCall` → `tool_call`）：见 [pi_design.md](pi_design.md) 第 3 节

---

## Q9：MCP 是怎么接入的？MCP 分为哪几部分？

### 面试者回答

MCP（Model Context Protocol）本质是「给 Agent 挂外部工具服务器的标准协议」——服务商写好 MCP server 暴露一组工具，任何 MCP client 按同一套 JSON-RPC 规范连上、列工具、调工具。接入价值是**生态复用**：不用为每个数据源单独写工具。

我的接入分**五层**：

- **配置层 `McpConfig`**：server 定义存取（[mcp-config.ts](node-pi/server/src/services/mcp/mcp-config.ts)）。每个 server 有 `scope`（`user` / `workspace`）、传输方式（`stdio` / `streamable HTTP`）、命令/参数/env、URL/headers、`enabled` 开关、`approval: "required"` 审批开关，持久化到磁盘。
- **连接池 `McpClientManager`**：进程级单例，用官方 `@modelcontextprotocol/sdk` 的 `Client` 建连（[mcp-client-manager.ts](node-pi/server/src/services/mcp/mcp-client-manager.ts)）。键是 `{cwd}:{serverName}`，**同一工作区多个会话共享同一连接**，避免重复 spawn 子进程。`sync()` 把连接对账到期望配置（配置变更/删除/禁用/指纹变化就断开重连），`connect` 时 `client.connect(transport)` + `listTools()` 做工具发现。
- **门面服务 `McpService`**：组合配置与连接池，统一入口（[mcp-service.ts](node-pi/server/src/services/mcp/mcp-service.ts)）。关键是 `toolsFor()`——把已连接 server 的工具转成 Pi 的 `ToolDefinition`，工具名序列化成 `mcp__<server>__<tool>`，建立 `toolIndex` 权威映射（处理跨 server 重名冲突）；`callTool()` 按 Pi 工具名解析回 server/tool 委托连接池执行。
- **接入层 `buildMcpExtension`（内联扩展）**：MCP 真正进入 Agent 工具链路的地方（[mcp-extension.ts](node-pi/server/src/services/mcp/mcp-extension.ts)）。扩展工厂被每个会话的资源加载器调用：`await service.ensure(cwd)` 对账连接 → `toolsFor(cwd)` 把当前工具集 `pi.registerTool()` 注册进会话；同时注册 `tool_call` 钩子——对 `approval: "required"` 的 server 工具复用 `ToolApprovalBroker` 走人工审批。
- **REST 层**：`/api/mcp` 提供 server 增删改查、试连（`probe` 不占连接池）、强制重连，前端 `McpConfig.vue` 展示连接状态徽标和工具清单。

一个关键设计：扩展是**内联**的（闭包直连 `McpService` 单例），多个会话共享同一 MCP 连接，而不是各 spawn 一份子进程。MCP 审批等待窗口放宽到 120 秒。

### 源码位置

- 内联扩展接入（注册工具 + 审批钩子）：[mcp-extension.ts:23-52](node-pi/server/src/services/mcp/mcp-extension.ts#L23-L52)
- MCP 门面（ensure / toolsFor / callTool / 工具名索引）：[mcp-service.ts:46-188](node-pi/server/src/services/mcp/mcp-service.ts#L46-L188)
- 连接池（stdio/HTTP 传输、对账、探活）：[mcp-client-manager.ts:49-297](node-pi/server/src/services/mcp/mcp-client-manager.ts#L49-L297)
- 配置层（作用域 / 传输 / 审批开关）：[mcp-config.ts:21-50](node-pi/server/src/services/mcp/mcp-config.ts#L21-L50)
- 前端配置面板：[McpConfig.vue](web/src/components/McpConfig.vue)
- 接入文档：[docs/node-mcp-guide.md](docs/node-mcp-guide.md)

---

## Q10：你说设计会话级 Agent Runtime 配置预设机制，具体说说是什么？不同预设如何实现不同的设置？

### 面试者回答

**是什么**：预设 = 「新建一个会话时，Agent Runtime 的一组初始配置」，不是运行时切状态，而是会话创建那一刻定死的内核参数。一个预设包含五件事：

- `systemPrompt`：会话系统提示词（空串 = 用 SDK 默认，走 `SYSTEM.md`/`AGENTS.md` 文件级提示词发现）
- `toolNames`：工具白名单（哪些工具对模型可见）
- `compaction`：上下文压缩策略（是否启用、保留多少 token、预留多少）
- `provider` / `modelId`：默认模型
- `thinkingLevel`：思考强度等级

**内置 vs 自定义**：内置 `coding-agent` 预设（[preset-service.ts:60-71](node-pi/server/src/services/preset-service.ts#L60-L71)）所有字段都是「未指定」，即完全用 SDK 默认值，不可改删；自定义预设由用户增删改，持久化到 `~/.pi/agent/node-server-presets.json`（[preset-service.ts:73-144](node-pi/server/src/services/preset-service.ts#L73-L144)），原子写（临时文件 + rename），校验在写方向做（`parsePresetInput`，provider 与 modelId 必须成对、thinkingLevel 必须在合法集合内）。

**不同预设如何实现不同的设置**——「前端预填 + 后端映射」两条路径：

- **前端预填**：选择预设时 `applyPreset()`（[useAgentSession.ts:479-494](web/src/composables/useAgentSession.ts#L479-L494)）把预设拆开——模型/思考等级/工具直接预填到会话控件里（仍可手动改），系统提示词和压缩策略记入会话状态。创建会话时（[useAgentSession.ts:372-383](web/src/composables/useAgentSession.ts#L372-L383)）作为 `systemPrompt` / `compaction` / `provider` / `modelId` / `thinkingLevel` / `toolNames` 展开进 `POST /api/agent/new` body。
- **后端映射**：`OriginalPiSessionFactory.create()`（[agent-registry.ts:222-262](node-pi/server/src/services/agent-registry.ts#L222-L262)）把每个字段映射到 `createAgentSession()`：
  - `systemPrompt` → 资源加载器的 `systemPrompt`，**空串不传**（[agent-registry.ts:346-348](node-pi/server/src/services/agent-registry.ts#L346-L348)），否则会让 loader 跳过 `SYSTEM.md`/`AGENTS.md` 发现；
  - `compaction` → 每会话独立的 `SettingsManager`，仅内存 `applyOverrides({ compaction })`（[agent-registry.ts:240-246](node-pi/server/src/services/agent-registry.ts#L240-L246)），不写 settings.json；
  - `model` → `runtime.getModel(provider, modelId)`，未指定用 Pi 默认模型；
  - `thinkingLevel` → 透传给 SDK（"off" 对任何模型都接受）；
  - `toolNames` → `tools` 工具白名单。
  - 扩展开关：`extensions.{planMode, approval}` 控制是否注入审批/Plan 扩展（[agent-registry.ts:337-342](node-pi/server/src/services/agent-registry.ts#L337-L342)）。

所以不同预设的「不同」，落在**会话创建那一刻的内核参数不同**：系统提示词（loader 注入）、压缩策略（独立 SettingsManager）、模型与思考等级（createAgentSession 参数）、工具集（白名单 + 扩展开关）。预设本质是这组参数的**命名快照**。

### 源码位置

- 预设持久化 + 内置合成 + 校验：[preset-service.ts:60-213](node-pi/server/src/services/preset-service.ts#L60-L213)
- 预设 REST 层（CRUD）：[routes/presets.ts:17-34](node-pi/server/src/routes/presets.ts#L17-L34)
- 后端字段映射到 `createAgentSession`：[agent-registry.ts:222-262](node-pi/server/src/services/agent-registry.ts#L222-L262)
- 空 systemPrompt 不传（保留文件级提示词发现）：[agent-registry.ts:346-348](node-pi/server/src/services/agent-registry.ts#L346-L348)
- 每会话独立 SettingsManager 覆盖压缩策略（不写磁盘）：[agent-registry.ts:240-246](node-pi/server/src/services/agent-registry.ts#L240-L246)
- 前端 applyPreset 预填 + 建会话时展开：[useAgentSession.ts:479-494](web/src/composables/useAgentSession.ts#L479-L494)、[useAgentSession.ts:372-383](web/src/composables/useAgentSession.ts#L372-L383)
- 预设配置面板：[PresetConfig.vue](web/src/components/PresetConfig.vue)

---

## Q11：你设计预设机制是为了什么？和垂类 Agent 的关系？

### 面试者回答

预设本质是「**垂类 Agent 的声明式工厂**」。一个 Agent 的「身份」由四样东西决定：系统提示词（人设、领域约束、知识入口）、工具集（能力边界）、模型 + 思考等级（推理强度）、记忆配置（上下文压缩策略）。给定不同的组合，就能实例化出一个专门干某类活的垂类 Agent，而**内核一行都不用改**。预设机制就是把这四样打包成可命名、可复用、可一键套用的「配置快照」。

三层价值：

- **创建即定型**：新建会话时选一个预设，`applyPreset` 把系统提示词、工具白名单、模型、思考等级、压缩策略全部预填，`POST /api/agent/new` 展开成 `createAgentSession` 的参数——Agent 从出生的那一刻起就是「某个领域的专家」。
- **垂类化靠组合，不靠写代码**：比如「代码审查」预设：只开 `read`/`grep`/`bash` 只读工具 + 高思考等级 + 「只审查不改代码」系统提示词；「数据库 Agent」预设：系统提示词 + 一个 MySQL MCP server 工具集；「文档撰写」预设：全文件工具 + 低思考等级 + 压缩关掉（要长上下文）。换领域 = 换组合，落点是**配置声明**而非**程序分支**。
- **可沉淀、可分发**：内置 `coding-agent` 不可改删（保 SDK 默认语义），自定义预设落盘 `node-server-presets.json`，团队共享同一套垂类配置。

一句话：预设机制让「垂类 Agent」从需要二次开发的工程问题，变成配置面板里的一次选择。

### 源码位置

- 预设字段定义（提示词/工具/压缩/模型/思考）：[preset-service.ts:35-50](node-pi/server/src/services/preset-service.ts#L35-L50)
- 内置 vs 自定义（合成 + 不可改删）：[preset-service.ts:60-71](node-pi/server/src/services/preset-service.ts#L60-L71)、[preset-service.ts:81-122](node-pi/server/src/services/preset-service.ts#L81-L122)
- 前端选预设 → 预填会话控件：[useAgentSession.ts:479-494](web/src/composables/useAgentSession.ts#L479-L494)
- 建会话时展开成内核参数：[useAgentSession.ts:372-383](web/src/composables/useAgentSession.ts#L372-L383)、[agent-registry.ts:222-262](node-pi/server/src/services/agent-registry.ts#L222-L262)
- 预设配置面板：[PresetConfig.vue](web/src/components/PresetConfig.vue)

---

## Q12：这个项目中哪些内容是你做的？哪些是 Pi 本身就有的你拿来用的？

### 面试者回答

核心原则是「**不重写内核，站在 Pi 肩膀上做增强**」——Agent 的「大脑」全部复用 Pi，我专注做「大脑」之外的工程化。

**Pi 本身就有的（直接拿来用）：**
- **Agent 内核**：agent-loop（模型调用、消息树、分支、工具调用编排）、thinking 思考等级、内置工具（`read`/`edit`/`write`/`bash`/`grep`/`find`/`ls`）、上下文压缩引擎、`SYSTEM.md`/`AGENTS.md` 项目提示词发现。
- **会话持久化**：`SessionManager` 把每个会话写成 JSONL，支持从磁盘恢复完整上下文（含消息树与压缩摘要）。
- **运行时**：`ModelRuntime`（读 `auth.json`/`models.json` 组装模型）、`SettingsManager`、`DefaultResourceLoader`（工具/技能/扩展发现）、内联扩展机制（`pi.on('tool_call')` 等钩子）。

**我做的（在 Pi 之上新增的服务层 + 前端 + 复刻）：**
- **Web 服务化**：Fastify 后端全套——`PiSession` 门面接口、`OriginalPiSessionFactory`（把凭据/模型/设置组装成 SDK 依赖的适配器）、`AgentRegistry`（会话注册 + 事件订阅 + 256 条缓存回放）、`command()` 统一命令分发、SSE 流式（`Last-Event-ID` 断点续传 + 心跳）、认证与统一错误契约。
- **Web 专属能力**：工具审批（`ToolApprovalBroker` 风险分级 + 人工确认）、Plan 模式状态机（`PlanModeService`）、MCP 接入（`McpService`/`McpClientManager`/内联扩展）、会话预设（`PresetService`）、模型/工作区/技能配置服务。
- **整个 Vue 前端**：三栏 IDE、fetch+ReadableStream 的 SSE 解析与断线重连、不定高虚拟列表、审批弹窗、Plan 进度、模型/MCP/预设/技能配置面板。
- **Python 三层复刻内核**（`pi-python`）：对原版内核的学习性复刻，作为行为对照。

**职责边界一句话**：Pi 决定「Agent 怎么想、怎么干活」，我决定「Agent 以什么姿态暴露给 Web、如何被人类监督与配置」。

### 源码位置

- Pi 依赖组装（`createAgentSession`/`ModelRuntime`/`SettingsManager`）：[agent-registry.ts:222-262](node-pi/server/src/services/agent-registry.ts#L222-L262)、[agent-registry.ts:317-324](node-pi/server/src/services/agent-registry.ts#L317-L324)
- 我的服务层：审批 [tool-approval.ts](node-pi/server/src/services/tool-approval.ts)、Plan [plan-mode-service.ts](node-pi/server/src/services/plan-mode-service.ts)、MCP [mcp/](node-pi/server/src/services/mcp/)、预设 [preset-service.ts](node-pi/server/src/services/preset-service.ts)
- 前端全部：[web/src](web/src/)
- Python 复刻：[pi-python/src](pi-python/src/)
- Pi SDK 内部设计参考：[pi_design.md](pi_design.md)

---

## Q13：你的 Agent 记忆机制是怎么设计的（短期会话记忆 + 上下文压缩 + AGENTS.md）？

### 面试者回答

记忆分三层，对应三种生命周期：

**① 短期会话记忆 —— 会话 JSONL 持久化（可恢复）**
每次会话的每一条消息、工具调用、分支节点都实时写进 `~/.pi/agent/sessions/<编码后cwd>/<sessionId>.jsonl`（`SessionManager` 负责）。进程重启、机器重启后，`SessionManager.open(path)` 从磁盘恢复完整上下文：消息树、分支、压缩摘要全都在。我的后端 `open()`（[agent-registry.ts:298-309](node-pi/server/src/services/agent-registry.ts#L298-L309)）把这个能力暴露成 Web 的「恢复会话」，侧栏列表靠 `listPersistedSessions` 扫描 sessions 目录。会话树还支持 `navigate_tree`/fork/merge——记忆不是一维的，是分叉的，可回到历史任一点重新展开。

**② 中期记忆 —— 上下文压缩（窗口管理）**
长期对话会撑爆模型上下文窗口。触发条件是 `shouldCompact`：`contextTokens > contextWindow - reserveTokens`，即「上下文快满、且要给模型留出回复余量」时（Pi SDK `compaction.js:160-163`，见 `pi_design.md`）。压缩时 `findCutPoint` 按 `keepRecentTokens` 找切割点，**早期轮次由模型自身归纳成摘要**（`generateSummaryWithUsage`，可把上一轮摘要滚动传入做滚动式摘要），最近窗口原样保留。Web 层呈现：`compaction_start`/`compaction_end` SSE 事件驱动前端转圈与错误提示（[useAgentSession.ts:327-332](web/src/composables/useAgentSession.ts#L327-L332)），工具栏 contextUsage 百分比实时显示窗口占用，还有手动 `compact` 按钮（[useAgentSession.ts:534-545](web/src/composables/useAgentSession.ts#L534-L545)、后端命令 [agent-registry.ts:588-589](node-pi/server/src/services/agent-registry.ts#L588-L589)）。压缩策略本身可配置，且能随预设按会话覆盖（每会话独立 SettingsManager 内存覆盖，不写磁盘）。

**③ 长期记忆 —— AGENTS.md / SYSTEM.md（项目绑定）**
这是「跨会话、绑定项目」的记忆。`DefaultResourceLoader` 从 cwd 逐级向上找 `AGENTS.md`/`CLAUDE.md`（加上全局 `agentDir` 一份），并加载项目 `.pi/SYSTEM.md` 与全局 `SYSTEM.md` 作为系统提示词（Pi SDK `resource-loader.js:27-50`、`:809-824`）——所以每次会话 Agent 都「记得」这个项目的约定、架构、命令。我的预设系统提示词与此配合的关键：`systemPrompt` 为空串时**不传入** loader（[agent-registry.ts:346-348](node-pi/server/src/services/agent-registry.ts#L346-L348)），保留文件级提示词发现；非空才覆盖，做垂类人设。

三层串起来：**短期靠 JSONL 保存对话本身，中期靠压缩保住窗口内最相关的部分，长期靠 AGENTS.md 沉淀项目级知识**。Web 层把三层都可视化（会话树、压缩进度、上下文占用、AGENTS 提示词来源）。

### 源码位置

- 会话持久化（恢复/扫描）：[agent-registry.ts:265-309](node-pi/server/src/services/agent-registry.ts#L265-L309)
- 压缩触发/切割/摘要（Pi SDK）：见 [pi_design.md](pi_design.md) 第 4 节
- AGENTS.md/SYSTEM.md 发现（Pi SDK）：见 [pi_design.md](pi_design.md) 第 5.2 节
- Web 层压缩呈现 + 手动压缩：[useAgentSession.ts:327-332](web/src/composables/useAgentSession.ts#L327-L332)、[useAgentSession.ts:534-545](web/src/composables/useAgentSession.ts#L534-L545)
- 压缩策略随预设按会话覆盖：[agent-registry.ts:240-246](node-pi/server/src/services/agent-registry.ts#L240-L246)

---

## Q14：你的 Agent 系统工具系统是怎么设计的？工具执行出错怎么办？怎么校验工具参数？

### 面试者回答

**工具系统设计**——工具是「一等公民」的 `ToolDefinition`（Pi 的规范，我按它接入）：

- **结构**：`name`（LLM 调用名）+ `label` + `description`（给 LLM 的用途说明）+ `promptGuidelines`（注入系统提示词的用法指引）+ `parameters`（TypeBox 参数 schema）+ `execute(toolCallId, params, signal, onUpdate, ctx)` 执行函数。
- **注册与发现**：Pi 的 `DefaultResourceLoader` 发现内置工具与技能；自定义工具经 `pi.registerTool()` 注入。我的 MCP 工具就走这条路——`buildMcpExtension` 把 MCP server 的工具转成 `ToolDefinition` 批量注册（[mcp-extension.ts:29-33](node-pi/server/src/services/mcp/mcp-extension.ts#L29-L33)），工具白名单 `activeTools` 控制哪些工具对模型可见（[agent-registry.ts:581-585](node-pi/server/src/services/agent-registry.ts#L581-L585)）。

**参数校验（怎么校验工具参数）**——执行前有一套管线（`prepareToolCall`）：

1. **兼容垫片** `prepareArguments`：把 LLM 传的原始参数先规整成 schema 能接受的形状；
2. **正式校验** `validateToolArguments`（pi-ai）：先 `structuredClone` 参数 → `Value.Convert` 按 TypeBox schema 类型强转 → 编译缓存拿校验器 `validator.Check(args)` 通过才放行；**失败抛带格式化详情的错误**——列出每个非法字段路径（`formatValidationPath`）和原因，以及收到的原始参数 JSON，让模型能据此修正；
3. **拦截钩子** `beforeToolCall`：校验通过后进入钩子——**我的审批、Plan 模式、MCP 审批全部落在这里**。Pi 把 `beforeToolCall` 转成扩展的 `tool_call` 事件，审批扩展返回 `{block: true}` 就产生拦截。校验失败/被拦截/被 abort 都会直接产出错误 ToolResult，**不进入真实执行**。

**工具执行出错怎么办**——核心思想是「**错误即数据，永不崩溃**」：

- `executePreparedToolCall` 调 `tool.execute(...)`，支持 `onUpdate` 流式部分结果（`tool_execution_update` 事件）；**执行抛异常不会向上崩掉 agent-loop**，而是用 `createErrorToolResult` 把异常包成一条错误工具结果，标记 `isError`。
- 这条错误结果作为**普通消息回喂给模型**——模型看到「工具 X 失败：原因 Y」，自行决定修正参数重试、换工具、或换策略。Agent 循环不会因一次工具失败中断。
- 额外防护：`failToolCallsFromTruncatedMessage`——若 assistant 消息撞上输出 token 上限，流式工具参数可能被截断成「解析过但语义不完整」，此时**全部标记为错误**并提示模型重新发出完整调用。

**我在 Pi 之上加的三道闸**：危险命令审批（规则引擎 + 人工确认）、Plan 模式（先规划后执行）、MCP 工具审批（`approval: required`）——都挂在 `beforeToolCall` 拦截点上，增强工具链路的安全与可控性，不改内核的校验与执行逻辑。

### 源码位置

- ToolDefinition 接口（Pi SDK）：见 [pi_design.md](pi_design.md) 第 2.1 节
- 工具执行 + 校验管线 `prepareToolCall`（Pi SDK）：见 [pi_design.md](pi_design.md) 第 2.2 节
- 参数校验 `validateToolArguments`（Pi SDK）：见 [pi_design.md](pi_design.md) 第 2.3 节
- 出错包装 + 截断保护（Pi SDK）：见 [pi_design.md](pi_design.md) 第 2.4 节
- 我的落点：审批拦截 [tool-approval.ts:234-251](node-pi/server/src/services/tool-approval.ts#L234-L251)、MCP 工具注册与审批 [mcp-extension.ts:23-52](node-pi/server/src/services/mcp/mcp-extension.ts#L23-L52)、工具白名单 [agent-registry.ts:581-585](node-pi/server/src/services/agent-registry.ts#L581-L585)

---

## Q15：你做的「Agent 可观测性」到底观测了什么？怎么保证它不拖慢 Agent？

### 面试者回答

先讲**怎么观测**，再讲**观测了什么**，最后是**为什么不拖慢**。

**怎么观测——唯一插桩点 + 只读内存事件。** 埋点只放在事件分发的**唯一出口**（`AgentRegistry.publish()` 尾部调用 `SessionLedger.record()`），只读 SDK 的内存事件，不改动 Agent 逻辑，也不在别处新增写入点。这样「观测」永远是主链路的下游旁路，而不是参与者。

**写入策略——异步队列 + 可降级。** 记录先入队（约 250ms / 200 条批量落 SQLite），队列超限丢最旧并计数，连续 flush 失败进入 degraded 并丢弃后续写入；**所有入口 try/catch，异常只 warn、绝不冒泡到 agent loop**。另有一个 `NullTraceRepository` 空实现——`createApp()` 不传 trace 配置时就不写盘，保证测试环境安全。实测单条同步记录开销 p50 0.004ms / p95 0.011ms，肉眼可见的只有每 200 条一次的批量 flush（约几毫秒）。

**观测了什么（四个关键口径）：**
- **run 的边界取 `agent_settled`**，不是 `agent_start`。SDK 在一轮里可能因自动重试、上下文压缩、续跑多次发 `agent_start`，只有 `agent_settled` 在所有自动行为收敛后发一次；取错边界会把一次请求拆成多个 run，统计全错。
- **每次 run 记录**：首字延迟（TTFT）、总耗时、token 用量、provider 与模型；步骤级还记每个工具的调用与结果。
- **把「策略拦截」与「工具真实失败」分开归因**。这是个真实坑：SDK 拦截工具时并不发 `tool_execution_blocked`，只表现为 `tool_execution_end(isError=true)`。如果不单独记 `blocked_by`（approval / plan_mode / policy），被正确拦下的调用就会被算成「工具失败」，`byTool.errorRate` 从第一天就是错的。
- **明细 + 预聚合双层**：明细到步骤级可下钻，同时维护 `run_rollups(day, cwd, provider, model)` 预聚合表——`totals`/`byModel`/`daily` 同源。`prune` 只删明细、不动预聚合，所以历史趋势完整保留。

**为什么不拖慢——选型是被实测逼出来的。** M0 阶段实测发现瓶颈不在写入（SQLite 批量 200 行 p95 0.65ms），而在**无索引全表聚合**（20 万行 GROUP BY 要 96ms）。所以读路径一律走写入时维护的预聚合表，分位数走「范围内最近 2000 条样本」的有界扫描，绝不在请求里跑全表。

安全上还有两点：默认只存摘要 digest + 120 字符预览（要看正文要显式开 `PI_NODE_TRACE_CONTENT=1`），并对 `sk-`、`Bearer`、`apiKey` 等形态统一脱敏。前端是设置里的「用量」面板，能看到趋势、按模型/工具聚合、缓存命中率，并下钻到单次运行。

### 源码位置

- 唯一插桩与事件→run/step 规约：[session-ledger.ts:159](node-pi/server/src/services/observability/session-ledger.ts#L159)
- 写入队列 / 超限丢最旧 / 降级 / 空实现：[trace-repository.ts:164](node-pi/server/src/services/platform/trace-repository.ts#L164)、[trace-repository.ts:286](node-pi/server/src/services/platform/trace-repository.ts#L286)
- 聚合与分位数（有界样本）：[metrics.ts:135](node-pi/server/src/services/observability/metrics.ts#L135)、[metrics.ts:152](node-pi/server/src/services/observability/metrics.ts#L152)
- REST（summary / runs / runs/:id / DELETE runs）：[routes/observability.ts:90-125](node-pi/server/src/routes/observability.ts#L90-L125)
- 前端用量面板：[ObservabilityPanel.vue](web/src/components/ObservabilityPanel.vue)
- 设计文档：[docs/node-observability-m1.md](docs/node-observability-m1.md)

---

## Q16：任务领域（M2）为什么状态要由步骤聚合？乐观并发怎么防覆盖？

### 面试者回答

**是什么**：把「用户要 agent 做的一件事」建模成任务 + 步骤，任务有 `revision`（版本号）、`execution`（执行态：租约/在飞/计划），步骤有状态、证据、验证声明。对外 8 个 REST + SSE `task_updated` 实时推送，前端有任务面板。

**状态唯一真相源＝步骤**：任务状态由步骤聚合推导（`deriveTaskStatus`），还有未完成步骤就不算完成；只有 `cancelled` 是冻结的，手工设置的 status 会在下一次步骤变更时被重新聚合——**不保留隐藏状态**。另一个细节：「已开工」不能只看 `in_progress`，否则「两步做完一步」会被显示成尚未开始。

**乐观并发用单语句**：所有变更带 `ifRevision`，落到一条 `UPDATE ... SET revision = revision + 1 WHERE id = ? AND revision = ?`，按影响行数判定，冲突返回 409 并回传**当前真实版本号**（方便前端刷新重试）。

**版本号语义（容易答错）**：`revision` 是**用户可见内容的版本**。心跳、租约、在飞这些运行时写入不占版本号（`keepRevision: true`）；幂等命令「无变化」就既不写库也不广播、不动版本号。否则模型思考期间手里的版本就过期，`update_plan`/面板编辑会频繁 409。

**为什么不复用 trace 的写入队列**：两者性格相反——trace 可丢、可降级、失败只 warn；任务状态是用户可见数据，必须**同步落库、错误必须冒泡**。它们共用同一个 SQLite 连接（`DatabaseSync` 单线程同步，不会交错）。

### 源码位置

- 领域模型与状态聚合：[task-model.ts:169](node-pi/server/src/services/platform/task-model.ts#L169)、[task-model.ts:120](node-pi/server/src/services/platform/task-model.ts#L120)
- 用例层（乐观锁 / 广播 / keepRevision）：[task-service.ts:132](node-pi/server/src/services/task-service.ts#L132)
- REST 与 SSE：[routes/tasks.ts:51-145](node-pi/server/src/routes/tasks.ts#L51-L145)、[agent-registry.ts:1096](node-pi/server/src/services/agent-registry.ts#L1096)
- 设计文档：[docs/node-task-domain-m2.md](docs/node-task-domain-m2.md)

---

## Q17：断点续跑（M3）最难的不是「记住进度」，你们怎么做的？

### 面试者回答

先破一个误解：难点不是「把进度存下来」，而是**进程被杀之后，无法判断上一步到底做没做完**——盲目重跑会产生重复副作用，而且很多副作用不可逆。

**机制一：执行租约（谁在跑）。** owner = 「进程号 + 本次开机标识」，TTL 30 秒，每 10 秒续期，租约存在任务自己身上。服务重启后上一任 owner 自然过期。注意：库里分不出「崩溃 / 强杀 / 优雅退出」，所以统一按「租约过期 + 任务还在进行」判定为中断。

**机制二：在飞动作 + 副作用分级。** 从 turn/tool 钩子记录当前在飞动作，分三级：`none` / `write` / `unknown`。文件写入类记 `write`；`bash` 用审批规则判定——命中危险/敏感规则算 `write`，未命中算 `unknown`（普通命令也可能是写，宁可多要一次确认）。这里有一处比直觉更保守的设计：`lastSideEffect` 在步骤完成前一直保留，否则「写完文件、还没打勾就被杀」会被判成「两步之间」而自动重跑，正是重复副作用的来源。

**机制三：三种恢复动作。** 无副作用 → 自动继续；有副作用且有产物声明 → 看文件在不在；否则 → 人工确认。产物验证只做**只读 stat**，不执行任何命令（`command` 类验证等于绕过审批跑任意 shell，所以留给 M4 的证据校验）。

**三条不可让步的规则（背下来）：**
1. **只列不跑**：启动时只扫描生成恢复清单（日志 + SSE + 面板），续跑必须由人点击触发——模型可能在无人值守时做不可逆操作。
2. **无法判定副作用必须人工确认**。
3. **产物在就补记完成、绝不重跑**；产物不在就标 blocked，`retry_step` 是唯一逃生门。

**接口**：`GET /api/tasks/recovery` 取清单、`POST /api/tasks/:id/resume` 以 202 异步接单，SSE `task_recovery_required` 通知前端；不带确认的 resume 返回 409 `task_needs_confirmation`。续跑时执行器会注入 `[TASK RESUME]` 隐藏上下文，并**强制模型先对账**再继续。

一个设计洁癖：执行态的写入也走 `TaskService`（乐观锁 + 广播），不绕开它直接写库——否则面板手里的 `revision` 会静默落后，用户下一次点击就莫名 409。前端也做了「409 自动刷新后重试一次」。

### 源码位置

- 租约（owner / TTL / 续期）：[task-lease.ts:29](node-pi/server/src/services/task-lease.ts#L29)、[task-lease.ts:67](node-pi/server/src/services/task-lease.ts#L67)
- 在飞动作与副作用分级：[task-recovery-extension.ts](node-pi/server/src/services/task-recovery-extension.ts)、[task-recovery.ts:50](node-pi/server/src/services/task-recovery.ts#L50)
- 恢复判定与清单：[task-recovery.ts:102](node-pi/server/src/services/task-recovery.ts#L102)
- 续跑（[TASK RESUME] 注入 / 发 prompt / 续期保活）：[task-runner.ts:56](node-pi/server/src/services/task-runner.ts#L56)、[task-runner.ts:309](node-pi/server/src/services/task-runner.ts#L309)
- 接口：[routes/tasks.ts:84](node-pi/server/src/routes/tasks.ts#L84)、[routes/tasks.ts:92](node-pi/server/src/routes/tasks.ts#L92)
- 设计文档：[docs/node-task-recovery-m3.md](docs/node-task-recovery-m3.md)

---

## Q18：Plan 模式（M4）为什么要重构？「计划」为什么不单独做一套模型？

### 面试者回答

**旧设计为什么崩**：老实现靠**模型在回复里写标记**（比如 `[PLAN]`）来识别计划，然后由后端解析文本切状态。这套东西出了问题都是玄学——模型措辞一变就解析失败，而且还有 8 个缺陷（步骤状态不同步、执行期越权、上下文重复注入等）。挖到最底下一个共同根因是：**SDK 的 `session_start` 扩展事件在 Node 后端从未被触发**（它只被 CLI 的 interactive/print/rpc 三种模式调用，而 Node 后端直接走 `createAgentSession()`），导致 `PlanModeService` 的状态机从不登记，`plan_*` 命令全部 409 `plan_unavailable`——**Plan 模式在生产环境完全不可用**。修法是后端自己在 `register()` 里派发 `session_start`，并且和「抑制官方同名扩展」两个修复必须同时上线（单独修前者会把双状态机激活，引入隐形规划期）。

**重构后的三条不变量：**
1. **只有用户能确认执行**。模型只能 `submit_plan` 提交计划，必须用户确认后才进入执行；模型想主动发起规划，只能用 `propose_plan` **征求同意**——提议权给模型，决定权留给用户。
2. **步骤完成必须有证据，且按 verification 校验**。`file` 查产物存在；`command` 只校验「确实跑过且如实上报」，**不重跑**（重跑等于绕过审批执行任意 shell）；`manual` 要求给出结论。
3. **规划期只读**，靠能力分类：审批规则 → 命令逐段拆解 → 程序名归类，**未归类的一律不放行**；最终由 `tool_call` 拦截兑现。

**结构性决策：Plan 是 Task 的受控视图**，不是第二套模型。计划就是 `origin='plan'` 的任务，`planId === taskId`、同一张表、同一份状态，落库状态只有四种意图，`completed`/`abandoned` 由任务状态推导。这样从根上避免了「两套状态互相打架」。

**最亮的反直觉取舍：工具集恒定。** 初版我们让 Plan 开关动态增删工具（规划期收起写工具、执行期放开）。这错得离谱：**LLM 请求的前缀缓存会把工具定义算进前缀**，工具集一变，整段缓存失效，成本和延迟陡增。所以改成：计划工具从会话创建起就常驻 `activeTools`，计划开始/结束一律不增删，只读完全由拦截兑现。同时注入也做了去抖——规划/执行两种上下文内容不变就不重复注入，同类型只留最后一条。

**验证体系**：spike ⑦（真实 SDK + 假模型）跑完整旅程并断言「模型全程零标记」、工具集在四个时点一字不变；`npm run eval` 用 13 个 golden 用例 + 三项阈值门禁（pass@1 100%、计划一次通过率 ≥80%、零残留旧标记）。

### 源码位置

- 状态机 / 上下文注入 / 命令分发：[plan-mode-service.ts:561](node-pi/server/src/services/plan-mode-service.ts#L561)、[plan-mode-service.ts:491](node-pi/server/src/services/plan-mode-service.ts#L491)
- 五个计划工具 + propose_plan：[plan-tools.ts:50](node-pi/server/src/services/plan-tools.ts#L50)、[plan-tools.ts:495](node-pi/server/src/services/plan-tools.ts#L495)
- 规划期能力分类：[plan-policy.ts:29](node-pi/server/src/services/plan-policy.ts#L29)、[plan-policy.ts:378](node-pi/server/src/services/plan-policy.ts#L378)
- 纯投影 PlanView：[plan-model.ts:39](node-pi/server/src/services/platform/plan-model.ts#L39)、[plan-model.ts:96](node-pi/server/src/services/platform/plan-model.ts#L96)
- 证据校验分级：[step-verification.ts:53](node-pi/server/src/services/platform/step-verification.ts#L53)
- 契约文档：[docs/node-web-plan-mode.md](docs/node-web-plan-mode.md)、实现与取舍：[docs/node-plan-mode-m4.md](docs/node-plan-mode-m4.md)、缓存稳定性：[docs/node-plan-cache-stability.md](docs/node-plan-cache-stability.md)

---

## Q19：向用户提问通道（ask_user）为什么做成「挂起」而不是「结束本轮」？

### 面试者回答

**它是什么**：除了危险命令审批之外的第二条人机交互通道。工具可以挂起本轮，向用户提问（一次最多 8 题，每题支持选项 / 多选 / 自由输入，最多 12 个选项），用户答完后**答案作为工具返回值回流**，模型在**同一次工具调用里**继续往下走。

**为什么是挂起而不是结束本轮**：旧做法是「结束本轮 + 让用户自由文本回复」，但那样模型拿到一条新消息时得猜「这是对我上一个问题的回答，还是一个新需求？」。挂起式让答案以结构化形式回流，语义确定。

**与 Plan 解耦**：它是**通用通道**，任何会话都激活，计划结束后依然可用。所以计划工具清单只剩四个，`ask_user` 单独注册。

**必须有确定的失败路径**：超时（10 分钟）/ 取消 / 中止 / 会话关闭，全部按「未回答」结算，并且明确要求模型「按最合理假设继续并写明假设」——不报错、也不永久挂起。

**两条刻意的取舍**：一次只允许一个挂起提问（前端只有一个弹窗，要并行问就把问题放进同一次调用）；默认允许自由输入（选项永远可能不全）。

**「谁在等用户」只有一个真相源**：这个状态只在挂起队列里，不在任务/计划里再镜像一份（M4.1 把 `PlanView.question*` 删掉了）。提交时也踩过一个只有真实浏览器才暴露的坑：前端状态合并逐字段拷贝时漏了 `pendingQuestion`，SSE 推送的提问状态被静默丢弃，后端与 eval 全绿、界面就是不弹窗。

### 源码位置

- 挂起队列 / 超时 / 结算 / 答案渲染：[user-question.ts:198](node-pi/server/src/services/user-question.ts#L198)、[user-question.ts:397](node-pi/server/src/services/user-question.ts#L397)
- 工具与上限：[user-question.ts:26](node-pi/server/src/services/user-question.ts#L26)
- 弹窗：[QuestionDialog.vue](web/src/components/QuestionDialog.vue)
- 契约文档：[docs/node-question-channel.md](docs/node-question-channel.md)

---

## Q20：子代理（Subagent，M5）你是怎么做的？为什么不用官方扩展？

### 面试者回答

**为什么不用官方子代理扩展**：官方实现是 **spawn 一个独立的 `pi` 子进程**，这导致它拿不到 Web 的审批通道、不进 trace 树、不受租约约束、无法离线评测；而且它的预设写死了 Claude 模型，本机只鉴权了 DeepSeek，一调用就报「模型需要 provider 鉴权」直接失败。所以改成**内联实现 + 同名接管**——把 `subagent` 加进「被内联接管的扩展目录」名单，只影响本服务的加载，**不动用户磁盘文件，CLI 照常运行**。

**核心判断：子会话就是一个会话。** 子代理按预设（`~/.pi/agent/agents/*.md` + 项目级 `.pi/agents/`）在**进程内**通过同一套会话注册表创建子会话。因为是同一套设施，审批、trace、任务绑定天然生效——不需要为子代理另写一套。

**三条不变量：**
1. **不能递归是结构保证**：到 `maxDepth` 的子会话**根本不注册这个工具**，不是运行时判断拒绝。
2. **只读预设真的只读**：子会话工具集 = 预设工具集，不并入 MCP / 计划工具 / `ask_user`。
3. **一定要收尾**：无论成功、失败、超预算、取消还是停机，子会话都会被回收（取消沿多个入口级联）。

**预算建立在「对方真的会上报」的指标上**：很多 provider（如 DeepSeek）上报成本恒为 0，用美元上限形同虚设。所以预算以**轮数 + token + 时限**为主，超限 abort 但**带回已产出的摘要**。

**两个接缝设计**：审批弹窗**挂到父会话**（子会话没有自己的界面，没人订阅它的流），`approve_tool` 也只用父会话 id；trace 树通过 `parentRunId` 把子 run 挂到父 run 下；子代理的成本算**父任务**的（它继承父会话的任务绑定）。子会话落 `~/.pi/agent-node-server/subagents/`，不进 CLI 的会话列表。

**失败是数据，不是异常**：子代理执行失败会作为**结果**返回给父会话，只有「根本没起来」才抛异常。返回的只有摘要，并明确要求父会话**自己核实**，不要盲信。

### 源码位置

- 服务（创建 / 预算 / 并发闸门 / 取消级联 / 扩展）：[subagent-service.ts:195](node-pi/server/src/services/subagent-service.ts#L195)、[subagent-service.ts:55](node-pi/server/src/services/subagent-service.ts#L55)
- 工具：[subagent-tools.ts:126](node-pi/server/src/services/subagent-tools.ts#L126)
- 预设发现与只读判定：[subagent-presets.ts:96](node-pi/server/src/services/subagent-presets.ts#L96)、[subagent-presets.ts:38](node-pi/server/src/services/subagent-presets.ts#L38)
- 模型解析与回退：[subagent-models.ts:37](node-pi/server/src/services/subagent-models.ts#L37)
- 同名接管名单：[agent-registry.ts:69](node-pi/server/src/services/agent-registry.ts#L69)
- 前端委派卡片：[SubagentCallBlock.vue](web/src/components/SubagentCallBlock.vue)
- 设计文档：[docs/node-subagent-m5.md](docs/node-subagent-m5.md)

---

## Q21：MCP 支持是怎么扩展到「模板库」的？凭据安全怎么保证？

### 面试者回答

**背景**：有人反馈「支持的 MCP 太少」。排查后发现**协议层本来就能加任意 server**（stdio 子进程 + streamable-http 静态头、用户级/工作区级两层配置合并、预设白名单、每 server 可单独要求审批都已就绪），缺的是**目录**——用户得自己知道包名、参数、环境变量。所以这一版交付的是**模板库**，不是新协议能力。

**模板库**：内置 18 个模板 / 7 组，`GET /api/mcp/templates` 返回，每条附 `requiresCredentials`（是否需要凭据）和 `canAddDirectly`（能否一键添加）。前端是分组卡片 + 风险徽标 + 一键添加/填入表单。

**凭据安全是这一版的重点**：MCP 配置文件（`mcp.json`）**与原版 CLI 共享**，所以里面绝不能出现明文密钥。规则是**凭据只能写成 `$ENV` 引用**，并且 env、headers、**args 三处都要插值**——很多 server 只能用 `--access-token=...` 这种方式传凭据，如果 args 不插值，用户就只能把密钥明文写进共享配置文件。模板表还有个 `assertTemplateTable()` 自检：重复 id、缺 command/url、出现明文密钥、外部写模板没建议审批，都会直接失败。

**一条克制的取舍**：`needsInput` 的模板（比如 filesystem 缺根目录、uvx 系缺项目路径）**不允许一键添加**——否则会加出一个起不来的 server，比「多一步填表」更糟。另外如实标注能力：`access`（只读 / 本地写 / 外部副作用）+ `suggestApproval`（外部写一律建议审批）+ 工具数量提示（工具都进系统提示词，装太多会分散模型注意力）。

### 源码位置

- 模板表 + 自检 + `@fixture:` 动态路径：[mcp-templates.ts](node-pi/server/src/services/mcp/mcp-templates.ts)
- args / env / headers 的 `$ENV` 插值：[mcp-client-manager.ts](node-pi/server/src/services/mcp/mcp-client-manager.ts)
- REST：`GET /api/mcp/templates`：[routes/mcp.ts](node-pi/server/src/routes/mcp.ts)
- 前端模板库面板：[McpConfig.vue](web/src/components/McpConfig.vue)
- 文档：[docs/node-mcp-guide.md](docs/node-mcp-guide.md) §3

---

## Q22：你怎么保证 Agent 行为的改动是可回归的？（CI 门禁）

### 面试者回答

Agent 的行为是不确定的，改了提示词或策略后很难判断是变好还是变坏。我的办法是**把「系统对模型行为的处理」变成确定性断言**，分两层：

**第一层：能力守护（spike）。** 9 个离线脚本，守住「依赖升级没有悄悄破坏关键能力」——`fauxProvider`（假模型）可解析并能驱动完整 Agent Loop、`node:sqlite` 可用、父子会话识别、`tool_call` 钩子链顺序与阻断语义、`session_start` 派发、Plan 端到端「模型零标记完成规划→确认→执行→完成」，共 30 项断言。它不是探索脚本，是**回归门禁**：一旦依赖升级破坏了这些底层能力，这里立刻红灯。

**第二层：golden set 评测（`npm run eval`）。** 用脚本化的假模型驱动**真实管线**（计划工具 → 任务服务 → 续跑租约 → 计划视图投影），断言的是「系统对这段模型行为的处理是否正确」，而不是模型聪不聪明。13 个确定性用例 + 三项阈值门禁：pass@1 100%、计划一次通过率 ≥80%、零残留旧标记（禁止再用文本标记驱动状态）。任何一项不达标，CI 直接红灯。

**CI 结构**（GitHub Actions 三个 job）：`node-backend`（format → typecheck → test → build → spike）、`web`（typecheck → lint → test → build）、`eval`（依赖 node-backend）。当前测试基线是 Node 373 例 / Web 128 例全绿。

**最重要的红线**：整个测试与评测**全程离线、用临时目录、只读 SDK 内存事件**，绝不访问真实 `~/.pi` 或网络——否则评测会污染用户的真实会话和配置。测试替身也不能偏离真实装配路径（评测 harness 走的是构建产物的真实工厂，不是另写一套假装配），避免「评测里跑通的路径和真机不是同一条」这种最没意义的假绿。

### 源码位置

- CI 配置：[.github/workflows/ci.yml](.github/workflows/ci.yml)
- 能力守护脚本（9 个）：[spike/](node-pi/server/spike/)
- 评测 golden set + harness：[eval/run.mjs](node-pi/server/eval/run.mjs)、[eval/harness.mjs](node-pi/server/eval/harness.mjs)
- 测试基线见 [PROGRESS.md](PROGRESS.md)

---

## Q23：Web 端和原版 CLI 共享 `~/.pi/agent`，你怎么保证不破坏 CLI？

### 面试者回答

这是这个项目**最高优先级的约束**：那个目录是原版 pi CLI 的数据目录，CLI 必须能继续以原版行为运行。项目与 CLI **共享会话与配置**，但扩展与 trace 各自独立。原则是一句话：**共享态的增量写入允许，破坏性写入禁止。**

**逐文件边界：**
- `auth.json` / `settings.json` / `models-store.json`：**只读**（pi 自己持 `proper-lockfile` 写入，我们不去碰）。
- `models.json`：pi 侧**只读**，所以我们做增量写没有锁冲突。这是共享态写入的**参考实现**——校验前置、用 spread 保留未知字段、脱敏只作用于读方向（防止密钥外泄）、临时文件 + rename 原子写。
- `sessions/*.jsonl`：pi 的资产，允许新增会话与追加条目，**绝不删除**。
- 本项目自有文件（`mcp.json`、预设、工作区、trace/task 库）落 `~/.pi/agent-node-server/`，不占用 pi 的命名空间。

**禁止清单**：删除 pi 的会话 JSONL、写入时剥离未知字段、写入 pi 无法解析的内容、把明文密钥写进共享配置。

**trace 必须对 CLI 零影响**：只读 SDK 内存事件、只写自己的库文件；`ledger.record()` 一律 fire-and-forget + 异常降级为 warn，**绝不冒泡到 agent loop**。

**测试层面**：所有测试都把 `agentDir` 隔离到临时目录，禁止触碰真实 `~/.pi` 或网络——这也是为什么 `createApp()` 不传 trace 配置时默认不写盘。

一个具体反例：当初发现写 `models.json` 时如果漏掉未知字段，就会破坏 CLI/其它工具写进去的配置，所以最终按「保留未知字段 + 原子写」来做。

### 源码位置

- 共享态写入参考实现（保留未知字段 / 脱敏 / 原子写）：[model-config-service.ts](node-pi/server/src/services/model-config-service.ts)
- 边界逐文件审计与整改清单：[docs/node-platform-m0-spike.md](docs/node-platform-m0-spike.md) 第 3 节
- 行为准则与红线：[CLAUDE.md](CLAUDE.md) 安全规范

