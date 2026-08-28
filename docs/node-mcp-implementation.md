# MCP 实现详解（代码走读）

更新日期：2026-08-26

本文从代码层面逐文件讲解 `node-pi/server` 是如何实现 MCP 的：SDK 集成点、数据流、关键机制、
生命周期与测试。适合要改 MCP 功能或排查问题的人。面向使用的配置见
[`docs/node-mcp-guide.md`](node-mcp-guide.md)，设计决策见 [`docs/node-mcp-support.md`](node-mcp-support.md)。

---

## 1. 总览：一条 MCP 工具调用的完整路径

```
配置(JSON) → McpConfig → McpService.ensure() → McpClientManager 连接池(stdio/HTTP 子进程/请求)
                                    │  listTools()
                                    ▼
  会话(AgentSession) ← pi.registerTool() ← buildMcpExtension() 内联扩展
                                    │  工具进入 _toolRegistry / _toolDefinitions
                                    ▼
  模型请求（tools 数组 + 系统提示词 Available tools）
                                    │  模型决定调用 mcp__<server>__<tool>
                                    ▼
  tool_call 钩子（Plan 拦截 → 审批 → 放行）
                                    ▼
  execute() → McpService.callTool() → McpClientManager.callTool() → MCP client.callTool()
                                    ▼
  CallToolResult → mcpResultToPi()（截断/失败抛错）→ AgentToolResult → 回灌模型
```

核心思路：**MCP 工具被实现成"另一种 Pi 工具"**，通过 SDK 扩展机制注册进会话，因此自动获得
Pi 的一切工具能力（开关、审批、Plan 约束、SSE 展示、上下文回填），而不需要改 Pi SDK 本身。

---

## 2. SDK 集成点（三个决定成败的机制）

### 2.1 为什么仓库内全部用"内联扩展"

Pi SDK 的扩展有两种加载方式：

| 方式 | 加载 | 能否共享服务端单例 |
|---|---|---|
| 文件扩展（`extensions/*.ts`，经 jiti） | jiti 隔离加载，模块实例独立 | 不能 |
| 内联扩展（`DefaultResourceLoader.extensionFactories`） | 直接调用工厂函数 | **能（闭包引用）** |

MCP 连接必须**进程级共享**：同一工作区的多个会话复用同一连接、不重复 spawn stdio 子进程。
内联扩展闭包可"直连连接池"（高频、同步地拿结果），所以 MCP 选择内联扩展。工具审批与 Plan
模式同样需要直连服务端单例（`ToolApprovalBroker` / `PlanModeService`），因此仓库内三个能力
统一采用内联扩展，不再使用 jiti 文件扩展：

```ts
// src/services/agent-registry.ts  loader(cwd, systemPrompt, extensions)
const factories: InlineExtension[] = [];
if (extensions?.planMode !== false && this.plans) factories.push(this.plans.buildExtension());
if (extensions?.approval !== false && this.approvals)
  factories.push(this.approvals.buildExtension());
if (this.mcpService) factories.push(buildMcpExtension(this.mcpService, cwd, this.approvals));
new DefaultResourceLoader({ cwd, agentDir: this.agentDir, extensionFactories: factories });
```

`buildMcpExtension(service, cwd, approvals)` 返回一个工厂函数，闭包捕获 `McpService` 单例、
会话 cwd 与审批中枢。工厂被每个会话的资源加载器调用（会话创建/打开、`reload_resources`、MCP
配置变更后的 reload）。

### 2.2 `pi.registerTool()` 与工具注册表刷新

SDK 的 `ExtensionAPI.registerTool()`（`loader.js`）会：
1. 把工具写进该扩展的 `tools` Map；
2. 调用 `runtime.refreshTools()`——**加载期是 no-op stub，绑定后才是 `_refreshToolRegistry`**。

`_refreshToolRegistry`（`agent-session.js`）从 `extensionRunner.getAllRegisteredTools()` 收集全部
扩展工具，重建 `_toolRegistry`（可执行的 AgentTool）和 `_toolDefinitions`（含 `promptSnippet` /
`promptGuidelines`），再 `setActiveToolsByName` 写回 `agent.state.tools`。

所以内联工厂在 `await service.ensure(cwd)`（连接+发现工具）之后调用 `pi.registerTool()`，
工具就进入了会话的工具注册表，出现在 `getActiveToolNames()`。

**`promptSnippet` 很关键**：系统提示词 `_rebuildSystemPrompt` 的 "Available tools" 区**只枚举带
`promptSnippet` 的工具**（`system-prompt.js` 第 40-43 行）。MCP 工具若不设 snippet，模型仍能在
API 的 `tools` 数组里拿到工具并调用，但系统提示词文字里看不到——这就是"模型只报四个标准工具"
的根因。`buildMcpToolDefinition` 现在为每个工具生成一行 snippet，让工具出现在提示词里。

