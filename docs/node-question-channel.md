# 向用户提问的交互通道（ask_user）

更新日期：2026-08-21
实现：`node-pi/server/src/services/user-question.ts` · 前端 `web/src/components/QuestionDialog.vue`

> M4 之前的 `ask_user` 只是「在计划面板上显示一句问题」：答案要靠用户在聊天框里自由文本回复，
> 模型得猜哪句是回答，也不支持一次问多个问题。现在它是与**危险命令审批**并列的
> 第二条人机交互通道：**工具挂起 → 前端弹窗 → 回答作为工具返回值回到模型**。

---

## 1. 为什么是「挂起」而不是「结束本轮」

两种做法的差别不在实现复杂度，而在**语义是否确定**：

| 做法 | 模型拿到的 | 问题 |
| --- | --- | --- |
| 结束本轮、等用户再发消息（旧实现） | 用户下一条消息的文本 | 模型不知道这条消息是回答还是新需求；多问题时会串题；用户不回答就永远等 |
| **工具挂起**（现在） | 结构化的 `answers`（每题 id → 选中项/文本） | 无。答案与问题一一对应，且允许「用户没答」这一确定结果 |

挂起与审批复用同一套机制（SSE 事件 + 命令 + Promise 结算），因此也自然继承了
「超时/中止/会话关闭都有确定结算」的性质——不会留下永远挂着的工具调用。

两个内置使用方：

1. `ask_user`（通用提问，任何会话常驻）；
2. `propose_plan`（Plan 模式，M4.2）：模型提议「要不要先进规划」，用户选「先规划」后服务端才
   `startPlanning`——把「模型自己判断要不要规划」与「只有用户能确认执行」接在了一起。
   它复用本通道（同一个挂起队列、同一个弹窗），没有新增任何 SSE / REST 契约，
   见 [`node-plan-cache-stability.md`](node-plan-cache-stability.md)。

---

## 2. 工具契约（模型侧）

```jsonc
ask_user({
  "questions": [
    {
      "id": "deploy",                 // 可选；缺省按 q1、q2… 生成（重名会自动加后缀）
      "question": "这次要一并部署到生产吗？",
      "options": ["部署", "先不部署"],  // 可选；不传 = 只允许自由输入
      "multiSelect": false,           // 可选；true = 多选
      "allowFreeText": true,          // 可选；默认 true（即使给了选项也允许「其他」）
      "details": "会触发一次线上变更窗口"  // 可选；显示在题干下方
    }
  ]
})
```

上限（超出会返回可照做的工具错误，模型据此改小）：

| 项 | 上限 |
| --- | --- |
| 一次提问的题数 | 8 |
| 每题选项数 | 12 |
| 题干 / 选项 / 说明长度 | 500 / 120 / 500 字 |

返回给模型的内容：

```
[用户回答]
1. 这次要一并部署到生产吗？
   → 选中：先不部署；补充：下周再上
2. 需要支持哪些平台？
   → （用户跳过，未回答）
```

未回答时（超时 / 用户点「让 AI 自己决定」/ 会话被停止）：

```
[用户未回答] 用户选择暂不回答，让你自己决定。
请按最合理的假设继续推进，并在回复里**明确写出你采用的假设**；
如果确实无法在假设下继续（例如缺少必须由用户提供的信息），请停下并说明需要什么，不要反复追问。
```

工具 `details`（给前端/审计，不占模型上下文）：
`{ questionId, answered, reason, answers }`，`reason ∈ user | cancelled | timeout | abort | session | disposed`。

---

## 3. 通道契约（前端侧）

| 项 | 值 |
| --- | --- |
| 实时事件 | SSE `{ type: 'question_pending', question: PendingQuestion }` |
| 结算事件 | SSE `{ type: 'question_resolved', questionId }` |
| 状态快照 | `GET /api/agent/:sessionId` → `state.pendingQuestion`（**刷新页面后靠它恢复弹窗**） |
| 回答命令 | `POST /api/agent/:sessionId` `{ type: 'answer_question', questionId, answers }` |
| 让 AI 自己决定 | `{ type: 'answer_question', questionId, cancelled: true }` |
| 错误 | 无挂起提问 → `404 question_not_found`；`answers` 形状非法 → `422 validation_error` |

```ts
interface PendingQuestion {
  sessionId: string;
  questionId: string;      // 回答时原样带回
  toolCallId: string;
  questions: QuestionSpec[];
  createdAt: string;
}
interface QuestionSpec {
  id: string; question: string;
  options?: string[]; multiSelect?: boolean; allowFreeText?: boolean; details?: string;
}
```

