# SSE 流式渲染全链路：从核心发事件到 Markdown 上屏

> 本文按「一条消息从模型吐出第一个 token，到用户看到它渲染成 Markdown」的顺序，
> 把整条流水线完整走一遍。分层对应代码里的四个边界：
>
> ```
> Pi SDK 核心（@earendil-works/pi-coding-agent）
>         │  AgentSessionEvent（subscribe 回调）
>         ▼
> Node 后端（node-pi/server，Fastify）
>         │  SSE 帧（id + data + 空行）
>         ▼
> Vue 前端（web/src，fetch + ReadableStream）
>         │  AgentEvent → AgentStreamState（规约）
>         ▼
> 组件渲染（ChatWindow 虚拟列表 → MessageView → MarkdownContent）
> ```
>
> 涉及的关键文件（全文都会引用）：
>
> | 层 | 文件 | 职责 |
> | --- | --- | --- |
> | 核心 | `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` | 事件发射与订阅 |
> | 核心 | `…/dist/core/extensions/types.d.ts` | `AgentSessionEvent` 类型定义 |
> | 后端 | `node-pi/server/src/services/agent-registry.ts` | 事件编号、缓存、广播（`publish`） |
> | 后端 | `node-pi/server/src/routes/agent.ts` | SSE 路由（hijack、写帧、心跳、重放） |
> | 前端 | `web/src/lib/api.ts` | `fetchAgentEvents`（带 `Last-Event-ID`） |
> | 前端 | `web/src/composables/useAgentSession.ts` | SSE 解析、断线重连、流式合并 |
> | 前端 | `web/src/lib/agent-events.ts` | `reduceAgentEvent` 纯函数状态机 |
> | 前端 | `web/src/components/ChatWindow.vue` | 虚拟列表 + 流式消息渲染 |
> | 前端 | `web/src/components/MessageView.vue` | 单条消息分派（思考/Markdown/工具） |
> | 前端 | `web/src/components/MarkdownContent.vue` | marked + hljs + DOMPurify |

---

## 1. 总览：一条消息的完整旅程

用户点「发送」后，`prompt()` 是**异步长任务**——HTTP 立即返回 202，真正的产出全部走 SSE。
一次 `prompt` 从模型开始到结束，SDK 会按固定顺序喷出一串事件（第 2 节详述）。
后端把这些事件**原样**编上号、存进每会话缓存、再广播给所有 SSE 订阅者。
前端用 `fetch + ReadableStream` 手写解析 SSE 帧，把事件喂给一个纯函数状态机
（`reduceAgentEvent`），流式增量按帧合并，最终落到 `ChatWindow` 的虚拟列表里，
由 `MessageView` 分派到 `MarkdownContent` 完成 marked 渲染。

整个过程里最值得记住的三件事：

1. **`message_update` 是「每 token 一条、且每条都带整条累计消息的全量快照」**——这是上游（SDK）
   给定的形状，直接催生了后端「重放合并」和前端「按帧合并」两处优化（§6、§7.3）。
2. **事件是「原样透传 + 双缓冲」**：SDK 事件不翻译、不裁剪（除重放合并外），先进 `events` 缓存
   （断线重放用），同时广播给在线订阅者。`Last-Event-ID` 让断线重连只补增量。
3. **渲染是「列表外单独流式 + 列表内只放已完结消息」**：流式中的消息不进入虚拟列表
   （否则每 token 触发一次虚拟化重新测量），单独用一个 `<MessageView streaming>` 渲染；
   `message_end` 后才进 `messages` 数组，成为虚拟列表的一行。

---

## 2. 第 0 层：Pi SDK 核心如何发事件

SDK 的 `AgentSession` 内部维护一个监听器列表 `_eventListeners`，所有事件都从
`_emit(event)` 这一处广播：

```js
// agent-session.js（节选）
_emit(event) {
  for (const l of this._eventListeners) l(event);
}
```