### 2.3 `tool_call` 钩子与扩展执行顺序

所有工具（内置/自定义/MCP）调用前都会触发 `tool_call` 事件。`emitToolCall`（`runner.js`）按
**扩展数组顺序**逐个跑处理器，遇到返回 `{ block: true }` 就**短路返回**。

全部内联扩展按 loader 里 `extensionFactories` 的注册顺序执行：
`plan → approval → mcp`。因此 **plan 的拦截优先于 MCP 的审批钩子**：规划期 plan 先 block
MCP 工具，审批对话框不会弹出；危险 bash 在规划期也先被 plan 拦下，不会先弹审批框。

---

## 3. 文件逐个拆解

### 3.1 `src/services/mcp/mcp-config.ts` —— 配置读写/合并/校验

纯逻辑、不依赖 Fastify 与 MCP SDK，便于单测。

- **类型**：
  - `McpTransport = "stdio" | "streamable-http"`
  - `McpScope = "user" | "workspace"`
  - `McpServerConfig { transport; command?; args?; env?; cwd?; url?; headers?; enabled?; approval? }`
  - `ResolvedServer extends McpServerConfig { name; scope }`（合并后带来源作用域）
- **路径**：
  - 用户级 `{agentDir}/mcp.json`（通常 `~/.pi/agent/mcp.json`）
  - 工作区级 `{cwd}/.pi/mcp.json`
- **`effective(cwd)`**：读两层文件，按 server 名合并（工作区覆盖用户级），跳过非对象条目
  （`isServerConfig`，防手改文件崩溃），返回 `ResolvedServer[]`。
- **`upsert/remove(cwd, scope, name, ...)`**：读-改-写指定作用域的文件，不丢同文件其他条目。
- **`parseServerConfig(input)`**：HTTP 入参校验——transport 必填；stdio 需 `command`；http 需合法
  `url`；`args/env/headers` 类型检查；非法抛 `ApiError(422)`。

### 3.2 `src/services/mcp/mcp-tools.ts` —— 命名/转换/结果映射（纯函数）

- **命名**：
  - `serializeMcpToolName(server, tool)` → `mcp__<server>__<tool>`（`sanitizeName` 把非 `\w` 转 `_`）；
  - `parseMcpToolName(full)` 尽力解析（清洗是 lossy 的，权威映射靠 `McpService.toolIndex`）。
- **`jsonSchemaToTypeBox(schema)`**：MCP `input_schema`（JSON Schema）→ Pi 的 TypeBox `TSchema`。
  覆盖 object/string（含 enum）/number/integer/boolean/array/null；`required` 数组决定属性是否
  `Type.Optional`；未知结构（oneOf/anyOf 等）回退 `Type.Unsafe({...raw})` 宽松放行，避免误拒调用。
- **`mcpResultToPi(result)`**：MCP 内容块 → Pi `AgentToolResult`：
  - text 块 → `{ type: "text" }`，image 块 → `{ type: "image" }`，resource 块 → JSON 字符串；
  - **`isError` 按 bash 惯例抛 Error**（agent-core 会把抛出的异常标记为错误结果）；
  - 文本输出经 `truncateTail` 截断（`MAX_OUTPUT_LINES=2000` / `MAX_OUTPUT_BYTES=50KB`），截断附
    `[Truncated: ...]` 标记，防止超长结果撑爆上下文。
- **`buildMcpToolDefinition`**：构造 Pi 工具定义——
  - `name` = 序列化后的全名；
  - `description` = MCP 描述 + 截断说明；
  - `promptSnippet` = 描述首行（≤80 字符）+ `(MCP server: <server>)`；
  - `parameters` = 转换后的 TypeBox schema；
  - `execute` 委托给调用方传入的 `callTool(args, signal)` 闭包。

### 3.3 `src/services/mcp/mcp-client-manager.ts` —— 连接池

进程级单例，键为 **`{cwd}:{serverName}`**，同一工作区多会话共享连接。

- **`sync(cwd, desired)`**：把某 cwd 的连接对账到期望配置——
  - 被删除 / 禁用 / **配置指纹变了**（`fingerprintOf = JSON.stringify(config)`）→ 断开；
  - 尚未连接且启用 → `connect` 并发现工具。
  因为按指纹跳过未变化的连接，反复 reload 不会重连。
