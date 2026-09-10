# Plan 扩展归属与 `session_start` 修复

更新日期：2026-08-20
关联规划：`docs/node-platform-plan.md`（M4 前置项）、`docs/node-platform-m0-spike.md`（M0-⑤/⑥）
状态：**已实施并验证**

---

## 1. 背景：Plan 模式在生产环境完全不可用

M0 的扩展加载审计发现 `DefaultResourceLoader` 会同时加载「内联扩展」与
`~/.pi/agent/extensions/` 里的**同名文件扩展**（官方 `plan-mode`），于是怀疑是双状态机冲突。
深入验证后，找到的根因比"冲突"更严重：

> **`session_start` 扩展事件在 Node 后端从未被触发。**

### 1.1 证据链

```
SDK dist 内 bindExtensions() 的唯一调用者：
  modes/interactive/interactive-mode.js:1218
  modes/print-mode.js:50
  modes/rpc/rpc-mode.js:229

而 bindExtensions() 是 session_start 的唯一发出点：
  core/agent-session.js:1761   await this._extensionRunner.emit(this._sessionStartEvent)
```

Node 后端走的是 `createAgentSession()`（`agent-registry.ts` 的 `OriginalPiSessionFactory`），
**不经过任何 CLI mode**，因此 `bindExtensions()` 从未被调用。

实测（`spike/06-plan-session-start.mjs` 修复前）：

```
=== 修复 A：session_start 派发 ===
  ❌ plan_enable 失败: plan_unavailable
```

### 1.2 影响面

`PlanModeService.buildExtension()` 把状态机的登记与 JSONL 恢复挂在 `session_start`：

```ts
pi.on('session_start', (_event, ctx) => machine.attach(ctx as SessionContext));
```

`attach()` 才会调用 `service.attach(machine, sessionId)`。既然该钩子从不触发：

| 后果 | 说明 |
| --- | --- |
| `PlanModeService.machines` 永远为空 | `command()` 抛 `409 plan_unavailable` |
| `plan_enable / plan_disable / plan_execute / plan_refine` **全部失效** | 前端开关点了就报错 |
| `GET /api/agent/:id/plan` 恒返回默认 `normal` 快照 | `PlanProgress.vue` 的 `v-if="plan.mode !== 'normal'"` 永不成立 |
| 计划状态无法从 JSONL 恢复 | P8（重启后计划不可感知）比规划里描述的更彻底 |

**这是 P1–P8 全部现象的共同上游根因**，而不只是 P2（正则解析）。

### 1.3 与 D1（双状态机）的关系

官方 `plan-mode` 扩展的两条激活路径是：

1. `pi.getFlag('plan')` —— CLI 的 `--plan` flag，Web 永不设置；
2. `session_start` 里从会话 JSONL 的 `customType: "plan-mode"` 条目恢复。

路径 2 同样依赖 `session_start`，所以**修复前官方扩展在 Web 侧也是休眠的**。

> ⚠️ **这意味着：单独修复 `session_start` 会把双状态机"激活"，引入 D1。**
> 两项修复必须同时上线 —— 这是本次改动的核心排序约束。

---

## 2. 决策：方案 B（内联实现接管 `plan-mode`）

| 选项 | 结论 |
| --- | --- |
| A. 改用官方 `plan-mode` 扩展 | ❌ 只支持 `Plan:` + `[DONE:n]`；`agent_end` 里有 `if (!ctx.hasUI) return`，Web 下永远不建 todos、不弹确认；且需要修改用户目录里的文件 |
| **B. 内联实现接管（采用）** | ✅ 可控、可重构（即 M4）；代价是必须显式阻止同名文件扩展加载 |
| C. 两者共存 | ❌ 状态机双写 + 钩子短路顺序不可预测 |

方案 B 的实施要点：**不能依赖"官方扩展默认关闭"**，而要显式过滤。

---

## 3. 实现

### 3.1 修复 A：登记会话时派发 `session_start`

`src/services/agent-registry.ts`

1. `PiSession` 门面补充可选能力（保持向后兼容，假会话可省略）：

```ts
bindExtensions?(bindings?: Record<string, unknown>): Promise<void>;
```

2. `register()` 由同步改为 `async`，在**订阅事件之后、返回之前**调用：

