# 长会话读取崩溃修复：分支树扁平化

> 起因：`GET /api/sessions/:sessionId` 读取超长会话时返回 500，
> 日志为 `RangeError: Maximum call stack size exceeded`（栈顶 `JSON.stringify`）。

## 1. 现象与定位

```
[22:21:10] ERROR: Maximum call stack size exceeded {"reqId":"req-a"}
    err: RangeError: Maximum call stack size exceeded
        at JSON.stringify (<anonymous>)
        at serialize (fastify/lib/reply.js:1069)
        at Reply.send (fastify/lib/reply.js:227)
    "serialization": { "url": "/api/sessions/:sessionId", "method": "GET" }
```

崩溃点不在业务逻辑里，而在 Fastify 的**响应序列化**（它内部就是 `JSON.stringify`）。
被序列化的对象是会话详情里的 `tree`，而 Pi 的会话树是「一条消息一个节点」的链表：

- 会话 `2026-09-10T05-03-28-860Z_01a089b3…jsonl`（6.5 MB）有 **2395 条目、最大嵌套深度 2391**；
- `JSON.stringify` 是**递归**实现，实测该节点形状在 **约 2300 层**触顶：

  | 嵌套深度 | `JSON.stringify` |
  | -------- | ---------------- |
  | 2000     | ok               |
  | 2200     | ok               |
  | **2400** | **RangeError**   |
  | 5000     | RangeError       |

- 同一个响应里 `tree` 还**重复**了整份会话内容：该会话 `tree` 6.5 MB，
  而 `context.messages` 只有 1.4 MB。

所以问题不是「消息太多」，而是**用递归结构承载线性增长的深度**。

## 2. 修法：树改成「扁平节点 + depth」

`GET /api/sessions/:id` 的 `tree` 从嵌套数组改为**扁平数组**（先序，父节点一定排在子节点之前）：

```jsonc
{
  "tree": [
    {
      "id": "a99892b8",
      "parentId": "a266a9d9", // 保留父子关系，前端不需要也能用
      "depth": 5,             // 服务端算好层级，前端不再递归推导
      "type": "message",      // message / compaction / label / model_change ...
      "role": "toolResult",   // 仅 message 条目有
      "text": "# 项目进度…",  // 正文摘要：折叠空白后截断到 120 字符
      "label": null,          // label 条目解析结果
      "labelTimestamp": null
    }
  ]
}
```

设计要点：

| 决定                                     | 理由                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- |
| 只带 `depth`，不回 `children`            | 序列化深度从 O(条目数) 降为常数级；分支信息（父子、兄弟顺序）不丢     |
| 服务端算 `depth`                         | 前端不必再遍历/递归（同样的爆栈风险，只是搬到了浏览器）              |
| `text` 只存摘要（≤120 字符），不存正文   | 树只用于分支下拉的一行标签；正文在 `context.messages` 里已有          |
| 保持先序 + 兄弟时间升序                  | 与 `SessionManager.getTree()` 的渲染顺序完全一致，UI 无感             |
| 用显式栈遍历（`services/session-tree.ts`）| 服务端自己也不能递归——否则 2395 层的树在拍平时就爆栈                  |

实测同一会话：`tree` 由 6.53 MB → **0.53 MB**，完整详情响应 1.9 MB，序列化正常。

## 3. 前端：API 层归一化（兼容冻结的 Python 后端）

Python 后端（`pi-python/`，只读对照实现，**不修改**）的 `session_detail()` 仍返回嵌套树。
因此前端在 **API 层**把两种形状统一成扁平节点，组件只面对一种形状：

- `web/src/lib/session-tree.ts` — `toSessionTreeNodes()`：已是扁平就原样返回，
  是嵌套就用**显式栈**拍平（不递归）。
- `web/src/lib/api.ts` — `getSession()` 调用归一化，`SessionDetail.tree` 始终是扁平节点。
- 组件随之简化：`BranchNavigator.vue` 不再递归拍平、不再从 `entry.message` 里抠文本；
  `ChatWindow.vue` 的节点数直接取数组长度。

类型：`SessionTreeNode`（扁平，Node 契约）/ `LegacySessionTreeNode`（嵌套，Python 契约）/
`SessionTreeInput`（两者联合，仅出现在 API 边界）。

## 4. 测试

| 位置                                              | 覆盖                                                         |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `node-pi/server/test/services/session-tree.test.ts` | 5000 层链拍平后 `JSON.stringify` 不抛；先序/深度/label；摘要截断；坏节点跳过但子树保留 |
| `node-pi/server/test/routes/sessions-routes.test.ts` | **端到端回归**：3000 条目的会话 `GET /api/sessions/:id` 返回 200 + 扁平树（改动前该用例 500，已验证） |
| `web/test/lib/session-tree.test.ts`               | 扁平原样返回；嵌套（Python）拍平；5000 层不爆栈；空输入       |
| `web/test/components/BranchNavigator.test.ts`     | 扁平节点的标签/Fork 可用性（改用新契约的 fixture）            |

## 5. 已知限制

- **Python 后端仍有同类问题**：它返回嵌套树，而 Python 的递归深度默认 1000，
  约千条消息的会话在 `json.dumps` 时会 `RecursionError`。`pi-python` 已冻结
  （无明确需求不得改动），故只在前端做归一化兜底；生产走 Node 后端。
- `context.messages` **仍然是全量正文**（长会话 1.4 MB 起）：前端要渲染完整会话，
  这属于另一件事（若将来要优化，方向是分页/按需拉取，而不是压缩这股数据）。
- 树只是**导航目录**：若将来需要在树节点上展示完整消息内容，应新增独立接口按需取，
  不要把它塞回 `tree`（会重新引入这次的崩溃）。
