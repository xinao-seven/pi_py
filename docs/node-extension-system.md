# Node 后端扩展系统

更新日期：2026-08-28

## 目的

Node 后端使用原版 Pi SDK 的 `DefaultResourceLoader` 加载工具和事件钩子。本服务需要给每个会话
注入 Web 专属能力（工具审批、Plan 模式、MCP 工具），这些能力需要与服务端单例协作。仓库采用
**内联扩展**而非 jiti 文件扩展：内联扩展在服务端模块图里创建，闭包可直接引用服务单例，不需要
事件总线桥接。

## 内联扩展（仓库内）

`OriginalPiSessionFactory.loader()` 把 `extensionFactories` 传给 `DefaultResourceLoader`，
每个会话创建/打开、`reload_resources` 或 MCP 配置变更后都会重跑这些工厂：

```ts
// src/services/agent-registry.ts  loader(cwd, systemPrompt, extensions)
const factories: InlineExtension[] = [];
if (extensions?.planMode !== false && this.plans) factories.push(this.plans.buildExtension());
if (extensions?.approval !== false && this.approvals)
  factories.push(this.approvals.buildExtension());
if (this.mcpService) factories.push(buildMcpExtension(this.mcpService, cwd, this.approvals));
new DefaultResourceLoader({ cwd, agentDir: this.agentDir, extensionFactories: factories });
```

- `ToolApprovalBroker.buildExtension()`：注册 `tool_call` 钩子，命中危险命令规则时调用
  `requestApproval()` 挂起等待决定（`src/services/tool-approval.ts`）。
- `PlanModeService.buildExtension()`：为每个会话注册 Plan 生命周期钩子（工具权限的最终约束点），
  钩子委托给按会话隔离的 `PlanMachine`（`src/services/plan-mode-service.ts`）。
- `buildMcpExtension()`：按当前 cwd 注册 MCP 工具集，审批工具复用 broker（`src/services/mcp/`）。

## 文件扩展（用户级/工作区级）

仓库不随服务发布 jiti 文件扩展，但保留 SDK 原有的用户级和工作区级扩展发现（与 TUI 平级）：

```text
~/.pi/agent/extensions/          # 用户级；由 Pi SDK 自动发现
{workspace}/.pi/extensions/      # 工作区级；由 Pi SDK 自动发现
```

这些文件扩展由 jiti 隔离加载，不能 import 服务端单例；需要与服务端协作时通过 `pi.events`（事件
总线）传递 JSON 载荷，并把通道名和 payload 当作版本化契约。用户扩展属于个人扩展生态，不在本
仓库文档的扩展清单内。

## 如何接入新能力

1. 在 `node-pi/server/src/services/<feature>.ts` 写一个类，提供 `buildExtension(): InlineExtension`。
2. 工厂内可注册工具（`pi.registerTool()`）或订阅生命周期/工具事件（`pi.on()`）；需要按会话隔离的
   状态在工厂内创建（参考 `PlanMachine`）。
3. 在 `OriginalPiSessionFactory.loader()` 的 `extensionFactories` 中按顺序注册；如需预设开关，
   通过 `CreateSessionInput.extensions.<feature>` 透传，默认开启。
4. 为规则、输入和结果写纯单元测试；用假 `pi` 覆盖成功、拒绝、超时与 `AbortSignal`/会话关闭路径。
5. 同步更新 `docs/node-extension-system.md` 与相关功能文档。

## 钩子顺序与安全

- `tool_call` 处理器按 `extensionFactories` 注册顺序执行，遇 `{ block: true }` 短路。顺序保持
  `plan → approval → mcp`：规划期先拦下危险命令/`mcp__` 工具，避免先弹审批框。
- 涉及 Web 专属行为时保留 `ctx.hasUI` 守卫，避免扩展被共享到 TUI/RPC 宿主时绕过其确认 UI。