```ts
entry.unsubscribe = session.subscribe((event) => this.publish(entry, event));
this.entries.set(session.sessionId, entry);
try {
  await session.bindExtensions?.({});
} catch (error) {
  this.logger?.warn({ sessionId, error: messageOf(error) }, 'session_start dispatch failed');
}
return entry;
```

设计要点：

- **先 `entries.set` 再派发**：扩展在 `session_start` 里同步产生的状态（Plan 状态机登记、
  状态快照 SSE）已经能通过注册表找到本会话。
- **传空对象**：只触发事件，不绑定 UI / mode（Node 后端没有 TUI）。
- **异常吞掉只记 warn**：扩展是增量能力，不该让会话建不起来。
- `create()` 与 `openPersisted()` 都走 `register()`，因此新建与恢复都会派发。

### 3.2 修复 B：抑制被内联实现接管的文件扩展

`src/services/agent-registry.ts`

```ts
export const INLINE_OWNED_EXTENSION_DIRS = ['plan-mode'] as const;

export function dropInlineOwnedExtensions(result: LoadExtensionsResult) {
  const owned = new Set<string>(INLINE_OWNED_EXTENSION_DIRS);
  const dropped: string[] = [];
  const extensions = result.extensions.filter((extension) => {
    const name = extensionDirName(extension.path); // .../extensions/plan-mode/index.ts → plan-mode
    if (name === undefined || !owned.has(name)) return true;
    dropped.push(extension.path);
    return false;
  });
  return { result: { ...result, extensions }, dropped };
}
```

接入 `OriginalPiSessionFactory.loader()`：

```ts
extensionsOverride: (base) => {
  const { result, dropped } = dropInlineOwnedExtensions(base);
  if (dropped.length > 0)
    this.logger?.info({ cwd, dropped, ownedBy: [...INLINE_OWNED_EXTENSION_DIRS] },
      'file extensions suppressed (inline implementation owns these names)');
  return result;
},
```

设计要点：

- **按目录名匹配**，用户级（`~/.pi/agent/extensions/`）与工作区级（`{cwd}/.pi/extensions/`）
  都会被覆盖；`plan-mode-extra` 这类相似名不受影响。
- **只影响本服务的资源加载**，不修改、不删除磁盘文件 —— 满足"共享态增量写入允许、
  破坏性写入禁止"红线；**CLI 仍照常加载官方扩展**。
- 内联扩展的 `path` 形如 `<inline:N>`，取不到目录名，因此不会被误伤。
- `OriginalPiSessionFactory` 新增第 5 个可选构造参数 `logger`（`app.ts` 传 `app.log`）。

### 3.3 修复 C：`context` 钩子清理陈旧 plan 上下文（D2）

`src/services/plan-mode-service.ts`

`before_agent_start` 返回的 message 会以 `role: "custom"` 进入本轮消息，并在 `message_end`
时**持久化写入会话 JSONL**。因此：

- 反复切换模式会无上限累积；
- 规划期与执行期的指令会同时出现在上下文里，互相矛盾。

新增 `context` 钩子，按当前模式保留，并**同类型只留最后一条**：

| 当前模式 | 保留 | 丢弃 |
| --- | --- | --- |
| `planning` | `web-plan-context` 的**最后一条** | `web-plan-execution-context` / `web-plan-execute` |
| `executing` | `web-plan-execution-context` / `web-plan-execute` 各自的最后一条 | `web-plan-context` |
| `normal` | — | 全部 plan 注入 |

保留"最后一条"而非全部，是因为 `before_agent_start` **每一轮**都重新注入，
内容已包含当前待办全集；旧条目仅在 JSONL 里留审计痕迹。

---

## 4. 验证

### 4.1 端到端（真实 SDK + 真实 `AgentRegistry` + 真实 `PlanModeService`）

`spike/06-plan-session-start.mjs`（已纳入 `npm run spike` 与 CI）：