真正的「中央分发器」是 `_handleAgentEvent(event)`，它做的事按顺序是：

1. **先发给扩展**（`_emitExtensionEvent`）——审批 / Plan / 观测等内联扩展都在这里挂钩子；
2. **再广播给所有订阅者**（`_emit`，即 Node 后端 `subscribe` 注册进来的回调）；
3. **最后处理持久化**（`message_end` 时把消息 append 进会话 JSONL）。

> 这一步的顺序解释了为什么扩展能「拦截」事件（比如 `{block:true}` 短路后续钩子），
> 以及为什么 Node 后端订阅到的都是「扩展已经处理完」的最终事件。

### 2.1 一次 prompt 的事件序列

SDK 事件类型（`extensions/types.d.ts`）里，和流式渲染直接相关的有：

| 事件 | 时机 | 载荷关键字段 |
| --- | --- | --- |
| `message_start` | 用户消息进入状态时 | `message` |
| `message_end` | 用户/助手消息定稿时 | `message`（含 `stopReason`、`usage`） |
| `agent_start` | agent loop 开始 | — |
| `turn_start` | 每一轮开始 | `turnIndex` |
| `message_update` | **助手流式输出，每 token 一条** | `message`（累计快照）+ `assistantMessageEvent` |
| `message_end` | 助手消息定稿 | `message` |
| `tool_execution_start` / `tool_execution_end` | 工具调用开始/结束 | `toolCallId` / `toolName` / `args` / `result` |
| `turn_end` | 每一轮结束 | `turnIndex` / `message` / `toolResults` |
| `agent_end` | agent loop 结束（可能带 `willRetry`） | `messages` |
| `agent_settled` | 自动重试/压缩/续跑全部收敛后 | — |

一次最简单的「问一句、回一句」大致是：

```
message_start(user) → message_end(user) → agent_start → turn_start(0)
→ message_update × N（流式 token） → message_end(assistant)
→ turn_end(0) → agent_end → agent_settled
```

有工具调用时，在 `message_end(assistant)` 之后插入
`tool_execution_start → tool_execution_end → message_start(toolResult) → message_end(toolResult)`
再进入下一轮 `turn_start(1)`。

### 2.2 `message_update` 为什么是「全量快照」

这是理解后面所有优化的前提。SDK 的 agent loop 每收到一个流式增量，就把
`{ ...partialMessage }` 作为完整消息对象再发一次 `message_update`：

- 好处：订阅者拿到 `event.message` 就是「当前为止的完整回答」，不用自己拼接；
- 代价：一条 5000 字的回答会发**几百上千条** `message_update`，且每条体积随进度线性变大，
  逐条消费的总开销是 **O(n²)**。

这就是 §6（后端重放合并）和 §7.3（前端按帧合并）要解决的核心问题，细节分别见
`docs/web-stream-coalescing.md`。

---

## 3. 第 1 层：Node 后端——订阅、编号、缓存、广播

### 3.1 订阅 SDK 事件（`agent-registry.ts`）

会话登记进注册表时（`register()`），第一件事就是订阅 SDK 事件：

```ts
entry.unsubscribe = session.subscribe((event) => this.publish(entry, event));
```

之后 SDK 每 `_emit` 一次，都会同步触发这里的 `publish()`。注意**订阅发生在
`entries.set()` 之后、`session_start` 派发之前**（顺序见 `register()` 注释），
保证扩展在 `session_start` 里产生的状态快照也能被正确广播。

### 3.2 `publish()`：唯一的事件出口

```ts
private publish(entry: RegistryEntry, payload: StreamEvent['payload']): void {
  this.logSessionEvent(entry, payload);            // 结构化日志（只记元数据）
  this.ledger?.record(this.ledgerContext(entry), payload); // 可观测性插桩（fire-and-forget）
  const event: StreamEvent = { id: entry.nextEventId++, payload };
  entry.events.push(event);                        // 进缓存（重放用）
  if (entry.events.length > MAX_REPLAY_EVENTS) entry.events.shift(); // 超 256 丢最旧
  for (const subscriber of entry.subscribers) subscriber(event);     // 广播
}
```

