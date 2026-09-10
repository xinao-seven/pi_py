# Web Plan 模式（M4 重构后）

更新日期：2026-08-21
状态：**已实现并冻结契约**（M4 完成）。实现细节与取舍见
[`node-plan-mode-m4.md`](node-plan-mode-m4.md)；本文只讲**对外契约与用法**。

> M4 之前本文描述的是「先开开关 → 模型写 `Plan:` 标题 → 正则解析 → 输出 `[DONE:n]`」。
> 那套设计已被**整体替换**：计划改由工具产出、状态存在任务库里，模型不需要写任何特殊标记。
> 重构原因（8 个具体缺陷）见 [`node-platform-plan.md`](node-platform-plan.md) §2 与
> [`node-plan-mode-m4.md`](node-plan-mode-m4.md) §1。

---

## 1. 心智模型

**Plan 是 Task 的受控视图。** 一次规划就是创建一个 `origin='plan'` 的任务：

```
用户「先规划」 ──► 计划任务(drafting) ──submit_plan──► proposed ──用户确认──► executing ──complete_step──► completed
                        │                                 │                     │
                        │                                 └──update_plan──┐      ├──plan_pause──► paused ──plan_resume──┐
                        └──plan_abandon──────────────────────────────────► abandoned                  ◄────────────────────┘
```

三条不变量：

1. **只有用户能推进关键状态**：从 `proposed` 到 `executing` 必须由用户确认（`plan_execute`）；
   模型在规划期**没有写工具**，无法绕过确认改工作区。
2. **步骤完成必须有证据**：`complete_step` 要带 summary / commands+退出码 / files，
   步骤声明了 `verification` 时服务端会校验，不符则返回工具错误让模型补齐。
3. **状态只有一份**：任务表是唯一真相源，`PlanView` 是现算的投影；模型/面板/执行器
   任何一方写入后，其它方通过 SSE `plan_updated` 看到同一份状态。

---

## 2. 用法

### 2.1 用户怎么用

- **发送时选择执行方式**：输入框左侧的 `[直接执行 | 先规划]`（记住上次选择），
  或在输入框里用 `/plan` 前缀临时切一次。**新会话也可以直接「先规划」**——
  不再需要「先发一条消息创建会话再打开开关」。
- **规划期**：Agent 只读调研（读代码、跑验证类命令），不会改文件；需要拍板时它会提问并停下。
- **方案定稿**：Agent 调用 `submit_plan` 提交计划 → 面板显示「待确认」，
  可「确认并执行」「继续细化（说明你的要求）」「放弃此计划」。
- **执行期**：面板实时显示每步状态与证据；可以暂停、继续、改名/跳过/删除还没做的步骤、
  放弃（记录保留，之后仍可查）。
- **中断后**：进程崩溃/重启 → 任务面板提示「上次运行被中断」，
  计划面板显示「已暂停」，可「继续执行」；写操作无法确认时服务端会拒绝自动续跑（见 M3 文档）。

### 2.2 前端契约

| 项 | 值 |
| --- | --- |
| 计划视图 | `GET /api/agent/:sessionId/plan` → `{ plan: PlanView }`（无计划时 `planId === ''`） |
| 会话状态里的计划 | `GET /api/agent/:sessionId` → `state.plan`（同一个 `PlanView`） |
| 实时更新 | SSE `{ type: 'plan_updated', plan: PlanView }` |
| 提问 | SSE `question_pending` / `question_resolved` + 命令 `answer_question`（见 [`node-question-channel.md`](node-question-channel.md)） |
| 命令 | `POST /api/agent/:sessionId` body `{ type: 'plan_*' , message? }`，响应 `{ success, data: { plan } }` |
| 步骤编辑 | 直接走任务接口：`PATCH /api/tasks/:id/steps/:stepId`、`DELETE ...`（带 `ifRevision`） |
| 发送方式 | `POST /api/agent/new` 与 `{ type:'prompt' }` 支持 `mode: 'direct' \| 'plan'`（非法值 → 422） |

`PlanView`：

```ts
interface PlanView {
  planId: string;            // 与 taskId 相同（1:1）
  taskId: string;
  sessionId: string;
  status: 'drafting' | 'proposed' | 'executing' | 'paused' | 'completed' | 'abandoned';
  revision: number;          // 用户可见内容的版本号（心跳/在飞不占用，见 §4）
  title: string;
  goal: string;
  steps: Array<{
    id: string;              // 's1'、's2'…（与任务步骤同 id）
    title: string;
    details?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped';
    verification?: { kind: 'command' | 'file' | 'manual'; command?: string; expectExitCode?: number; path?: string };
    evidence?: { summary?: string; commands?: Array<{ command: string; exitCode: number | null }>; filesTouched: string[]; toolCallIds: string[] };
    blockedReason?: string;
  }>;
  awaitingUserAction: boolean;  // 待确认 / 已暂停
  draftingSince?: string;
  updatedAt: string;
}
```

### 2.3 命令表

