# Node Pi 后端开发规范

更新日期：2026-08-18

本规范适用于 `node-pi/server/` 的代码、测试和仓库内扩展。Node 后端是面向实际使用的
Fastify 服务，直接集成 `@earendil-works/pi-coding-agent`；`pi-python/` 是学习与兼容参考
实现。两者必须继续对共享 Vue 前端维持相同的 `/api` REST、SSE 事件和错误响应契约。

## 1. 目录与职责

```text
node-pi/server/
├── src/
│   ├── app.ts                  # 应用装配、依赖创建、生命周期与全局错误处理
│   ├── server.ts               # 进程入口：读取配置并监听端口
│   ├── config.ts / errors.ts   # 基础设施配置、统一 API 错误
│   ├── routes/                 # HTTP/SSE 适配层；按资源拆分，保持薄
│   └── services/               # 业务逻辑、Pi SDK 适配、状态与文件操作
├── extensions/                 # 本后端专属扩展（每个 .ts/.js 文件一个扩展）
├── test/                       # Vitest；目录结构尽量映射 src/
├── package.json
└── README.md                   # 启动与对外使用说明
```

依赖方向固定为：`routes → services → Pi SDK / Node 标准库`。`app.ts` 只负责组装和注入，
`server.ts` 只负责启动；路由不得直接创建 Pi Session、读写持久化配置，或承载长生命周期状态。

新增能力的落点：

- 新 API：先定义/确认前端协议，再新增 `src/routes/<resource>.ts` 和对应 service；在 `app.ts`
  显式注册。
- 新 Pi 会话能力：放在 `AgentRegistry` 或其工厂适配层，对外暴露小而可测的接口；不要把 SDK
  的未稳定内部字段扩散到路由层。
- 新的本地持久化、工作区、模型或资源逻辑：各自一个 service，构造函数接受路径或依赖，便于测试替换。
- 新工具或事件钩子：放在 `extensions/`，不要为了加载单个扩展修改 `app.ts` 或路由。

## 2. HTTP、SSE 与错误契约

- 以现有 Vue 调用和 Python 后端行为为兼容基线。变更路径、成功响应、SSE 载荷或状态字段前，
  同时检查 `web/src/lib/api.ts`、`web/src/lib/agent-events.ts`、相关 Pinia store 和 Python 实现。
- 输入在路由边界校验；校验失败抛 `ApiError(422, "validation_error", ...)`。可预期的业务问题使用
  稳定的机器码；未知异常由 `app.ts` 的全局处理器归一为 500。
- 错误响应必须是 `{ error: { code, message, details? } }`。不得将堆栈、凭据、绝对敏感路径或
  SDK 原始错误直接返回给浏览器。
- 长任务以 `202` 接收并经 SSE 发事件；不能阻塞 HTTP 请求等待模型完成。SSE 修改必须保持
  `Last-Event-ID` 回放、断开清理和心跳，且为 hijack 的响应显式补齐 CORS 头。
- 新命令先在 `AgentRegistry.command()` 中定义并校验，再由 `/api/agent/:sessionId` 转发；命令的
  可观察结果应通过状态快照或 SSE 表达。

## 3. Pi 会话、资源与安全

- 一个活动 `sessionId` 对应 `AgentRegistry` 中一个活跃 Pi `AgentSession`。创建、恢复、订阅、
  中止和释放都经过 registry；删除或关闭会话必须取消订阅、拒绝待审批调用、停止流并 dispose。
- `~/.pi/agent` 是原版 Pi 数据目录。认证和模型配置可由 SDK 使用，但 API 绝不能返回真实密钥。
  测试必须传入临时 `agentDir`、工作区和 mock/fake session，禁止触碰真实用户目录或网络。
- 文件与工作区访问必须先确认工作区已登记，并保持 `FileService` 的路径边界与敏感文件拦截。
  新增文件能力时补充越权、符号链接（如适用）和敏感文件测试。
- 危险工具调用必须默认拒绝。审批扩展只负责拦截、发布事件和等待决定；待审批队列、超时、会话
  取消和 SSE 转发由 `ToolApprovalBroker` 作为唯一真相源维护。

## 4. 扩展规范

### 4.1 唯一的仓库扩展目录