要点：

- **事件 id 从 1 开始单调递增**，这就是 SSE 的 `id:` 字段，也是 `Last-Event-ID` 的续传依据。
- **双缓冲**：`events` 数组是「历史缓存」（每会话最多 `MAX_REPLAY_EVENTS = 256` 条），
  `subscribers` 集合是「在线连接」。新订阅者先补发缓存，再收实时。
- **可观测性是旁路**：`ledger.record()` 位于 `publish()` 尾部，`SessionLedger` 内部
  吞掉所有异常、只降级为 warn——**任何情况都不冒泡到事件分发**（trace 对 loop 零影响，
  见 `docs/node-observability-m1.md`）。

`StreamEvent['payload']` 除了 SDK 原始事件，还混入了后端自己造的几类事件
（`agent_end`、`plan_updated`、`task_updated`、`tool_call_pending`、`question_pending` 等），
它们同样走 `publish()`，因此**有正确的递增 id、进缓存、可重放**——这是「断线重连不丢
审批弹窗 / 提问弹窗」的机制保证。

---

## 4. 第 2 层：SSE 路由——把事件写成 HTTP 流

`routes/agent.ts` 的 `GET /api/agent/:sessionId/events` 是前端连接的唯一入口。

### 4.1 连接建立

```ts
const lastEventId = Number(request.headers['last-event-id'] ?? 0);
await options.registry.open(request.params.sessionId);   // 活跃则复用，否则从磁盘恢复
reply.hijack();                                          // 接管响应
reply.raw.writeHead(200, {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'Access-Control-Allow-Origin': '*',   // hijack + writeHead 会绕过 @fastify/cors，需手动补
});
```

`reply.hijack()` 之后不再走 Fastify 的 `send()`，而是直接操作 `reply.raw`
（Node 原生 `http.ServerResponse`），连接可以一直保持、随时写帧。

### 4.2 写帧格式（`createSseWriter`）

每帧就是两行 + 一个空行：

```
id: 7
data: {"type":"message_update","message":{...},"assistantMessageEvent":{...}}

```

- `id:` 让 EventSource 语义的 `Last-Event-ID` 生效（本项目前端手写解析，自行维护这个值）；
- `data:` 是 `JSON.stringify(event.payload)`——注意写的是 **payload**，即 SDK 事件本体，
  前端 `JSON.parse(data)` 得到的对象就是 `AgentEvent`。

### 4.3 断线续传（重放合并）

`registry.subscribe(sessionId, lastEventId, listener)` 先补发 `id > lastEventId` 的历史事件，
再注册实时监听。补发时做了**合并**：

```ts
// agent-registry.ts · subscribe()
const replay = entry.events.filter((event) => event.id > afterEventId);
for (let index = 0; index < replay.length; index += 1) {
  const event = replay[index]!;
  if (isMessageUpdatePayload(event.payload) &&
      isMessageUpdatePayload(replay[index + 1]?.payload)) {
    continue;   // 连续 message_update 只发最后一条
  }
  listener(event);
}
```

即：**同一段连续流式输出只补发最后一条**（否则客户端一建连就重渲染几百次）。
事件 id 仍单调递增，`Last-Event-ID` 语义不受影响。

### 4.4 心跳、写缓冲上限、清理

- **心跳**：每 15 秒写一条注释帧 `: heartbeat\n\n`，防止代理/浏览器把「长时间无数据」判为超时。
- **写缓冲上限**：`createSseWriter` 在写之前检查 `reply.raw.writableLength`，
  超过 `MAX_SSE_PENDING_BYTES = 8MB` 就置 `dropped` 并主动断开，让慢客户端重连
  （重放已合并，重连代价低）。
