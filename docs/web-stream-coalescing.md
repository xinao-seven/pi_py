# 前端缺陷修复：长流式回复把页面压死（消费跟不上生产）

> 类型：前端渲染节流 + 后端 SSE 重放/背压修复（无 REST 契约变更）。
> 涉及 `web/src/composables/useAgentSession.ts`、`web/src/components/ChatWindow.vue`、
> `node-pi/server/src/services/agent-registry.ts`、`node-pi/server/src/routes/agent.ts`
> 与三条回归测试。

## 1. 现象

- 让模型跑长任务时，前端「跑到一半突然卡住」：页面点不动、停不住，但后端日志还在继续
  （agent 确实还在跑）。
- **重新打开页面 / 换开发服务器打开也一样没响应**，任务仍在后台推进。
- 现场表现更像「页面一直在刷新但没反应」，而不是白屏或报错。

## 2. 根因

**① 生产端是「每 token 一条、且每条带全量快照」**。SDK 的 agent loop 对每个流式增量
（`text_delta` / `thinking_delta` / `toolcall_delta`）都发一条 `message_update`，消息体是
**整条累计消息的浅拷贝**：

```js
// @earendil-works/pi-agent-core/dist/agent-loop.js:222
await emit({ type: 'message_update', assistantMessageEvent: event, message: { ...partialMessage } });
```

**② 消费端逐条全量重渲染**。前端每收到一条 `message_update` 就替换 `streamingMessage`，
`MarkdownContent` 随即对**整条消息**重跑 `marked.parse` + `highlight.js` + `DOMPurify.sanitize`。
于是单条回复越长、每次渲染越贵，整体是 O(n²)；再叠加 `ChatWindow` 那个 `{ deep: true }` 的
滚动 watcher（每个 token 深度遍历整条消息 + `scrollIntoView`）。

当模型产速高于前端渲染速度时，事件在主线程积压，页面就再也追不上——这就是「卡死」，
而后端完全正常。

**③ 刷新会立刻重演一遍**。前端加载会话时把 `lastEventId` 重置为 0
（`useAgentSession` 的 `sessionId` watcher），服务端会把内存里缓存的**最后 256 条**事件全部重放
（`MAX_REPLAY_EVENTS`）。而长回复下这 256 条几乎全是同一个消息的 `message_update`：

| 实测（一次真实卡死会话） | 值 |
|--------------------------|-----|
| 重放帧数 | 256 |
| 重放总大小 | 3.06 MB |
| 其中 `message_update` | **253 帧 / 1.84 MB**（单帧最大 9.1 KB） |

所以「重新打开」等于让同一条消息立刻再重渲染 200 多次，依旧卡死。

**④ 附带的服务端隐患**：SSE 写入是裸的 `reply.raw.write()`，不看返回值也不管背压。
客户端卡住不读时，事件会在服务端写缓冲里持续堆积（现场见过常驻 1.2 GB 的 `node dist/server.js`）。

## 3. 修法

**① 前端按帧合并流式增量（核心）** — `useAgentSession.ts`

- 新增 `pendingStreamingMessage` + `streamingFlushScheduled/Timer`：
  - assistant 的 `message_update` 只**保留最新一条**，用 `requestAnimationFrame` 合并成每帧一次渲染
    （无 rAF 的环境退化为 50 ms 定时）；
  - **其它事件先 `flushStreamingMessage()` 再走原 reducer**，保证 `message_end` /
    `tool_execution_start` 的顺序不会被挂起的增量盖过；
  - `closeEvents()` 取消挂起增量；读流自然结束时补一次 flush。

**② 去掉多余的深监听** — `ChatWindow.vue`
滚动 watcher 的源已经是 `[messages.length, stream.streamingMessage]`，每条事件都会换成新对象，
`deep: true` 纯属在每个 token 上白烧 CPU，直接删掉。

**③ 服务端重放只补每段增量的最后一条** — `AgentRegistry.subscribe`
重放时丢掉「后面紧跟仍是 `message_update`」的那些帧（每段连续增量只发最后一条）。
事件 id 仍单调递增，`Last-Event-ID` 语义不变；**实时订阅路径一条不少**。

**④ SSE 写缓冲上限** — `routes/agent.ts`
抽出可单测的 `createSseWriter(sink)`：写入前检查 `raw.writableLength`，超过
`MAX_SSE_PENDING_BYTES`（8 MB）就置 `dropped` 并停写；路由随即 `warn` 并断开连接
（停心跳 → 取消订阅 → `end`），让客户端重连——重放已经合并过，重连代价很低。

## 4. 验证证据

| 证据 | 结果 |
|------|------|
| `node-pi/server` typecheck / test / build | exit 0（387 用例） |
| `web` typecheck / lint / test / build | exit 0（140 用例；lint 0 error） |
| 新增回归用例 | 前端 2 条（合并渲染 / 顺序）、后端 2 条（重放合并）、SSE 写出器 3 条 |

## 5. 回归防线

| 用例 | 守住的因果条件 |
|------|----------------|
| `web/test/composables/useAgentSession.test.ts` → 合并渲染 | 同一 tick 推 3 条 `message_update` 只调度 **1 次**帧，且帧回调前状态不变、帧后是最后一条（逐条写状态就红灯） |
| `web/test/composables/useAgentSession.test.ts` → 顺序 | 帧还没跑就来 `message_end` 时，必须先落地挂起增量、再由 `message_end` 清空，不能反过来 |
| `node-pi/server/test/services/agent-registry-replay.test.ts` | 5 条 `message_update` 重放后只剩最后 1 条 + 全部非增量事件；实时订阅仍收到全部 |
| `node-pi/server/test/routes/agent-sse.test.ts` | 限额内写 `id/data` 帧；超限不写且 `dropped=true`；恰好等于上限仍写 |

## 6. 已知限制与后续

- 流式期间仍**每帧最多渲染一次**；模型产速极高（或单帧内容极大）时仍可能落后，只是从
  「无上限积压」变成「有上限的追赶」。
- 服务端只在**重放**时合并 `message_update`，实时流仍逐条下发（保真优先，节流交给客户端）。
  若后续带宽成为瓶颈，可在 `publish()` 层做带时间窗的合并。
- 真机压测建议：跑一次超长回复 + 大代码块，用 DevTools Performance 看主线程是否有长任务
  积压；同时 `curl -N /api/agent/:id/events -H 'Last-Event-ID: 0'` 统计重放帧数应从数百降到个位数。