| 命令 | 语义 | 校验 |
| --- | --- | --- |
| `plan_start` | 用这次消息开始规划（必须有 `message`） | 无 message → 422；已有未结束计划 → 采纳并打回 drafting |
| `plan_execute` | 确认并开始执行（202 语义：发 prompt，不等模型） | 非 `proposed`/`paused` → 409 `plan_not_ready`；无步骤 → 409 |
| `plan_pause` | 暂停：状态转 `paused`、释放租约、**中止当前轮** | 无计划 → 409 `plan_unavailable` |
| `plan_resume` | 继续执行（幂等：已是 executing 时不写库） | 无计划 → 409 |
| `plan_refine` | 把修改意见交给模型（模型用 `update_plan` 落地） | 空 message → 422 |
| `plan_abandon` | 放弃：任务 `cancelled`（记录保留，可查） | 无计划 → 409 |
| `plan_enable` / `plan_disable` | **弃用别名**，等价 `plan_start` / `plan_abandon`，保留一个版本并写 warn 日志 | — |

---

## 3. 计划工具契约（模型侧）

由内联扩展注册，**只在计划会话里加入 activeTools**（普通会话里对模型不可见；
`ask_user` 例外——它属于通用交互通道，任何会话都可用）：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `submit_plan` | `{ title, steps: [{ title, details?, verification? }] }` | 创建/替换计划步骤 → `proposed`；校验空步骤、重复标题、>50 步、`verification` 声明不自洽 |
| `update_plan` | `{ revision, title?, steps? }` | 按 `revision` 修订；不匹配时错误信息里给出当前 revision；**不能删除或重命名已经开始/已完成的步骤**（可改还没做的步骤） |
| `complete_step` | `{ stepId, evidence: { summary?, commands?, files? } }` | 校验证据后把步骤置完成；证据不符 → 工具错误（模型补齐后重试） |
| `block_step` | `{ stepId, reason }` | 步骤 `blocked` + 原因 → 计划转 `paused`，等用户处理 |
| `ask_user` | `{ questions: [{ id?, question, options?, multiSelect?, allowFreeText?, details? }] }` | **独立的交互通道**：一次可问多题（可选单选/多选/自由输入），工具挂起 → 前端弹窗 → 回答作为工具结果回到模型。契约见 [`node-question-channel.md`](node-question-channel.md) |

证据校验强度（刻意不同，见 M4 文档）：

| verification | 判定 |
| --- | --- |
| `kind: 'file'` | 查产物是否存在（相对路径按会话 cwd 解析）——最强 |
| `kind: 'command'` | 证据里确有这条命令且退出码符合 `expectExitCode`（默认 0）。服务端**不自己重跑**命令（那等于绕开审批执行任意 shell），因此只验证「确实跑过并如实上报」 |
| `kind: 'manual'` | 需要非空结论（供人事后审计） |
| 未声明 | 仍需证据非空（summary / commands / files 之一） |

---

## 4. 规划期权限（能力集，而不是白名单）

规划期（`drafting` / `proposed`）只读，规则按**能力分类**判定（`services/plan-policy.ts`）：

1. 先跑审批规则：危险/敏感命令（递归删除、改依赖、联网、重定向写文件、远端 Git 操作…）
   一律不放行——同一套判定同时服务审批与 Plan，不会出现「审批说危险、Plan 说安全」。
2. 把命令按 `;` `&&` `||` `|` 拆段，**每段都要放行**（不给 `npm test && rm -rf src` 留口子）。
3. 每段按程序名归类为只读 / 验证 / 写 / **未知（=不放行）**。

策略可配（`PlanPolicy`）：`readOnlyTools`、`bash: 'none' | 'verify' | 'all'`、
`verifyCommands`（追加的验证类程序）、`allowMcp`（默认 false——无法证明 MCP 工具只读）。

放行示例：`tsc --noEmit`、`pnpm test`、`npm run build`、`npx vitest run`、`node -e 'console.log(1)'`、
`git status`、`rg -n x src`。拦截示例：`rm -rf`、`sed -i`、`> out.txt`、`git commit`、
`npm install`、`curl`、`npx 未知包`、`powershell -c ...`、MCP 工具。

**退出**：只撤销本会话 Plan 期造成的工具差集（`added` / `disabled` 两张表），
用户在此期间用 `set_tools` 做的改动不会被吞掉（P6）。计划自然完成时同样收回计划工具。

---

## 5. 与其它模块的关系

- **任务（M2）**：计划就是任务，所以任务面板能看到它，成本账本（M1）的 run 也关联到同一个 `task_id`。
- **断点续跑（M3）**：计划执行复用同一套租约与在飞动作；`POST /api/tasks/:id/resume` 的
  `mode: 'replan'` **只对 plan 任务开放**——会把计划打回 `drafting` 并让模型用
  `update_plan`/`submit_plan` 重交。
- **CLI 兼容**：会话 JSONL 只多了一条 `web-plan-ref` 指针（旧快照条目保留不删、也不再写新的）；
  原版 pi 与官方 plan-mode 扩展读到的会话不受影响。
