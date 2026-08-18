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

## 说明

- 依赖解析：扩展通过 jiti 加载，可直接 import `@earendil-works/pi-coding-agent`、
  `@earendil-works/pi-ai`、`typebox` 等（SDK 已做虚拟模块映射）。
- 需要自定义依赖时，可把依赖装到 `node-pi/server` 下（扩展在运行时从那里解析）。
- 空目录（只有本 README）时后端正常启动、不加载任何扩展。
