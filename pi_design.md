# Pi SDK 源码设计笔记

> 本项目对原版 `@earendil-works/pi-coding-agent` 做二次开发时，阅读 SDK 源码整理的内部设计。
> 目的：面试/后续开发直接参考，不必重新翻 node_modules。
>
> 包结构：`pi-coding-agent`（面向宿主） → `pi-agent-core`（agent-loop 运行时） → `pi-ai`（模型层 / 工具校验）。
> 所有路径相对仓库根目录；`node_modules` 下的路径可用 IDE 直接跳转。

---

## 1. 包结构概览

| 包 | 路径 | 职责 |
|----|------|------|
| pi-coding-agent | `node-pi/server/node_modules/@earendil-works/pi-coding-agent/dist/` | 面向宿主的 SDK：`createAgentSession`、SessionManager、ModelRuntime、ResourceLoader、扩展系统、内置工具 |
| pi-agent-core | `node-pi/server/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/` | Agent 主循环（agent-loop.js）：消息树、工具编排、压缩触发 |
| pi-ai | 同上 `.../node_modules/@earendil-works/pi-ai/dist/` | 模型原子类型 / provider；工具参数校验（`validateToolArguments`） |

---

## 2. 工具系统

### 2.1 ToolDefinition（工具的一等公民结构）

文件：`node-pi/server/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`（约 343-376 行）

```ts
interface ToolDefinition<TParams, TDetails, TState> {
  name: string;            // LLM 调用名
  label: string;           // UI 展示名
  description: string;     // 给 LLM 的用途说明
  promptSnippet?: string;  // 系统提示词"可用工具"区的一段摘要
  promptGuidelines?: string[]; // 追加到系统提示词 Guidelines 区
  parameters: TParams;     // TypeBox schema
  prepareArguments?: (args: unknown) => Static<TParams>; // 校验前兼容垫片
  executionMode?: "sequential" | "parallel";
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult>; // 核心
  renderCall? / renderResult?; // UI 渲染（TUI/Web 用）
}
```

内置工具在 `dist/core/tools/`：`bash` / `edit` / `write` / `read` / `grep` / `find` / `ls`，各以 `createXxxToolDefinition(cwd, options)` 工厂导出，参数 schema 用 TypeBox（`bashSchema` / `editSchema` 等）。

### 2.2 工具执行管线（agent-loop）

文件：`.../pi-agent-core/dist/agent-loop.js`

调用链（约 388-510 行）：

```
prepareToolCall(currentContext, assistantMessage, toolCall, config, signal)
 ├─ 1. 按 name 找工具；找不到 → 立即返回错误结果 `Tool ${name} not found`
 ├─ 2. prepareToolCallArguments：若有 prepareArguments 垫片先规整参数
 ├─ 3. validateToolArguments(tool, toolCall) → 校验/强转；抛错被 catch → 错误结果
 ├─ 4. config.beforeToolCall(...)   ← ★ 扩展拦截落点
 │      - 返回 { block: true, reason } → 立即错误结果（reason 进内容）
 │      - signal.aborted → 错误结果 "Operation aborted"
 └─ 返回 { kind: "prepared", tool, args: validatedArgs }

executePreparedToolCall(prepared, signal, emit)
 ├─ tool.execute(id, args, signal, onUpdate, ctx)
 │     onUpdate(partialResult) → 转发为 tool_execution_update 事件（流式部分结果）
 └─ 抛异常 → createErrorToolResult(error.message)，标记 isError（不崩 agent-loop）

finalizeExecutedToolCall(...)
 └─ config.afterToolCall(...) 可后处理 result（改 content/details/isError/terminate）
```

### 2.3 参数校验（pi-ai）

文件：`.../pi-ai/dist/utils/validation.js`（`validateToolArguments` 约 241-268 行）

```js
function validateToolArguments(tool, toolCall) {
  const args = structuredClone(toolCall.arguments);
  Value.Convert(tool.parameters, args);        // TypeBox 类型强转/纠偏
  const validator = getValidator(tool.parameters); // 按 schema 编译并缓存
  if (validator.Check(args)) return args;        // 通过返回（含强转后）参数
  // 失败：逐字段格式化错误
  const errors = validator.Errors(args).map(
    e => `  - ${formatValidationPath(e)}: ${e.message}`).join("\n");
  throw new Error(`Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:...`);
}
```

关键点：`Value.Convert` 做类型强转（数字/布尔纠偏），`validatorCache` 按 schema 缓存编译结果；错误信息带**每个非法字段的路径**（`formatValidationPath`）和收到的原始参数，便于模型自愈。

### 2.4 出错处理哲学：错误即数据

- `createErrorToolResult(message)`（agent-loop.js 约 515-520）把异常包成 `{ content: [{ type: "text", text: message }], details: {} }`。
- 错误结果作为**普通 toolResult 消息回喂模型** → 模型自行决定重试 / 改参 / 换工具。工具失败永不中断 agent 循环。
- 截断保护：`failToolCallsFromTruncatedMessage`（agent-loop.js 约 260-274）——assistant 消息撞上输出 token 上限时，流式生成的工具参数可能被截断成"解析过但不完整"，**全部标记为错误**并提示模型重新发出完整调用。

---

## 3. 扩展系统与事件钩子（拦截点的接线）

文件：`.../pi-coding-agent/dist/core/agent-session.js`（`_installAgentToolHooks` 约 205-238 行）、`dist/core/extensions/runner.js`