- **清理**：客户端断开时 `request.raw` 触发 `close`，`closeStream()` 停心跳、取消订阅、`end()` 响应。

---

## 5. 第 3 层：前端——fetch + ReadableStream 手写解析

前端不用原生 `EventSource`，因为 `EventSource` 无法带 `Authorization` 头
（令牌只能塞进 URL，会进日志）。改为 `fetch + ReadableStream` 手写 SSE 解析，
自建断线重连。

### 5.1 建立连接（`api.ts`）

```ts
export function fetchAgentEvents(sessionId, lastEventId, signal) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (lastEventId > 0) headers['Last-Event-ID'] = String(lastEventId);
  return fetch(`${BASE_URL}/api/agent/${encodeURIComponent(sessionId)}/events`, { headers, signal });
}
```

### 5.2 读取循环（`useAgentSession.ts · readStream`）

```ts
const reader = response.body?.getReader();
const decoder = new TextDecoder('utf-8');
let buffer = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let boundary;
  while ((boundary = buffer.indexOf('\n\n')) !== -1) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    if (frame.startsWith(':')) continue;               // 心跳注释帧
    const parsed = parseSseFrame(frame);
    if (parsed.data) {
      if (parsed.id !== undefined) lastEventId = parsed.id;
      try {
        handleAgentEvent(JSON.parse(parsed.data) as AgentEvent, sessionId);
      } catch { /* 忽略畸形事件，保持流存活 */ }
    }
  }
}
```

要点：

- 按 `\n\n` 切帧（与后端写帧格式严格对应）；
- 每处理完一帧就更新 `lastEventId`——重连时作为 `Last-Event-ID` 续传，**不丢事件**；
- `parseSseFrame` 只取 `id:` 与 `data:` 两行（`data` 支持多行拼接），无这两行则忽略。

### 5.3 断线重连与假死检测

- **指数退避**：`0.5s → 1s → 2s → … → 10s` 封顶（`RECONNECT_BASE_DELAY_MS` / `RECONNECT_MAX_DELAY_MS`）；
- **假死检测**：每 10 秒检查一次 `Date.now() - lastActivityAt`，超过 45 秒（3 倍心跳间隔）
  无任何数据就强制重连；
- **竞态防护**：`generation` 计数器保证同一时间只有一个活跃流在喂 `handleAgentEvent`，
  重连/切换会话后旧循环发现序号不匹配立即退出。

---

## 6. 事件 → 状态：`reduceAgentEvent` 纯函数状态机

`handleAgentEvent` 把每条事件先喂给 `reduceAgentEvent`（`lib/agent-events.ts`），
得到新的 `AgentStreamState`，再整对象拷贝进响应式状态：

```ts
export function reduceAgentEvent(state, event): AgentStreamState {
  switch (event.type) {
    case 'agent_start':        return { ...INITIAL, running: true, phase: 'waiting' };
    case 'message_update':     // 助手 → phase 'responding'，streamingMessage = event.message
    case 'message_end':        // 助手 → phase 'waiting'，streamingMessage = null
    case 'tool_execution_start':  // phase 'tool'
    case 'tool_call_pending':  // pendingToolCall（审批弹窗）
    case 'question_pending':   // pendingQuestion（提问弹窗）
    case 'tool_execution_end': case 'tool_execution_blocked': // 回 'waiting'
    case 'agent_end':          // running:false，phase 'idle'，清空 pending
    default: return state;
  }
}
```

`AgentStreamState` 只有六个字段：

```ts
{ running, phase, streamingMessage, error, pendingToolCall, pendingQuestion }
```

- `running + phase` 驱动顶栏状态文案（空闲/等待模型/生成回复/执行工具）；
- `streamingMessage` 就是列表外那个 `<MessageView streaming>` 的数据源；
- `pendingToolCall` / `pendingQuestion` 分别驱动审批/提问弹窗。

