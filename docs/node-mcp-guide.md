# MCP 支持总结

更新日期：2026-08-26

本仓库的 Web 端 Coding Agent（`node-pi/server`，基于原版 `@earendil-works/pi-coding-agent@0.83.0`）
已支持 [MCP（Model Context Protocol）](https://modelcontextprotocol.io/)。本文是面向使用的总结：
MCP 基本原理 → 本项目如何实现 → 如何配置 → 配置示例 → 验证与排错。
实现细节见 [`docs/node-mcp-support.md`](node-mcp-support.md)。

---

## 一、MCP 是什么（基本原理）

**MCP 是一个开放协议**，它统一了"AI 应用 ↔ 外部工具 / 数据源"之间的对接方式，让任何支持 MCP 的
客户端都能接入任何 MCP server，而不用为每个工具写定制集成。

### 角色与消息流

```
┌────────────┐   transport   ┌──────────────────┐
│  MCP Client │ ─────────────▶ │   MCP Server     │
│  (本项目的  │  (stdio /      │ (文件系统/数据库/ │
│   McpService)│   http/SSE)    │   GitHub/浏览器… )│
└────────────┘                └──────────────────┘
```

- **Client**：想调用外部能力的 AI 应用。本项目是 Web Coding Agent 后端。
- **Server**：暴露能力的一方。生态里已有大量现成 server（filesystem、github、database、playwright…）。
- **Transport**：通信方式。
  - `stdio`：以子进程方式启动本地 server，通过 stdin/stdout 传 JSON-RPC；
  - `streamable-http`：通过 HTTP 访问远程 server（新标准，推荐远程）；
  - `sse`：旧版 HTTP 传输，仅兼容。

### 三种能力

| 能力 | 说明 | 本项目支持 |
|---|---|---|
| **Tools** | 可被模型调用的工具（参数用 JSON Schema 描述） | ✅ 已支持（核心） |
| Resources | 可读取的资源/文件 | 未启用（后续可加） |
| Prompts | 可复用的提示模板 | 未启用（后续可加） |

### 一次调用的流程

1. **握手**：Client 发 `initialize`，协商协议版本与能力；
2. **列工具**：Client 请求 `tools/list`，得到工具清单（名字 + 描述 + 参数 schema）；
3. **调工具**：模型决定调用某工具 → Client 发 `tools/call` → Server 执行并返回结果；
4. **结果回灌**：Client 把结果转成模型能看懂的文本/图片内容块，回填到对话上下文。

数据都走 **JSON-RPC**，与具体模型、具体语言无关，因此一个 MCP server 可以被所有生态客户端复用。

---

## 二、本项目如何实现

### 总体架构

MCP 被实现成**"另一种 Pi 工具"**：MCP 工具经 SDK 的扩展机制注册进 Pi 会话，与内置工具（read/bash/
edit/write）平级，因此天然获得工具审批、Plan 模式约束、`set_tools` 开关和 SSE 展示。

```
node-pi/server/
├─ src/services/mcp/
│  ├─ mcp-config.ts           # 配置读写/合并/校验（用户级 + 工作区级）
│  ├─ mcp-client-manager.ts   # 连接池（进程级共享，键 {cwd}:{server}）
│  ├─ mcp-service.ts          # 门面：工具注册/调用/解析，REST 辅助
│  ├─ mcp-tools.ts            # 命名、JSON Schema→TypeBox、结果映射、输出截断
│  └─ mcp-extension.ts        # 内联扩展：注册工具 + 审批钩子
├─ src/routes/mcp.ts          # /api/mcp/* REST 路由
└─ src/app.ts                 # 装配 McpService + 路由；loader 注入内联扩展
```

### 关键设计点

- **内联扩展（不走 jiti 隔离）**：MCP 连接必须**进程级共享**（同一工作区多会话复用同一连接、不重复
  spawn stdio 子进程）。所以用 SDK 的 `DefaultResourceLoader.extensionFactories` 注入，工厂闭包直接
  引用 `McpService` 单例——与 plan/审批这类"文件扩展 + 事件总线"的模式刻意不同。
- **工具命名**：`mcp__<server>__<tool>`（server/tool 名清洗为 `[a-zA-Z0-9_]`）。前缀 `mcp__` 避开内置工具。
- **参数 schema**：MCP 的 JSON Schema `input_schema` 转成 Pi 的 TypeBox `parameters`；未知结构宽松放行，
  避免误拒调用。
- **结果映射**：`callTool` 的文本/图片/资源内容块 → Pi 的 `AgentToolResult`；失败（`isError`）按 bash 惯例
  **抛 Error** 由 agent-core 标记为错误；文本输出用 `truncateTail` 截断（**2000 行 / 50KB**）防撑爆上下文。
- **审批协同**：server 配 `approval: "required"` 后，其工具调用复用 `pi:tool_approval:pending/decide/aborted`
  通道，前端审批对话框零改动。
- **Plan 协同**：规划期一律拦截 `mcp__` 工具（无法证明只读，保守处理）；因文件扩展先于内联扩展加载、
  且 `tool_call` 遇 block 短路，不会弹出多余审批框。
- **生命周期**：会话创建/`reload_resources`/MCP 配置变更 → 内联扩展重跑 `ensure(cwd)` + 注册当前工具集
  （增删立即生效）；服务关闭 → `McpService.dispose()` 关闭全部连接与子进程。

### 主要依赖

| 包 | 用途 |
|---|---|
| `@modelcontextprotocol/sdk@1.30.0` | MCP Client（stdio / streamable-http 传输） |
| `typebox` | 把 MCP JSON Schema 转成 Pi 工具的参数 schema |
| `zod` | MCP SDK 的 peer 依赖 |

---

## 三、如何配置

### 配置文件（两层合并）

| 作用域 | 路径 | 说明 |
|---|---|---|
| 用户级 | `~/.pi/agent/mcp.json` | 全局默认 |
| 工作区级 | `{cwd}/.pi/mcp.json` | 按 **server 名** 覆盖用户级，项目私有 |

合并规则：同一名字两个文件都定义时，**工作区级优先**。两处文件的字段完全一致。

### 字段说明

```jsonc
{
  "servers": {
    "<server名>": {
      "transport": "stdio | streamable-http",  // 必填，传输方式
      // stdio 专用：
      "command": "npx",                        // 必填，启动命令
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "E:/code"],
      "env": { "KEY": "$MY_TOKEN" },           // 附加环境变量，值支持 $ENV 插值
      "cwd": "E:/work",                        // 可选，子进程工作目录（默认会话工作区）
      // streamable-http 专用：
      "url": "https://…/mcp",                  // 必填，MCP endpoint
      "headers": { "Authorization": "Bearer $TOKEN" }, // 附加请求头，支持 $ENV 插值
      // 通用：
      "enabled": true,                         // 是否启用（缺省视为启用）
      "approval": "required"                   // 可选：该 server 所有工具调用需人工审批
    }
  }
}
```

### REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/mcp/servers?cwd=` | 合并配置 + 连接状态 + 工具清单 |
| `POST` | `/api/mcp/servers` | 新增/更新（body：`{ name, cwd, scope?, server: {…} }`） |
| `PATCH` | `/api/mcp/servers/:name` | 覆盖更新（body：`{ cwd, scope?, server: {…} }`） |
| `DELETE` | `/api/mcp/servers/:name?cwd=&scope=` | 删除 |
| `POST` | `/api/mcp/servers/:name/test` | 试连（body 带 `server` 则测未保存的表单） |
| `POST` | `/api/mcp/refresh` | 强制重连某 cwd 下所有 server |

> 注意：`cwd` 指**会话工作区**，与 stdio 子进程的 `cwd` 是两个概念，因此请求体把 server 配置嵌套在
> `server` 键下，避免重名。

### 前端界面

侧栏底部「**MCP**」按钮打开配置弹窗，支持：
- 查看每个 server 的状态徽标（已连接/连接中/连接失败/已禁用）、工具数量、工具清单；
- 新增 / 编辑 / 删除、启用停用开关、测试连接；
- 新增时可直接"测试连接"验证未保存的配置。

配置保存后后端会自动让所有活跃会话重载，MCP 工具立即出现在该会话的工具列表里（`getActiveTools`，
`mcp__<server>__<tool>` 命名）。

---

## 四、配置示例

### 示例 1：本地 stdio 文件系统 server（用户级）

写入 `~/.pi/agent/mcp.json`：

```json
{
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "E:/code"],
      "enabled": true
    }
  }
}
```

效果：会话里出现 `mcp__filesystem__read_file`、`mcp__filesystem__write_file` 等工具。

### 示例 2：远程 streamable-http server（带审批）

```json
{
  "servers": {
    "my-remote-mcp": {
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer $MCP_TOKEN" },
      "enabled": true,
      "approval": "required"
    }
  }
}
```

`approval: "required"` 使该 server 的每次工具调用都先在 Web 端弹审批框（复用既有审批流程），
适合有外部副作用的 server。

> **注意：当前只支持"静态请求头"鉴权（Bearer token / API Key）。** 需要 OAuth 交互授权的
> server（如 GitHub Copilot MCP `https://api.githubcopilot.com/mcp/`）连接会报
> `Authorization header is badly formatted` 或 401——请改用接受静态 Bearer / PAT 的 server
> （如自建或社区实现）。OAuth 支持在后续版本计划中。

### 示例 3：工作区级（项目私有）

在项目根目录建 `.pi/mcp.json`：

```json
{
  "servers": {
    "local-db": {
      "transport": "stdio",
      "command": "node",
      "args": ["./mcp-servers/db-server.mjs"],
      "cwd": "E:/code/my-project"
    }
  }
}
```

这个 server 只在 `E:/code/my-project` 的会话里出现，不会污染其他项目。

### 示例 4：本地测试 server（本仓库自带）

本仓库自带一个测试用 stdio MCP server（暴露 `echo` / `add` / `fail` 三个工具）：
`node-pi/server/test/fixtures/mcp-test-server.mjs`。可用于快速验证整条链路：

```json
{
  "servers": {
    "smoke": {
      "transport": "stdio",
      "command": "node",
      "args": ["E:/code/pi_py/node-pi/server/test/fixtures/mcp-test-server.mjs"]
    }
  }
}
```

---

## 五、验证与排错

- **测试连接**：配置页里对每个 server 点「测试」，成功会返回发现的工具数，失败会显示具体报错。
- **状态徽标**：`已连接` 正常；`连接失败` 展开可看错误信息（命令不存在、握手超时、URL 不可达等）；
  `已禁用` 表示该 server 被关掉了。
- **"模型看不到 MCP 工具"？** 先确认两点：① server 状态为「已连接」且 `enabled: true`；② **会话的工作区
  （cwd）与配置 MCP 的工作区一致**——MCP 是按工作区生效的，在 A 工作区配的 server 不会出现在 B 工作区的
  会话里。满足后：
  - 工具会出现在会话的工具列表（`getActiveTools`，`mcp__<server>__<tool>`）和系统提示词的
    **Available tools** 区（`mcp__<server>__<tool>: <描述> (MCP server: <server>)`）；
  - 先建会话、后配 MCP 也没问题——配置保存会自动让会话 reload，无需重开。
- **调用被拦？** 规划（Plan）模式会拦截所有 `mcp__` 工具；配了 `approval` 的 server 需要前端审批。
- **stdio 起不来？** 检查 `command`/`args`（如 `npx` 是否可用、路径是否正确）、子进程输出只在 stderr
  （MCP 走 stdout 传 JSON-RPC，server 不能往 stdout 打日志）。
- **远程连不上？** 若报 `Authorization header is badly formatted` / 401，多半是该 server 要求 OAuth
  交互授权（如 GitHub Copilot MCP），当前仅支持静态 Bearer/API Key 头。
- **超时**：连接握手默认 15 秒超时；远程 server 慢可以看错误里的耗时信息。

---

## 六、相关文档

| 文档 | 内容 |
|---|---|
| [`docs/node-mcp-support.md`](node-mcp-support.md) | MCP 功能的设计与实现细节（架构、事件通道、安全边界） |
| [`docs/node-mcp-implementation.md`](node-mcp-implementation.md) | MCP 实现详解（逐文件代码走读） |
| [`docs/node-web-plan-mode.md`](node-web-plan-mode.md) | Plan 模式（MCP 工具在规划期被拦截） |
| [`docs/node-command-approval.md`](node-command-approval.md) | 工具审批（MCP `approval` 复用的流程） |
| [MCP 官网](https://modelcontextprotocol.io/) | 协议规范与生态 |