`answers` 是**稀疏**的：前端只提交用户真正填了的题，服务端把没提到的题补成
`{ skipped: true }`。每题里 `selected`（选中项）与 `text`（自由输入）都为空的，也按跳过处理。

---

## 4. 行为细节（刻意的取舍）

| 场景 | 行为 | 理由 |
| --- | --- | --- |
| 同一会话已有挂起提问 | 再调用 `ask_user` 直接返回错误 | 前端只有一个弹窗，叠两个会让人不知从哪儿答起；错误信息直接告诉模型「等用户答完再问」 |
| 用户不回答（默认 10 分钟） | 按「未回答」结算，提示模型按最合理假设继续并写明假设 | 既不能永久挂住会话，也不该把「用户离开」当成错误 |
| 用户点「让 AI 自己决定」 | `cancelled: true`，与超时同样处理 | 这是一个正常的协作选择，不是取消操作 |
| 会话被停止 / 服务关闭 | 按 `abort` / `disposed` 结算 | 挂起的 Promise 必须有确定归宿 |
| 提问通道与 Plan 的关系 | **无关**：不属于计划工具，普通会话也始终可用；计划结束后依然可用 | 澄清需求、方案取舍在任何对话里都可能需要 |
| `pendingQuestion` 存放位置 | 只在挂起队列里（会话状态快照 + SSE），**不再镜像到 `PlanView`** | M4 曾把问题写进 `execution.plan.question`，两处状态容易不一致（`PlanView.question*` 已移除） |

---

## 5. 前端交互

- **弹窗**（`QuestionDialog.vue`）：一屏显示全部问题，顶部「N/M 已答」；
  每题按声明渲染选项（单选/多选）与自由输入框；底部「让 AI 自己决定」+「提交回答」。
- 未答完也能提交（按跳过处理），但会提示「还有 N 题没答」——不强迫用户填完，也不静默丢问题。
- 选项用 `button` + `role="radio|checkbox"` + `aria-checked`，而不是原生 `label > input`：
  原生控件在「label 包裹 input」时会同时触发 label 激活与 change，容易变成「点一下切换两次」。
- 状态归约上，`question_pending` 与 `tool_call_pending` 同类（都表示「Agent 正在等外部输入」）：
  进入 `phase: 'tool'`；`question_resolved` 与 `agent_end` 都会清掉弹窗。
- **规约结果必须整对象写回响应式状态**（`applyStreamState()`）：`useAgentSession` 里
  任何「逐字段手写拷贝」都会把新字段悄悄丢掉，见下面的修复记录。

### 5.1 修复记录：弹窗不显示（2026-09-10）

**现象**：模型调用 `ask_user` 后后端确实挂起等待（会话状态快照里 `pendingQuestion` 有值），
但前端**既不弹窗也没有选项**，模型一直等下去，只能手动「停止」；刷新页面后弹窗反而出现了。

**根因**：`web/src/composables/useAgentSession.ts` 的 `assignStream()` 是**逐字段手写拷贝**，
只抄了 `running / phase / streamingMessage / error / pendingToolCall` 五个字段，漏掉 `pendingQuestion`。
于是所有 SSE 事件算出的提问状态都在写回时被静默丢弃：

| 链路 | 结果 |
| --- | --- |
| SSE `question_pending` → 归约 → `assignStream` | 弹窗状态被丢掉，**永远不显示** |
| SSE `question_resolved` / `agent_end` → 归约 → `assignStream` | 弹窗状态清不掉（同一个漏字段缺陷的另一半） |
| 刷新页面 → `loadSession` 直接给 `stream.pendingQuestion` 赋值 | 绕过 `assignStream`，所以能看到弹窗（掩盖了缺陷） |

后端与契约完全正常，所以 `eval` 的 `ask-user-roundtrip`（真实管线里跑边答）与后端单测都测不出来——
缺陷只存在于「SSE 事件写回前端状态」这一步。

**修法**：新增纯函数 `applyStreamState(target, next)`（`web/src/lib/agent-events.ts`）做**整对象拷贝**，
`assignStream()` 改为调用它。以后给 `AgentStreamState` 加字段不用记得改赋值代码，
新增字段也自动被带走。

**回归防线**（两条，均在修复前会失败）：

1. `web/test/lib/agent-events.test.ts`：遍历 `INITIAL_STREAM_STATE` 的**每个键**用哨兵值断言
   `applyStreamState` 都拷了过去——将来再漏字段会直接红，而不是靠肉眼发现「某个弹窗不出现」；