> 注意：`task_updated` / `task_recovery_required` **刻意不在这里处理**——它们由
> `useAgentSession` 的独立 ref 维护，不能污染「Agent 在不在跑」的判断（见 M2 契约注释）。

### 6.1 流式增量按帧合并（`handleAgentEvent`）

```ts
function handleAgentEvent(event, sessionId) {
  if (event.type === 'message_update' && event.message?.role === 'assistant') {
    pendingStreamingMessage = event.message;   // 只留最新一条，覆盖旧的
    scheduleStreamingFlush();                  // 每帧最多刷一次
  } else {
    flushStreamingMessage();                   // 其它事件先落地挂起的增量
    assignStream(reduceAgentEvent(stream, event));
  }
  // … contextUsage / plan / task / retry / compaction 等分支
  if (event.type === 'message_end' && event.message) {
    // 按 entryId 去重：已存在原地替换，否则追加
  }
  if (event.type === 'agent_end') void loadSession(sessionId);
}
```

`scheduleStreamingFlush` 用 `requestAnimationFrame`（无 rAF 环境退化 50ms 定时）把
`pendingStreamingMessage` 刷成一次 `reduceAgentEvent`。效果：**无论一个帧间隔内来了多少条
`message_update`，每帧最多触发一次响应式更新**，Markdown 最多重渲染一次。
这正是 `docs/web-stream-coalescing.md` 记录的前端卡死修复。

### 6.2 `message_end` 与 `entryId` 去重

`message_end` 才把消息**定稿**进 `messages` 数组（成为虚拟列表的一行）：

- 有 `entryId` 且已存在 → **原地替换**（同一消息被重复推送时覆盖）；
- 否则 → **追加**到末尾，同时 `entryIds` 同步追加。

流式期间 `streamingMessage` 一直在变，但 `messages` 数组不动——所以虚拟列表的行数
只在「一条消息真正结束时」才 +1。

---

## 7. 第 4 层：虚拟列表（`ChatWindow.vue`）

### 7.1 只渲染 user/assistant

```ts
const visibleMessages = computed(() =>
  messages.value
    .map((m, i) => ({ message: m, entryId: entryIds.value[i] ?? String(i) }))
    .filter(({ message }) => message.role === 'user' || message.role === 'assistant'),
);
```

`toolResult` 不占行，只进 `toolResults` 这个 `toolCallId → message` 映射，
供 `ToolCallBlock` 查结果。

### 7.2 TanStack Virtual（不定高）

```ts
const virtualizer = useVirtualizer(computed(() => ({
  count: visibleMessages.value.length,
  getScrollElement: () => messageScroller.value,
  getItemKey: (i) => visibleMessages.value[i]?.entryId ?? `msg-${i}`,
  estimateSize: (i) => (visibleMessages.value[i]?.message.role === 'user' ? 64 : 260),
  overscan: 8,
})));
```

- **不定高**：`estimateSize` 只是未测量前的粗估；每行挂 `:ref="measureRow"`，
  由 `virtualizer.measureElement()` 按 DOM 真实高度回填——长代码块、宽表格都能正确占高。
- **绝对定位 + translateY**：外层 `virtual-list` 高度 = `getTotalSize()`，每行
  `translateY(row.start)` 铺开；`padding-bottom: 38px` 代替行间距，让测量到的盒高
  天然包含间距（避免相邻行贴在一起）。
- **`overscan: 8`**：可视区上下各多渲染 8 行，减少滚动时的白屏。

### 7.3 流式消息在列表外单独渲染

```html
<MessageView v-if="stream.streamingMessage"
  :message="stream.streamingMessage" :tool-results="toolResults" streaming />
```

这是「流式 + 虚拟列表」并存的关键取舍：

- 若把流式消息放进虚拟列表，每 token 都会触发 `count` 变化 → 虚拟化重新测量/重排，
  开销巨大；
- 单独渲染则流式过程完全不走虚拟化，`message_end` 后它才「转正」进 `messages`。