本次目录重构后的**规范位置**是 `node-pi/server/extensions/`：一个 `.ts` 或 `.js` 文件就是一个
可独立加载的扩展，默认导出 `ExtensionFactory`。扩展可注册工具或订阅 Pi 事件，但不应依赖 Fastify
实例、路由对象或另一扩展的模块级单例。

`OriginalPiSessionFactory.loader()` 通过 `serverExtensionDirectory()` 统一解析这一目录，并由
`extension-loader.test.ts` 证明内置扩展实际能被发现。目录再次重构时，必须同步更新该函数、加载
测试和文档；不要依赖相对层级散落在各处的路径计算。

### 4.2 加载与隔离

- 默认资源加载器仍会发现用户级 `~/.pi/agent/extensions/` 和工作区 `.pi/extensions/`；仓库内
  `server/extensions/` 是本服务的额外扩展来源，不替代前两者。
- 扩展可能在 Web、TUI 或 RPC 宿主加载。涉及 Web 专属行为时必须使用宿主上下文守卫（例如
  `ctx.hasUI`），不能仅依赖目录位置判断。
- 扩展由 jiti 隔离加载，不能以 import 的方式共享服务端单例。需要协作时使用注入给 loader 的
  `pi.events`，并把通道名和 payload 当作版本化契约。
- 自定义依赖安装在 `node-pi/server`，且必须加入 `package.json` 与 lockfile；优先使用 SDK 已提供的
  包，避免引入只为一个扩展服务的大型运行时依赖。

### 4.3 事件通道契约

- 通道名采用 `pi:<domain>:<action>`，载荷必须是 JSON 可序列化的 plain object，并包含关联会话与
  调用 ID（适用时）。禁止传递函数、类实例、Error 或模块对象。
- 事件生产者与消费者各自维护的常量必须保持相同，并有契约测试断言；更改通道名或 payload 属于
  兼容性变更，需同步服务端、扩展、SSE/UI 和文档。
- 等待型扩展必须有中止处理和保守的超时结果；批准、拒绝、超时、会话移除、应用关闭都必须幂等地
  清理监听器与定时器。

### 4.4 新扩展最低交付清单

1. 在 `extensions/<feature>.ts` 实现默认导出工厂，并使用唯一、描述性的工具/事件名称。
2. 为规则、输入和结果写纯单元测试；涉及事件桥接时，用真实 `createEventBus()` 覆盖成功、拒绝、
   超时与 AbortSignal/会话关闭路径。
3. 为加载路径加覆盖，确认 `server/extensions/` 中的文件会被发现；如改变前端可见行为，再补 API/SSE
   集成测试。
4. 更新 `extensions/README.md`，记录用途、权限/安全边界、事件契约和运行依赖。

## 5. TypeScript 与测试规范

- 使用 ESM 和 NodeNext：源码内部相对 import 使用 `.js` 后缀，类型用 `import type`；保持
  `strict`，不使用无理由的 `any` 或无边界的 `as unknown as`。必须兼容 SDK 未公开结构时，将
  duck-typing 局限在一个有注释、有测试的适配点。
- 代码注释解释设计原因、协议限制或安全边界；不要复述显而易见的实现。公开类、关键方法和复杂
  生命周期逻辑保留中英双语的项目既有风格。
- 单元测试放 `test/services/`，Fastify 路由/装配测试放 `test/`。优先依赖注入 fake session、临时
  目录和 `app.inject()`；测试不得要求模型凭据、桌面 UI 或外网。
- 每项行为变更至少覆盖正常路径与一个失败/边界路径。资源释放、审批、SSE 和持久化变更必须覆盖
  取消、超时或重启恢复等生命周期边界。

提交前在本目录执行：

```powershell
npm run typecheck
npm test
npm run build
```

## 6. 文档与提交

- 对外启动、配置或目录变化同步更新本目录 `README.md`；扩展变化同步更新
  `extensions/README.md`；跨后端行为变化同步更新 `docs/node-pi-backend.md` 与仓库说明。
- 提交采用 Conventional Commits：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`；每个提交
  聚焦一个可验证的变更。
- 提交前确认 `git status` 仅包含本次改动；不要提交 `node_modules/`、`dist/`、会话、凭据或本地
  工作区数据。