- SDK 把 agent 的 `beforeToolCall` / `afterToolCall` 钩子接到扩展运行器上：

```js
this.agent.beforeToolCall = async ({ toolCall, args }) => {
  const runner = this._extensionRunner;
  return runner.emitToolCall({ type: "tool_call", toolName, toolCallId, input: args });
};
this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
  return runner.emitToolResult({ ... });  // tool_result 事件
};
```

- `runner.emitToolCall` 逐个扩展回调 `tool_call` 处理器，**某个返回 `{ block: true }` 即短路**（runner.js 约 695-720）。
- **本项目三个拦截全部挂在这里**：工具审批（ToolApprovalBroker）、Plan 模式（PlanModeService）、MCP 审批（buildMcpExtension）——都注册 `pi.on('tool_call')`，命中规则返回 `{ block: true, reason }`。

---

## 4. 上下文压缩（中期记忆）

文件：`.../pi-coding-agent/dist/core/compaction/compaction.js`

- 默认设置（约 76-77）：`reserveTokens: 16384`、`keepRecentTokens: 20000`。
- 触发（约 160-163）：`shouldCompact(contextTokens, contextWindow, settings)` → `contextTokens > contextWindow - settings.reserveTokens`（留出回复余量）。
- 切点（约 308-323）：`findCutPoint(entries, start, end, keepRecentTokens)`——从后往前累积 token，`>= keepRecentTokens` 处切。
- 执行（约 583 `compact`，约 460 `generateSummaryWithUsage`）：早期轮次由**模型自身生成摘要**（预算 `min(0.8 * reserveTokens, model.maxTokens)`），可把上一轮摘要滚动传入做**滚动式摘要**；最近窗口原样保留。`generateTurnPrefixSummary` 用更小预算（0.5）处理 turn 前缀。
- 本项目的落点：
  - 手动压缩命令 `compact` → `session.compact(...)`：[agent-registry.ts:588-589](node-pi/server/src/services/agent-registry.ts#L588-L589)
  - `compaction_start` / `compaction_end` SSE 事件 → 前端转圈/报错：[useAgentSession.ts:327-332](web/src/composables/useAgentSession.ts#L327-L332)
  - 压缩策略随预设按会话覆盖（独立 SettingsManager 内存 `applyOverrides`，不写磁盘）：[agent-registry.ts:240-246](node-pi/server/src/services/agent-registry.ts#L240-L246)

---

## 5. 记忆与持久化

### 5.1 会话 JSONL（短期记忆）

- `SessionManager` 把每个会话写为 JSONL：`~/.pi/agent/sessions/<编码后cwd>/<sessionId>.jsonl`，含消息树、分支、压缩摘要，可 `open()` 完整恢复。
- 本项目暴露为 Web「恢复会话」：`open()` / `listPersistedSessions()` [agent-registry.ts:265-309](node-pi/server/src/services/agent-registry.ts#L265-L309)。

### 5.2 AGENTS.md / SYSTEM.md（长期、项目绑定记忆）

文件：`.../pi-coding-agent/dist/core/resource-loader.js`

- `loadContextFileFromDir`（约 27-50）：候选文件名 `AGENTS.md` / `AGENTS.MD` / `CLAUDE.md` / `CLAUDE.MD`，找第一个存在的。
- `loadProjectContextFiles`（约 81 起）：全局 `agentDir` 一份 + 从 cwd 逐级向上的项目各一份，去重（避免 worktree 影子重复加载）。
- SYSTEM.md（约 809-824）：项目 `.pi/SYSTEM.md` 与全局 `~/.pi/agent/SYSTEM.md`；另有 `APPEND_SYSTEM.md`。
- 本项目配合点：预设 `systemPrompt` **空串不传入 loader**（否则会跳过文件级提示词发现，破坏 AGENTS.md 记忆）：[agent-registry.ts:346-348](node-pi/server/src/services/agent-registry.ts#L346-L348)

---

## 6. 本项目挂接点速查（Pi 内部 ↔ 我的代码）

| Pi 内部机制 | 我的挂接 |
|-------------|---------|
| `beforeToolCall` / `tool_call` 事件 | 审批 [tool-approval.ts:234-251](node-pi/server/src/services/tool-approval.ts#L234-L251)、Plan [plan-mode-service.ts:334-343](node-pi/server/src/services/plan-mode-service.ts#L334-L343)、MCP 审批 [mcp-extension.ts:34-50](node-pi/server/src/services/mcp/mcp-extension.ts#L34-L50) |
| `registerTool` | MCP 工具批量注册 [mcp-extension.ts:29-33](node-pi/server/src/services/mcp/mcp-extension.ts#L29-L33) |
| `createAgentSession` | 组装/创建/打开 [agent-registry.ts:222-309](node-pi/server/src/services/agent-registry.ts#L222-L309) |
| `SettingsManager.applyOverrides` | 预设压缩覆盖 [agent-registry.ts:240-246](node-pi/server/src/services/agent-registry.ts#L240-L246) |
| 事件订阅 `subscribe(listener)` | AgentRegistry 事件缓存 + SSE 回放 [agent-registry.ts:527-538](node-pi/server/src/services/agent-registry.ts#L527-L538) |
| ResourceLoader 工具白名单 | `setActiveToolsByName` [agent-registry.ts:581-585](node-pi/server/src/services/agent-registry.ts#L581-L585) |