列表外的兜底态：`stream.running` 且无 `streamingMessage` 时显示 `agent-status`
（状态脉冲 + 文案），对应「等待模型 / 执行工具」阶段。

### 7.4 自动滚动

```ts
watch(() => [messages.value.length, stream.streamingMessage], async () => {
  await nextTick();
  if (!followBottom.value) return;
  messagesEnd.value?.scrollIntoView({
    behavior: stream.streamingMessage ? 'auto' : 'smooth',
  });
});
```

- `followBottom` 由 `onScroll` 维护：距底部 <120px 视为「跟随底部」；
- 用户上滑读历史时 `followBottom=false`，新内容**不会**把他拉回底部；
- 流式用 `auto`（避免逐 chunk 平滑滚动的卡顿），新消息用 `smooth`。

---

## 8. 第 5 层：Markdown 渲染（`MessageView` → `MarkdownContent`）

### 8.1 单条消息分派（`MessageView.vue`）

`MessageView` 把一条消息的内容块拆成三部分渲染：

```html
<ThinkingBlock   v-if="thinking" :content="thinking" :streaming="streaming" />
<MarkdownContent v-if="text"     :content="text" />
<ToolCallBlock   v-for="call in toolCalls" :key="call.id"
  :call="call" :result="call.id ? toolResults?.[call.id] : undefined" :streaming="streaming" />
```

- `thinking` = 所有 `thinking` 块拼接（流式时默认展开并显示 LIVE 标记）；
- `text` = `messageText()` 拼接全部 `text` 块（`lib/agent-events.ts`）；
- `toolCalls` = 所有 `toolCall` 块，按 `id` 查 `toolResults` 展示结果。

### 8.2 Markdown 渲染管线（`MarkdownContent.vue`）

```ts
const html = computed(() => {
  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }) => {
    const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
    const highlighted = hljs.highlight(text, { language }).value;
    return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
  };
  const rendered = marked.parse(props.content, { async: false, breaks: true, gfm: true, renderer });
  return DOMPurify.sanitize(String(rendered));
});
```

三步：**自定义代码块高亮 → marked 渲染 → DOMPurify 清洗**。

- `marked`：GFM 全开（表格/删除线/任务列表），`breaks: true` 让换行转为 `<br>`；
- `highlight.js`：`hljs.getLanguage(lang)` 命中才高亮，否则回退 `plaintext`；
- `DOMPurify.sanitize`：**v-html 之前的最后一道安全闸**，模型输出的任意 HTML
  只保留安全标签/属性；
- 样式全部用 `:deep()` 命中 `v-html` 生成的内部元素（表格边框、代码块配色、
  宽表横向滚动等，见 `web/src/components/MarkdownContent.vue` 的 style 块）。

### 8.3 渲染成本与「按帧合并」的联动

`html` 是 `computed`，`props.content`（即 `streamingMessage.text`）每变一次就**全量重跑**
marked + hljs + DOMPurify。若没有 §6.1 的按帧合并，每个 token 都会触发一次全量渲染，
单条消息越长开销越大（O(n²)），长回复会把主线程压满。合并后每帧最多重跑一次，
这是流式链路里「后端重放合并」「前端按帧合并」两处优化共同保护的终点。

---

## 9. 端到端时序（一次 prompt 的完整生命周期）

