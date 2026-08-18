# Node 后端扩展系统

更新日期：2026-08-18

## 目的

Node 后端使用原版 Pi SDK 的 `DefaultResourceLoader` 加载工具和事件钩子。扩展将 Pi SDK 的
可扩展点与 Fastify 服务分开：HTTP 路由不需要知道每一个工具或钩子的实现，新扩展也不需要修改
`app.ts` 才能被发现。

## 目录和发现规则

仓库内的唯一规范目录是 `node-pi/server/extensions/`。服务创建每个 Pi Session 的资源加载器时，
`OriginalPiSessionFactory.loader()` 会扫描该目录下的直接 `.ts`、`.js` 文件，并作为
`additionalExtensionPaths` 传给 SDK。

它同时保留 SDK 原有的用户级和工作区级扩展发现：

```text
~/.pi/agent/extensions/          # 用户级；由 Pi SDK 自动发现
{workspace}/.pi/extensions/      # 工作区级；由 Pi SDK 自动发现
node-pi/server/extensions/        # 本服务随仓库发布的扩展
```

这三个来源不会互相替代。仓库目录只放服务内置或随服务发布的能力；用户和工作区扩展仍由 SDK
按原有语义发现。

## 如何接入新扩展

1. 新建 `node-pi/server/extensions/<feature>.ts`。
2. 默认导出 `ExtensionFactory`；可调用 `pi.registerTool()` 注册工具，或使用 `pi.on()` 订阅生命周期
   与工具调用事件。
3. 若扩展需要与服务端协作，通过 `pi.events` 传递 JSON 载荷；不要 import 服务端单例，因为扩展
   由 jiti 隔离加载。
4. 为事件通道常量与载荷写契约测试；等待型逻辑必须处理超时和 `AbortSignal`。
5. 更新 `node-pi/server/extensions/README.md`，说明功能、权限边界和配置。

## 实现要点

`serverExtensionDirectory()` 集中计算源码和构建产物使用的目录：从 `src/services/` 或
`dist/services/` 上溯两级均会落到 `server/`，再进入 `extensions/`。`discoverLocalExtensions()`
只读取直接子文件，并按名称排序，保证加载顺序稳定。其测试会确认内置的
`tool-approval.ts` 与 `plan-mode.ts` 能够在规范目录中被发现。

这样目录重构不会悄悄导致“文件存在但扩展未加载”。
