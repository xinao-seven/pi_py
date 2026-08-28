# Node 后端 MCP 支持

更新日期：2026-08-26

## 目的

给 Node 版 Web Coding Agent（`node-pi/server`）增加 MCP（Model Context Protocol）支持：
用户可在 Web 界面配置 MCP server，把 MCP 暴露的工具注册进 Pi 会话，供模型调用。
MCP 工具与内置工具同走 Pi 的 `tool_call` 钩子，因此可复用既有的工具审批与 Plan 模式约束。

## 设计原则

MCP 工具只是"另一种工具"。它应该：

1. **以原生 Pi 工具的形式进入会话**：注册后出现在 `getActiveTools()`，可被 `set_tools` 开关；
2. **走统一的 `tool_call` 拦截链路**：审批扩展、Plan 模式对 MCP 工具同样生效；
3. **连接进程级共享**：同一工作区的多个会话共享同一个 MCP server 连接，不重复 spawn stdio 进程；
4. **配置即代码**：server 清单落在配置文件（用户级 + 工作区级），REST API 增删改后通过
   `registry.reloadResources()` 让所有活跃会话重新注册工具集。

## SDK 关键机制（设计依据）

调研 `@earendil-works/pi-coding-agent@0.83.0` 后的决定性事实：

- **扩展工具走统一 `tool_call` 钩子**（`dist/core/extensions/types.d.ts`）：内置/自定义/扩展工具调用前都触发
  `tool_call`，MCP 工具天然可被审批与 Plan 拦截。
- **`pi.registerTool()` 即时刷新会话工具注册表**（`loader.js`：`registerTool` → `runtime.refreshTools()`）：
  运行中的会话可动态增减工具，无需重建。
- **`session.reload()`（`reload_resources`）重建扩展对象并重新调用工厂**：配置变更后 reload 即可让
  "移除的 MCP 工具"从注册表消失。
- **`DefaultResourceLoader.extensionFactories` 支持内联扩展工厂，不走 jiti 隔离**：工厂闭包可直接引用
  服务端单例。这是唯一能让多个会话共享 MCP 连接、且工具 `execute()` 直达连接管理器的途径。

plan / 审批 / MCP 都采用**内联扩展工厂注入**（`extensionFactories`），闭包直连服务端单例；
MCP 的连接状态因此可以进程级共享。这是对 SDK 既有能力（`extensionFactories`）的合理使用。

## 总体架构

```
node-pi/server/
├─ src/services/mcp/
│  ├─ mcp-config.ts           # 配置读写/合并/校验（纯逻辑，无 MCP SDK 依赖）
│  ├─ mcp-client-manager.ts   # 连接池（Map<serverKey, Client>）+ 状态跟踪
│  ├─ mcp-service.ts          # 门面：组合 config + manager，对外提供 REST/扩展用方法
│  └─ mcp-extension.ts        # buildMcpExtension(service, cwd) → InlineExtension
├─ src/routes/mcp.ts          # REST 路由
└─ src/app.ts                 # 装配 McpService；agent-registry.ts 的 loader() 注入内联扩展
```

核心链路：MCP 工具经 `pi.registerTool()` 进入会话 → 模型调用时触发 `tool_call`（审批/Plan 可拦）
→ 执行时闭包直调 `McpService.callTool()` → 结果转成 Pi `AgentToolResult` 回给模型。

## 配置模型

两处配置合并（对齐 SDK 的 `~/.pi/agent/extensions/` 与 `{cwd}/.pi/extensions/` 发现约定）：

- 用户级：`~/.pi/agent/mcp.json`（全局默认）
- 工作区级：`{cwd}/.pi/mcp.json`（按 server name 覆盖用户级）

```jsonc
{
  "servers": {
    "filesystem": {
      "transport": "stdio",                 // stdio | streamable-http
      "command": "npx",                     // stdio 专用
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "E:/code"],
      "env": { "API_KEY": "$TOKEN" },       // stdio 专用；支持 $ENV 插值
      "enabled": true,
      "approval": "required"                // 可选：该 server 所有工具调用需人工审批
    },
    "github": {
      "transport": "streamable-http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer $GITHUB_TOKEN" },
      "enabled": true
    }
  }
}
```

