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
│   └── services/               # 业务逻辑、Pi SDK 适配、状态与文件操作、内联扩展
│       ├── platform/           # 平台存储（M1）：迁移、trace 领域模型、写入队列、SQLite/内存后端
│       └── observability/      # trace 采集与查询（M1）：session-ledger、redact、metrics、provider 钩子
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
- 新工具或事件钩子：以"内联扩展"实现——在 `services/` 写一个类，提供 `buildExtension()` 返回
  `InlineExtension`，并在 `OriginalPiSessionFactory.loader()` 的 `extensionFactories` 中注册。
  仓库内不再使用 jiti 文件扩展；用户级/工作区级扩展仍由 SDK 自动发现。
- 新可观测指标（M1 之后）：**一律加在既有的唯一插桩点上**，不要在路由、工具或会话方法里新增
  trace 写入。简单指标改 `services/observability/session-ledger.ts`；需要新字段就先改
  `services/platform/migrations.ts` 的建表（新增迁移版本，不要改已发布的 DDL）；聚合口径与取整
  只在 `services/observability/metrics.ts` 定义。任何记帐代码都必须 try/catch 降级，绝不抛给
  agent loop，也不要写入对话正文（默认只存 digest 与预览）。详见 `docs/node-observability-m1.md`。
- 新领域实体（M2 起的任务式）：模型放 `services/platform/<entity>-model.ts`（类型与纯函数，
  状态由函数聚合而不是散落在各处），持久化放 `services/platform/<entity>-repository.ts`
  （SQLite + 内存双实现，语义必须一致并有等价性测试），用例放 `services/<entity>-service.ts`，
  接口放 `routes/<entity>.ts`。需要并发保护时用「版本号 + 单语句 UPDATE 判定 changes」的
  乐观锁，不要用读写锁或多语句事务。返回给前端的结构要带上并发所需字段（如 `revision`）。
- 涉及「长时间执行 + 可能崩溃」的新能力（M3 起的续跑、M4 的计划执行）：必须走
  `TaskService` 的租约与在飞动作接口，不要自己记「正在跑」的内存状态——
  崩溃后内存状态一定丢，能被恢复的只有落库的东西。恢复路径必须遵守三条：
  只列不跑、无法判定副作用要人工确认、产物在就补记完成而不是重跑。
- 状态迁移的**触发条件不能来自自然语言**（M4 的教训，P2）：需要模型产出结构化信息时，
  注册工具（TypeBox schema + `promptSnippet`/`promptGuidelines`）而不是解析它的文本；
  服务端能校验的一律校验（工具报错比「悄悄接受」对模型更友好）。
- `task.revision` 是**用户可见内容的版本**：执行期运行时写入（租约/心跳/在飞）用
  `mutate(..., { keepRevision: true })`，不要占用版本号——否则模型与面板手里的版本会被心跳顶掉。
  约定 `change()` 返回原对象即「无变化」（不写库、不广播、不动版本号）。
- 新增「模型可见的工具」时注意 SDK 的 `tools` 参数是**可用工具白名单**：
  预设里指定了 `toolNames` 的会话必须并入内联扩展的工具名（`withInlineTools`），
  否则工具会被过滤成 "not found"（M4 spike 抓到的真实缺陷）。
- 可观测的验收方式：能写成 spike 的写 spike（真实 SDK + fauxProvider），能写成 golden set 的
  进 eval（确定性用例 + 阈值门禁）。只靠单测会漏掉 SDK 交互边界与真实时序问题（M4 抓到 5 个）。

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

## 4. 内联扩展规范

### 4.1 仓库内扩展一律内联

本服务不再随仓库发布 jiti 文件扩展。需要给每个会话注入工具或事件钩子时，在 `services/` 写一个
类，提供 `buildExtension(): InlineExtension`，由 `OriginalPiSessionFactory.loader()` 在
`extensionFactories` 中注册。示例：`ToolApprovalBroker.buildExtension()`、
`PlanModeService.buildExtension()`、`buildMcpExtension()`。

内联扩展在服务端模块图里创建，闭包可直接引用服务单例（审批中枢、MCP 连接池），无需事件总线桥接。
每个会话的资源加载器都会调用一次工厂，因此按会话隔离状态要在工厂内创建（参考
`PlanModeService` 的 `PlanMachine`）。

### 4.2 用户级/工作区级文件扩展仍由 SDK 自动发现

默认资源加载器继续发现用户级 `~/.pi/agent/extensions/` 与工作区 `.pi/extensions/`（与 TUI 平级），
仓库不额外扫描自己的扩展目录。用户扩展按 SDK 语义加载，不与服务端共享模块实例。

### 4.3 钩子与顺序

- `tool_call` 处理器按 `extensionFactories` 注册顺序执行，遇 `{ block: true }` 短路。顺序要保持
  `plan → approval → mcp`：规划期先拦下危险命令/`mcp__` 工具，避免先弹审批框。
- 涉及 Web 专属行为时保留宿主上下文守卫（`ctx.hasUI`），避免扩展将来被共享到 TUI/RPC 宿主时
  绕过其自身的确认 UI。
- 等待型钩子必须有中止处理（`ctx.signal`）和保守的超时结果；批准、拒绝、超时、会话移除、应用
  关闭都必须幂等地清理定时器与监听器。

### 4.4 新内联扩展最低交付清单

1. 在 `services/<feature>.ts` 实现提供 `buildExtension()` 的类，使用唯一、描述性的工具/事件名称。
2. 为规则、输入和结果写纯单元测试；用假 `pi`（`on` + 钩子捕获）覆盖成功、拒绝、超时与
   AbortSignal/会话关闭路径。
3. 如改变前端可见行为，补 API/SSE 集成测试；在 `OriginalPiSessionFactory` 工厂测试中确认
   `extensionFactories` 按预设开关正确注入/排除。
4. 同步更新 `docs/node-extension-system.md` 与相关功能文档。

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

- 对外启动、配置或目录变化同步更新本目录 `README.md`；内联扩展变化同步更新
  `docs/node-extension-system.md`；跨后端行为变化同步更新 `docs/node-pi-backend.md` 与仓库说明；
  可观测性（trace/指标/聚合口径）变化同步更新 `docs/node-observability-m1.md`。
- 提交采用 Conventional Commits：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`；每个提交
  聚焦一个可验证的变更。
- 提交前确认 `git status` 仅包含本次改动；不要提交 `node_modules/`、`dist/`、会话、凭据或本地
  工作区数据。
