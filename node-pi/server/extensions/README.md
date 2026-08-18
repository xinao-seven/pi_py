# node-pi 扩展目录

本目录存放「Node 版 pi（`node-pi/server`）」的扩展。放一个 `.ts` 或 `.js` 文件即可被
后端自动加载（通过 `DefaultResourceLoader.additionalExtensionPaths` 扫描），无需改服务端代码。

## 隔离说明

- 本目录的扩展**只**在 web 版（node-pi/server）里加载；
- 原版 pi（TUI）在 `~/.pi/agent/extensions/` 与 `{工作区}/.pi/extensions/` 下的扩展**不会**进入本后端；
- 两边扩展互不影响。

## 扩展格式

一个 `.ts` 文件，default export 一个工厂函数：

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const myTool = defineTool({
  name: "hello",
  label: "Hello",
  description: "A simple greeting tool",
  parameters: Type.Object({ name: Type.String({ description: "Name to greet" }) }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    return { content: [{ type: "text", text: `Hello, ${params.name}!` }], details: {} };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(myTool);
}
```

也可以订阅事件钩子（`pi.on("tool_call", ...)`、`pi.on("session_start", ...)` 等），
参考 SDK 自带的示例：`node_modules/@earendil-works/pi-coding-agent/examples/extensions/`。

## 内置扩展：工具审批（tool-approval.ts）

Pi 的 bash 工具可以执行任意命令，而 Web 前端没有 Pi 终端的确认 UI，所以这个扩展把
「命中危险命令规则 → 挂起等待审批 → 放行/拦截」拆成两步配合后端（`node-pi/server`）：

1. 命中 `DANGEROUS_COMMAND_RULES` 里的规则时，通过事件总线发布 `pi:tool_approval:pending`
   给后端，后端创建挂起项（带决策超时，默认 30 秒）并转成 SSE 事件推给前端，弹出审批对话框；
2. 扩展在事件总线上等待后端转达的决定（`pi:tool_approval:decide`）——前端审批、决策超时、
   会话取消都会触发决定；`AbortSignal` 中止工具调用时，扩展发布 `pi:tool_approval:aborted`
   让后端清理并按拒绝结算。

挂起队列与决策超时由服务端 `ToolApprovalBroker` 维护，是唯一真相源（会话销毁时能立即
拒绝挂起项）；扩展是无状态桥，只做规则匹配、宿主守卫、总线请求/响应与中止感知。

### 宿主守卫（Web 与 TUI 平级）

Web 后端默认走与原版 pi 相同的扩展自动发现（`~/.pi/agent/extensions/` 与
`{cwd}/.pi/extensions/`），本扩展可能被任意宿主从任意目录加载。它只在 **Web 后端**生效：

- 区分依据是 `tool_call` 处理器的 `ctx.hasUI`：TUI / RPC 有交互式确认 UI（`hasUI === true`），
  直接放行；
- Web 后端用 `createAgentSession` 编程式创建会话、不绑定 UI 上下文（`hasUI === false`），
  才走事件总线审批。

所以把本扩展放进 `~/.pi/agent/extensions/` 等共享目录也不会影响 TUI 的确认流程。

### 事件通道契约

扩展与后端**不共享模块实例**（jiti 隔离），所有通信走 `pi.events`（事件总线）。
通道名是两端之间的契约，改动时必须同步修改两边：

| 通道 | 方向 | 载荷 |
| --- | --- | --- |
| `pi:tool_approval:pending` | 扩展 → 后端 | `{ sessionId, toolCallId, toolName, args, reason, rule }` |
| `pi:tool_approval:decide` | 后端 → 扩展 | `{ sessionId, toolCallId, approved }`（前端审批、决策超时、会话取消都会发） |
| `pi:tool_approval:aborted` | 扩展 → 后端 | `{ sessionId, toolCallId }`（工具调用被 AbortSignal 中止） |

通道名两端各有一份常量（`node-pi/extensions/tool-approval.ts` 与
`node-pi/server/src/services/tool-approval.ts`），测试里有断言保证它们一致。

服务端对应实现见 `node-pi/server/src/services/tool-approval.ts`（`ToolApprovalBroker`）；
规则集与 Python 学习后端（`pi-python/server/services/tool_approval.py`）保持一致，
保证两个后端的审批策略相同。

## 说明

- 依赖解析：扩展通过 jiti 加载，可直接 import `@earendil-works/pi-coding-agent`、
  `@earendil-works/pi-ai`、`typebox` 等（SDK 已做虚拟模块映射）。
- 需要自定义依赖时，可把依赖装到 `node-pi/server` 下（扩展在运行时从那里解析）。
- 空目录（只有本 README）时后端正常启动、不加载任何扩展。