```
=== 修复 A：session_start 派发 ===
  ✅ plan_enable 成功（修复前会抛 409 plan_unavailable）
     planState 现在: {"mode":"planning","todos":[],"awaitingConfirmation":false}

=== 修复 B：陈旧 plan 上下文清理 ===
  JSONL 里写入过的 web-plan-context 条目（审计痕迹，应该保留）: 3
  测到的 context 钩子调用次数: 4
  规划期：模型实际收到的 plan 注入消息数: 1（应为 1）
  退出后：模型实际收到的 plan 注入消息数: 0（应为 0）
  ✅ 修复生效：JSONL 保留审计痕迹，但模型上下文已按模式清理干净
```

探针方法：把探测扩展注册在 plan 扩展**之后**，利用 SDK 钩子链按注册顺序串行传递的特性，
观察 plan 扩展过滤后的真实消息列表。

### 4.2 扩展过滤（真实 SDK 发现）

`spike/05-extension-conflict.mjs` 接入了**构建产物里的真实过滤函数**：

```
内联实现接管的扩展目录名: plan-mode

=== tool_call 钩子冲突面 ===
  钩了 tool_call 的扩展数: 2       ← 修复前为 3
    - <inline:1>   (项目 PlanModeService)
    - <inline:2>   (项目 ToolApprovalBroker)

=== Plan 类扩展（同时钩 agent_end + before_agent_start）===
    - <inline:1>                    ← 修复前为 2（含官方 plan-mode）

=== 全部注册的工具（名字冲突检查）===
    subagent  ← ~/.pi/agent/extensions/subagent/index.ts   ← 有意保留，M5 再决策
```

### 4.3 单元测试

| 文件 | 新增用例 | 覆盖 |
| --- | --- | --- |
| `test/services/agent-registry-extensions.test.ts`（新） | 7 | `create()`/`open()` 均派发 `session_start`；`bindExtensions` 抛错不阻断登记且只记 warn；过滤用户级+工作区级 `plan-mode`；Windows 路径；相似名不受影响；过滤时记 info 日志 |
| `test/services/plan-mode.test.ts` | +5 | 三种模式下 `context` 的保留/丢弃；同类型只留最后一条；无需清理时返回 `undefined`；反复切换后不累积 |

合计 Node 后端测试 **71 → 84**。

### 4.4 回归

`format:check` / `typecheck` / `test(84)` / `build` / `spike(8 个脚本)` 全绿。

---

## 5. 尚未处理（明确记录）

| 项 | 说明 | 归属 |
| --- | --- | --- |
| `subagent` 官方扩展仍在加载 | 注册工具 `subagent`，spawn 独立 `pi` 子进程；**无 Web 审批通道、不进 trace 树**。M5 需决定共存还是替换，并复用 `~/.pi/agent/agents/*.md` 的 `scout`/`planner`/`reviewer`/`worker` 预设 | M5 |
| P6：验证类命令仍被拦 | `isSafePlanCommand()` 不含 `tsc --noEmit` / `pnpm test` / `npm run build`。M0 已确认官方白名单同样不含，所以这是**唯一**剩余的成因 | M4 |
| P2：计划仍靠正则解析 | `extractPlan()` / `markDone()` / `[DONE:n]` 待 M4 换成结构化工具契约 | M4 |
| P1：必须预开开关 | 前端 `AgentControls.vue` 的 Plan 预开关待 M4 改为发送时的 `mode` | M4 |
| `web-plan-context` 会在 JSONL 里留多条 | 属于审计痕迹，模型侧已清理；若日后要压缩 JSONL，可考虑改为不持久化 | 可选 |

---

## 6. 变更文件

```
改  node-pi/server/src/services/agent-registry.ts
      · PiSession.bindExtensions 门面   · register() 派发 session_start
      · INLINE_OWNED_EXTENSION_DIRS / dropInlineOwnedExtensions
      · loader() 接入 extensionsOverride   · 新增可选 logger 参数
改  node-pi/server/src/services/plan-mode-service.ts
      · 新增 context 钩子（按模式清理 + 同类型只留最后一条）
改  node-pi/server/src/app.ts                  · 传入 app.log
新  node-pi/server/test/services/agent-registry-extensions.test.ts
改  node-pi/server/test/services/plan-mode.test.ts
新  node-pi/server/spike/06-plan-session-start.mjs（替换 06-plan-context-leak.mjs）
改  node-pi/server/spike/05-extension-conflict.mjs（接入真实过滤函数）
改  node-pi/server/package.json                · spike 脚本链
```