- **`connect`**：置 `connecting` 状态 → `openAndList` → 成功置 `connected` + 工具清单；失败置
  `error` + 错误信息（**不抛出**，一个 server 挂了不影响其他）。
- **`openAndList(config, defaultCwd?)`**：建 `Client({ name: "pi-web-mcp", version: "1.0.0" },
  { capabilities: {} })`，`client.connect(transport)` 带 **15 秒握手超时**（`withTimeout`），再
  `client.listTools()`。
- **`buildTransport(config, defaultCwd?)`**：
  - stdio → `StdioClientTransport({ command, args, env: {...process.env, ...interpolateEnvMap(env)},
    cwd: config.cwd ?? defaultCwd ?? process.cwd() })`——合并环境变量保证 npx 可用；**子进程工作目录
    默认落在会话工作区**；
  - http → `StreamableHTTPClientTransport(url, { requestInit: { headers } })`。
  - `env/headers` 的值支持 `$ENV` 插值（`interpolateEnv`）。
- **`probe(config)`**：试连——`openAndList` 后立即关闭，返回 `{ ok, error?, tools }`，不进连接池。
- **`callTool(cwd, name, toolName, args, signal)`**：未连接抛 `ApiError(503, "mcp_not_connected")`；
  否则 `client.callTool({ name, arguments }, undefined, { signal })`，把 AbortSignal 透传给 MCP 请求。
- **`dispose()`**：关闭全部连接（服务关闭时调用），`client.close()` + `transport.close()` 会终止
  stdio 子进程。

### 3.4 `src/services/mcp/mcp-service.ts` —— 门面（唯一真相源）

把"配置"与"连接池"组合起来，对 REST 层和扩展提供统一入口。

- **`ensure(cwd)`**：`config.effective(cwd)` → `manager.sync(cwd, ...)`（幂等）。
- **`toolsFor(cwd)`**：遍历 `manager.status(cwd)` 中 `connected` 的 server 的工具，序列化名字、
  冲突加后缀去重，构建 **`toolIndex`（全名 → 真实 {server, tool} 的权威映射）**，返回 `ToolDefinition[]`。
- **`resolveTool(cwd, fullName)`**：先查 `toolIndex`，查不到回退 `parseMcpToolName`。
- **`callTool(cwd, fullName, args, signal)`**：`resolveTool` → `manager.callTool` → `mcpResultToPi`。
- **`approvalRequired(cwd, fullName)`**：解析出 server 后查 `manager.approvalRequired`。
- **`listServers(cwd)`**：`ensure` + 合并配置 + 连接状态 → `McpServerView[]`（REST 返回体）。
- **`upsertServer/deleteServer`**：改配置后 `ensure`；**`testServer`** 走 `probe`；**`refresh`** 先
  `sync(cwd, [])` 全断再 `ensure` 重连；**`dispose`** 释放全部连接并清 toolIndex。

### 3.5 `src/services/mcp/mcp-extension.ts` —— 内联扩展（工具注册 + 审批钩子）

`buildMcpExtension(service, cwd, approvals)` 返回一个 `InlineExtension` 工厂：

1. **注册工具**：`await service.ensure(cwd)` → 遍历 `service.toolsFor(cwd)` → `pi.registerTool(tool)`。
2. **审批钩子**：`pi.on("tool_call", ...)` —— 当工具名以 `mcp__` 开头且该 server 配置了
   `approval: "required"`，直接调用 `broker.requestApproval()` 挂起等待：

```
扩展 → broker.requestApproval(pending) → SSE 推给前端弹框
前端 approve_tool → broker.decide → 结算 Promise → 放行/拦截
AbortSignal / 120s 超时 → 按拒绝结算
```

审批载荷 `PendingToolApproval`：`{ sessionId, toolCallId, toolName, args, reason,
rule: "mcp-approval-required", risk: "high", category: "system" }`——与既有 bash 审批同一结构，
**前端审批对话框零改动**。`ctx.hasUI` 守卫：Web 后端（无 UI 上下文）才走审批，TUI/RPC 直接放行。

### 3.6 `src/routes/mcp.ts` —— REST 路由

| 方法 | 路径 | 请求 | 动作 |
|---|---|---|---|
| GET | `/api/mcp/servers?cwd=` | - | `listServers` |
| POST | `/api/mcp/servers` | `{ name, cwd, scope?, server }` | `upsertServer` + `reloadResources` |
| PATCH | `/api/mcp/servers/:name` | `{ cwd, scope?, server }` | 同上 |
| DELETE | `/api/mcp/servers/:name?cwd=&scope=` | - | `deleteServer` + `reloadResources` |
| POST | `/api/mcp/servers/:name/test` | `{ cwd, scope?, server? }` | `testServer` |
| POST | `/api/mcp/refresh` | `{ cwd }` | `refresh` + `reloadResources` |