2. `web/test/composables/useAgentSession.test.ts`：mock `@/lib/api`，用可控 `ReadableStream` 推
   `question_pending` / `question_resolved` / `agent_end` 帧，断言 `stream.pendingQuestion` 出现与消失——
   即 ChatWindow `v-if="pendingQuestion"` 真正读的那个字段。

**发版注意（真机上「测试全绿却仍不弹窗」的第二层原因）**：上面修的是源码，而浏览器加载的是
`node-pi/server` 静态托管的 `web/dist` 构建产物（修复落地时线上仍是修复前的 `index-BTqmcR1x.js`）。
所以改完必须 `npm run build` 重建产物并硬刷新（Ctrl+F5），否则页面照旧没有弹窗。
判定产物是否含修复：压缩后的 `assignStream` 应调用整对象拷贝，即
`function Jc(e,t){return Object.assign(e,t)}` + `function F(e){Jc(u,e)}`（`u` = 响应式 stream）。

**验证记录（2026-09-10）**：

| 项 | 结果 |
| --- | --- |
| 红/绿（缺陷可被捕捉） | 把 `assignStream` 临时还原成逐字段手写 → `useAgentSession.test.ts` 2 条全红（`pendingQuestion` 始终为 `null`）→ 恢复修复 → 与 `agent-events.test.ts` 合计 14 条全绿 |
| 前端质量门 | `npm run typecheck` 0；`npm run lint` 0 error（62 条既有 warning）；`npx vitest run` 133 passed（28 files） |
| 产物与托管 | `npm run build` 产出 `index-BqgIUeb3.js`，`GET http://127.0.0.1:8001/` 已引用新 bundle，且产物中确认存在上述整对象拷贝链路 |
| 真机弹窗（端到端验收） | ✅ 用户硬刷新后实测：弹窗出现、选项可点、多选可勾多个、自由输入可用；提交后模型**立即**拿到结构化答案（不再等到超时或被手动停止） |

---

## 6. 测试与验证

| 层 | 覆盖 |
| --- | --- |
| `test/services/user-question.test.ts`（18） | 参数规整（补 id/去重/上限/`allowFreeText` 语义）、挂起与结算（回答、部分回答补跳过、取消、超时、abort、会话关闭、服务关闭）、二次提问拒绝、`answers` 校验、渲染文本、扩展注册与激活、工具结果形状与校验错误 |
| `test/routes/tasks-routes.test.ts`（+2） | `question_pending` 后状态快照可见、`answer_question` 结算它；未知 questionId → 404、`answers` 非数组 → 422 |
| `web/test/components/QuestionDialog.test.ts`（10） | 选项渲染与选中、多题（单选+多选+文本）、自由输入、未答按跳过、取消、新提问清空草稿、busy 禁用 |
| `web/test/lib/agent-events.test.ts`（+5） | `question_pending` 进入等待外部输入状态、`question_resolved`/`agent_end` 清理、非法载荷归一化；`applyStreamState` 字段完整性（每个键都要拷）+ 提问状态写回/清除 |
| `web/test/composables/useAgentSession.test.ts`（2） | **端到端止损点**：mock API + 可控 SSE 流，验证 `question_pending` 真的写进 `stream.pendingQuestion`（弹窗）、`question_resolved`/`agent_end` 真的清掉它（见 §5.1） |
| `eval` 用例 `ask-user-roundtrip` | **真实管线**里边跑边答：工具挂起 run（`whileExecuting` 钩子像前端一样轮询并回答）→ 答案回流进模型的下一次 `complete_step` 证据里 → 计划完成 |

---

## 7. 已知限制

| 项 | 说明 |
| --- | --- |
| 答案不支持图片/文件 | 只支持选项与文本；需要附件时让用户直接发消息 |
| 同时只有一个挂起提问 | 需要并行问多件事时把它们放进同一次调用的 `questions` 数组 |
| 没有「稍后回答」入口 | 弹窗必须二选一（回答或让 AI 自己决定）；用户也可以直接停止本轮（会按 abort 结算） |
| 选项文本不回写为枚举校验 | 服务端只校验 `answers[].id` 合法；`selected` 里出现未声明的选项不会被拒绝（自由输入场景需要） |
| 不参与 trace 统计 | 提问与回答会作为普通会话事件进入 M1 账本，但没有单独的「提问耗时/回答率」指标 |