`McpConfig` 负责读写/合并/校验；纯函数、不依赖 Fastify 与 MCP SDK，便于单元测试。

## REST API 契约（`routes/mcp.ts`）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/mcp/servers?cwd=&scope=` | 合并后的配置 + 连接状态（connected/connecting/error/disabled）+ 工具清单与数量 |
| `POST` | `/api/mcp/servers` | 新增/更新 server（body 含 name/scope/transport/...） |
| `PATCH` | `/api/mcp/servers/:name?scope=` | 局部更新（enabled、approval、headers 等） |
| `DELETE` | `/api/mcp/servers/:name?scope=` | 删除 server |
| `POST` | `/api/mcp/servers/:name/test?cwd=` | 试连 + 列工具后断开，返回状态与工具数 |
| `POST` | `/api/mcp/refresh?cwd=` | 强制重连同步 |

任何变更之后的统一动作（复用 skills 开关的现成模式）：

1. `McpService` 更新配置 → 增量更新连接池（新增连接 / 断开删除的 server）；
2. `registry.reloadResources()` → 各会话重建扩展 → MCP 工厂按最新配置重注册工具集。

## 工具注册与命名

- **命名**：`mcp__<server>__<tool>`（server/tool 名做 `[^\w] → _` 清洗；冲突追加短哈希）。
  前缀 `mcp__` 避开内置工具（read/bash/edit/write）。
- **promptSnippet**：每个 MCP 工具附带一行 snippet（描述首行 + `(MCP server: <server>)`），使其出现在
  系统提示词的 **Available tools** 区——自定义工具若不设 `promptSnippet` 不会枚举在提示词里
  （工具仍以 API tool definitions 传给模型、可被调用），加上它对模型发现工具与人工排查都有帮助。
- **参数 schema**：MCP `input_schema`（JSON Schema）转 TypeBox `TSchema`（`ToolDefinition.parameters`）。
  实现 `jsonSchemaToTypeBox()` 覆盖 object/string/number/integer/boolean/array/enum/oneOf/anyOf/nullable，
  未知结构回退 `Type.Unsafe({ ...raw })`（宽松校验，避免误拒调用）。
- **execute() 映射**：`client.callTool({ name, arguments })` → 结果 `{ content, isError }` 映射为 Pi
  `AgentToolResult`：text 块 → `{type:"text"}`、image 块（data/mimeType）→ `{type:"image"}`；
  `isError` 置为 Pi 的 error 结果。超长输出需截断（对齐 Pi truncate 策略，防撑爆上下文）。

## 生命周期

| 时机 | 行为 |
|---|---|
| 会话创建/打开 | `loader(cwd)` → 内联工厂跑 → `McpService.ensure(cwd)`（连接启用中的 server）→ `pi.registerTool()` |
| `reload_resources` / 配置变更 | 同上重跑 → 按新配置重注册（增删立即生效） |
| 服务关闭（onClose） | `McpService.dispose()` → 关闭全部连接、杀 stdio 子进程、退订事件总线 |
| 会话关闭 | 无需处理（连接归 McpService 共享，不随会话销毁） |

连接池键为 `{cwd}:{serverName}`，同一工作区多会话共享同一连接。

## 与既有功能协同

1. **工具审批**：内联扩展额外注册 `pi.on("tool_call", ...)` —— 工具名以 `mcp__` 开头且对应 server 配置
   `approval: "required"` 时，直接调用 `ToolApprovalBroker.requestApproval()` 挂起等待（内联扩展闭包
   直连单例，与 bash 审批共用同一中枢），**前端审批对话框零改动**。
2. **Plan 模式**：`PlanModeService.buildExtension()` 的 `tool_call` 拦截补一条 —— 规划期**默认拦截所有
   `mcp__` 工具**（无法证明只读，保守处理）。
3. **工具开关**：MCP 工具注册后出现在 `getActiveTools()`，前端的 `set_tools` 命令可开关，无需额外接口。
4. **SSE 展示**：MCP 调用走标准 `tool_execution_start/update/end`，注册表全量转发，前端 `ToolCallBlock` 渲染
   （需确认对任意 toolName 的通用性）。

## 前端 UI