要点：
- **server 配置嵌套在 `server` 键下**——工作区 `cwd` 与 stdio 子进程 `cwd` 字段重名，嵌套彻底分离；
- **任何变更后都调 `registry.reloadResources()`**（复用 skills 开关模式）让所有活跃会话重载；
- `requiredCwd` 校验 `cwd` 必须是已存在目录（对齐 `POST /api/agent/new` 的 `invalid_workspace`）。

### 3.7 接线：`app.ts` + `src/services/agent-registry.ts`

- `app.ts`：创建 `McpService(new McpConfig(agentDir))` → 注入 `OriginalPiSessionFactory(agentDir,
  eventBus, mcpService)` → 注册 `mcpRoutes`（`prefix: "/api/mcp"`，带 service + registry）→
  `onClose` 时 `await mcpService.dispose()`。
- `agent-registry.ts`：`OriginalPiSessionFactory.loader(cwd)` 在构造 `DefaultResourceLoader` 时把
  `buildMcpExtension(mcpService, cwd)` 加入 `extensionFactories`——这是每个会话能拿到 MCP 工具的关键。

---

## 4. 关键机制深入

### 4.1 生命周期

| 时机 | 发生什么 |
|---|---|
| 会话创建/打开 | `loader(cwd)` → 内联工厂跑：`ensure(cwd)` 连接 → `toolsFor` 注册工具 |
| `reload_resources` / MCP 配置变更 | `session.reload()` → `resourceLoader.reload()` 重建扩展对象并重跑工厂 → 按最新配置重注册（**新增工具出现、删除的工具消失**——因为每次重建都是全新的扩展对象） |
| REST 增删改 server | 路由改配置 + `registry.reloadResources()` → 同上 |
| 服务关闭 | `McpService.dispose()` → 关闭全部 client/transport、终止 stdio 子进程 |

### 4.2 审批与 Plan 的协同（无冲突）

- **规划期**：plan-mode（文件扩展，先加载）的 `tool_call` 处理器命中 `mcp__` → `block: true`，
  `emitToolCall` 短路 → MCP 审批钩子不执行、不弹框。
- **非规划期 + `approval: "required"`**：plan-mode 放行 → MCP 审批钩子走事件总线等待前端决定。
- **非规划期 + 无 approval**：两个处理器都放行，工具直接执行。

### 4.3 错误与边界处理

- 单个 server 连接失败 → 标记 `error`，不阻塞其余 server、不抛到会话创建；
- 握手超时 15s；审批等待 120s 自动拒绝；AbortSignal 中止 → 按拒绝结算；
- 输出截断 2000 行 / 50KB；工具名冲突自动加后缀；命名清洗防非法字符。

---

## 5. 测试与验证

| 文件 | 覆盖点 |
|---|---|
| `test/services/mcp-tools.test.ts` | 结果映射、截断+标记、isError 抛错 |
| `test/services/mcp-service.test.ts` | 连接/注册/调用、状态上报、删除断连、审批联动（approval required / 放行） |
| `test/routes/mcp-routes.test.ts` | REST 嵌套形状全流程、非法配置 422 |
| `test/services/plan-mode.test.ts` | 规划期拦截 `mcp__`、disable 后放行 |

运行：`cd node-pi/server && npm run typecheck && npm test`。

实测链路（真实 DeepSeek 会话 + 本地 stdio server）已确认：工具进入 `getActiveToolNames()`、
模型能在系统提示词看到并**实际调用** `mcp__...` 工具、先建会话后配 MCP 经 reload 也能生效。

---

## 6. 限制与后续

- **鉴权只支持静态请求头**（Bearer / API Key）。需要 OAuth 交互授权的 server（如 GitHub Copilot
  MCP）无法连接；OAuth 支持列为后续。
- MCP **Resources / Prompts** 能力尚未接入（只接了 Tools）；工具命名/清洗是 lossy 的，权威映射
  依赖 `toolIndex`，reload 时会重建。
- 连接握手是同步阻塞会话创建的（每个 server ≤15s）；将来可改为异步注册、连接完成再补注册。

---

## 7. 相关文档

| 文档 | 内容 |
|---|---|
| [`docs/node-mcp-guide.md`](node-mcp-guide.md) | 面向使用：原理、配置、示例、排错 |
| [`docs/node-mcp-support.md`](node-mcp-support.md) | 设计决策、事件通道、安全边界 |
| [`docs/node-mcp-implementation.md`](node-mcp-implementation.md) | 本文：代码走读 |