```
用户                    Vue 前端                         Node 后端                    Pi SDK 核心
 │ 点发送                  │                                │                            │
 ├── send(message) ───────►│                                │                            │
 │                         ├─ createAgent / sendAgentCommand────────────────────────────►│
 │                         │  （POST /api/agent[/new] 202）                              │
 │                         ├─ connectEvents ── fetch events ────────────────────────────►│
 │                         │                                │  subscribe(lastEventId)     │
 │                         │                                │◄── session.subscribe ──────│
 │                         │◄── SSE: id:1 data:message_start(user) ──────────────────────│
 │                         │  reduce → running, waiting                                  │
 │                         │◄── id:2 agent_start … id:3 turn_start … ────────────────────│
 │                         │◄── id:N message_update（每 token 一条全量快照）× 很多 ──────│
 │                         │  仅存 pendingStreamingMessage，rAF 每帧刷一次                │
 │                         │  ChatWindow 列表外 <MessageView streaming> 重渲染            │
 │                         │◄── id:M message_end(assistant) ─────────────────────────────│
 │                         │  flush + 追加进 messages → 虚拟列表 count+1 → measureElement │
 │                         │◄── tool_execution_start/end / tool_call_pending（若有）──────│
 │                         │  审批弹窗 ← approve_tool 命令 → 挂起 Promise 结算            │
 │                         │◄── agent_end / agent_settled ────────────────────────────────│
 │                         │  loadSession() 拉最终快照，onAgentEnd                       │
```

断线时：前端重连 → 带 `Last-Event-ID` 再连 `/events` → 后端从缓存补发
`id > lastEventId` 的事件（连续 `message_update` 只发最后一条）→ 前端无缝续上。

---

## 10. 关键设计决策与「坑」（速查）

| # | 决策 / 坑 | 位置 | 说明 |
| --- | --- | --- | --- |
| 1 | `message_update` 是全量快照 | SDK | 订阅者拿到的就是完整累计消息，代价是 O(n²) 体积增长 |
| 2 | 重放合并 | `agent-registry.ts` · `subscribe()` | 连续 `message_update` 只补发最后一条，防建连重渲染几百次 |
| 3 | 前端按帧合并 | `useAgentSession.ts` | rAF 每帧最多刷一次流式增量，防主线程压满（`docs/web-stream-coalescing.md`） |
| 4 | 事件双缓冲 + 编号 | `agent-registry.ts` · `publish()` | 缓存（≤256 条）供重放，`subscribers` 供在线；id 单调递增 |
| 5 | hijack + 手写 CORS | `routes/agent.ts` | `reply.hijack()` 绕过 @fastify/cors，必须手动补 `Access-Control-Allow-Origin` |
| 6 | 写缓冲上限 8MB | `routes/agent.ts` | 慢客户端积压超限主动断开，靠重放低成本重连 |
| 7 | EventSource 换 fetch | `web/src/lib/api.ts` | EventSource 不能带 Authorization 头；令牌走 header 不进 URL |
| 8 | `task_updated` 不进状态机 | `agent-events.ts` | 任务/恢复由独立 ref 维护，避免误判「Agent 在跑」 |
| 9 | 流式消息在虚拟列表外 | `ChatWindow.vue` | 避免每 token 触发虚拟化重排；`message_end` 才转正进列表 |
| 10 | `entryId` 去重 | `useAgentSession.ts` | 同一消息重复推送时原地替换而非重复追加 |
| 11 | DOMPurify 最后一道闸 | `MarkdownContent.vue` | v-html 前的清洗，模型输出只保留安全标签 |
| 12 | 整对象拷贝 `assignStream` | `agent-events.ts` | 曾漏拷 `pendingQuestion` 导致弹窗静默丢失（见 `docs/node-question-channel.md` §5.1） |

---

## 11. 相关文档

- [`docs/web-stream-coalescing.md`](web-stream-coalescing.md) —— 流式合并渲染的 O(n²) 根因与修复（§6.1、§8.3 的详细版）
- [`docs/node-session-tree-flat.md`](node-session-tree-flat.md) —— 会话树扁平化（初始加载 `context.messages` 的兄弟路径）
- [`docs/node-observability-m1.md`](node-observability-m1.md) —— `ledger.record()` 旁路采集口径（§3.2）
- [`docs/node-question-channel.md`](node-question-channel.md) —— `question_pending` 弹窗与 `assignStream` 字段完整性
- [`docs/node-command-approval.md`](node-command-approval.md) —— `tool_call_pending` 审批链路（§9 时序里的审批分支）