- `McpConfig.vue` 弹窗（对标 `SkillsConfig.vue`），挂到 `App.vue`，入口在 `SessionSidebar.vue` 侧栏底部。
- 功能：server 列表（状态徽标、工具数、启用开关、"测试连接"按钮）、新增/编辑表单（stdio/streamable-http、
  审批开关）、删除确认。
- 配套：`web/src/lib/api.ts` 的 MCP 封装（getMcpServers/upsertMcpServer/updateMcpServer/deleteMcpServer/testMcpServer），
  `web/src/types/index.ts` 的类型。

## 安全考量

- **信任模型**：stdio MCP server 通过 `command/args` spawn（如 `npx`），等价于执行任意代码 —— 与 Pi 的
  bash 同等级信任，用审批流（`approval: "required"`）+ Plan 拦截兜底，UI 表单给出警告文案。
- **密钥存放**：headers/env 里的 token 存在 `~/.pi/agent/mcp.json`（与 auth.json 同级，已是受保护目录），
  支持 `$ENV` 变量引用避免把明文密钥写进配置。REST 会把 env/headers 返回给前端以支持编辑——这是
  本机工具，服务默认只监听 127.0.0.1。
- **输入校验**：`/api/mcp/*` 路由校验 `cwd` 必须是已存在目录（对齐 `POST /api/agent/new`），
  `parseServerConfig` 对传输类型必填字段（stdio 的 command、http 的 url）做 422 校验；
  配置读取会防御性跳过非对象条目（防手改文件崩溃）。
- **已知限制**：客户端只支持静态请求头鉴权（Bearer / API Key）。需要 **OAuth 交互授权** 的
  streamable-http server（如 GitHub Copilot MCP）当前无法连接（报 `Authorization header is badly
  formatted` / 401），OAuth 支持列为后续计划。
- **输出截断**：MCP 工具文本输出经 `truncateTail` 截断（2000 行 / 50KB，对齐 bash 约定），附
  `[Truncated: ...]` 标记，防超长结果撑爆上下文；工具描述里也注明该限制。
- **资源占用**：连接的 stdio 子进程随服务生命周期管理，配置变更/服务关闭时确保 `close()`（处理 EPIPE/超时）；
  连接握手带超时（默认 15 秒），失败标记为 `error` 不阻塞其余 server。

## 实施阶段

- **[完成] P1 核心链路（无 UI）**：加依赖 `@modelcontextprotocol/sdk`（+ `zod` peer）；`McpConfig` +
  `McpClientManager` + `McpService`；`routes/mcp.ts`；`buildMcpExtension()` 注册工具。本地 stdio MCP server
  验证工具出现且可调用（见 `test/services/mcp-service.test.ts`）。
- **[完成] P2 协同**：MCP 审批 `tool_call` 处理器（直连 `ToolApprovalBroker.requestApproval()`）；
  Plan 模式拦截 `mcp__` 工具（`PlanModeService.buildExtension()`）。前端 ToolCallBlock /
  tool_call_pending 规约已确认对任意 toolName 与 risk/category 通用，无需改动。
- **[完成] P3 前端**：`McpConfig.vue` 配置弹窗（状态徽标/工具数/启停/试连/增删改，对标 SkillsConfig）
  + `api.ts` 封装 + `App.vue`/`SessionSidebar.vue` 挂载（侧栏 MCP 按钮）。
  注意：REST 请求体把 server 配置嵌套在 `server` 键下，避免工作区 cwd 与 stdio 子进程 cwd 重名。
- **[完成] P4 打磨**：输出截断（`truncateTail` 2000 行 / 50KB + 标记）、安全加固（cwd 目录校验、
  配置读取防御、连接握手超时）、安全章节校订。

## 测试策略

- **单测**：`McpConfig` 合并/校验；`jsonSchemaToTypeBox` 转换；工具名清洗/冲突。
- **集成**：内置一个进程内 stdio MCP 测试 server → 建会话断言工具注册成功、调用返回正确；
  `approval: "required"` 的 server 触发审批流；Plan 模式拦截生效；`reload_resources` 后增删工具生效。
- **契约**：审批复用既有通道常量，沿用现有的"通道名一致性"断言。
