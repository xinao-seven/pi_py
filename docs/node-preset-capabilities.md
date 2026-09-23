# 预设能力清单 + 「极简（原版 pi）」模式

> 类型：行为变更（预设契约扩展 + 会话能力开关 + 内置极简预设）+ 前端设置页改版。
> 三条既有不变量一条没动：CLI 照常运行、共享态只做增量写入、trace 对 agent loop 零影响。

## 1. 问题：预设管不到"平台能力"

改动前预设只有 6 个字段（`name` / `systemPrompt` / `toolNames` / `compaction` / 模型三件套 / `mcpServers`），
平台侧的东西（Plan、危险命令审批、`ask_user`、`subagent`、任务面板）**全部无条件开启**：

| 能力 | 会话级开关 | 之前能否被预设关掉 |
| --- | --- | --- |
| 危险命令审批 | `extensions.approval` | ❌ 预设里没有这个字段，`POST /api/agent/new` 也不透传 |
| Plan 模式 | `extensions.planMode` | ❌ 同上 |
| 提问通道 | `extensions.questions` | ❌ 同上 |
| 子任务委派 | ——（loader 里无条件注册） | ❌ 连会话级开关都还没有 |
| 任务面板 / 断点续跑提示 | ——（`announceTask` / `announceRecovery` 无条件推） | ❌ 同上 |
| 观测钩子 | ——（loader 里无条件注册） | ❌ 同上 |
| 用户文件扩展 | ——（SDK 自动发现，只有同名接管过滤） | ❌ 同上 |

同时用户提出一个明确诉求：**要一个「和原版 pi 一模一样、什么都不加」的会话**——
既不用平台能力，也不要我们注入的工具/提示词/MCP，只是一个干净的 Pi 会话。

## 2. 能力清单（7 个开关）

预设新增 `capabilities`，7 个字段都可以显式关掉；**未指定一律视为开启**，
因此磁盘上的旧预设零迁移（`preset-service.test.ts` 有专门的旧文件兼容用例）。

| 字段 | 关掉之后 | 后端落点 |
| --- | --- | --- |
| `plan` | 不注册 Plan 内联扩展、不并入 5 个计划工具；`plan_*` 命令 409 | `extensions.planMode` |
| `approval` | 危险 bash 命令不再挂起等确认（直接执行） | `extensions.approval` |
| `questions` | 不注册 `ask_user` 工具 | `extensions.questions` |
| `subagent` | 不注册 `subagent` 工具（子会话本来就到深度上限不注册） | `extensions.subagents` |
| `tasks` | 不注入任务恢复扩展、不推 `task_updated` / `plan_updated` / `task_recovery_required`，前端不显示面板入口 | `extensions.tasks` |
| `observability` | 不注册 provider 层观测钩子（trace 记账仍在，见 §6） | `extensions.observability` |
| `fileExtensions` | 不发现 `~/.pi/agent/extensions/` 与 `{cwd}/.pi/extensions/` | `extensions.fileExtensions`（`noExtensions: true`） |

约束：**`plan` 依赖 `tasks`**（Plan 是 `origin='plan'` 任务的受控视图）。`plan=true` 且 `tasks=false`
在写入方向直接 422，而不是运行时静默降级——错误要在用户按保存时就看见。

工具选择同时从「勾选清单」升级为三态（对应后端 `toolNames` 的三种取值）：

| UI 档位 | `toolNames` | 含义 |
| --- | --- | --- |
| 全部（SDK 默认） | `null` | 不限制白名单：SDK 自己发现可用工具（极简模式必须用这一档） |
| 自选 | `string[]` | 白名单；不在名单里的工具调用会 `not found` |
| 关闭 | `[]` | 无工具 |

压缩策略同理多了一档 **「跟随设置（不覆盖）」**（`compaction: null`）——之前预设一定会写
`SettingsManager.applyOverrides()`，会把 `settings.json` 里用户自己的压缩设置盖掉。

## 3. 「极简（原版 pi）」内置预设

`preset-service.ts` 的 `BUILTIN_MINIMAL`（id = `minimal`）与 `coding-agent` 一样是**合成内置预设**：
不落盘、不可改删，列表里排第二。

| 字段 | 值 | 效果 |
| --- | --- | --- |
| `capabilities` | 全部 `false` | 不装配任何内联扩展，不推任务/计划事件 |
| `toolNames` | `null` | SDK 自己发现工具（不限制白名单） |
| `compaction` | `null` | 不覆盖 `settings.json` |
| `systemPrompt` | `''` | 走 SDK 默认提示词发现（含 AGENTS.md / SYSTEM.md） |
| `mcpServers` | `[]` | 连 MCP 扩展都不注册 |
| 模型 / 思考等级 | `''` | 跟随目录设置 |

`spike/08-preset-capabilities.mjs` 用真实 SDK 验证了结果：极简会话的 `getActiveToolNames()`
只剩 SDK 内置工具（`read,bash,edit,write`），不含 `propose_plan` / `ask_user` / `subagent`，
自造的用户文件扩展也没有被加载。

## 4. 契约

### 4.1 预设（`GET/POST/PATCH /api/presets`）

```jsonc
{
  "name": "只读助手",
  "systemPrompt": "",
  "toolNames": ["read", "grep"],   // null = SDK 默认发现；[] = 无工具
  "compaction": null,              // null = 不覆盖设置
  "capabilities": {
    "plan": false, "approval": true, "questions": true,
    "subagent": false, "tasks": true,
    "observability": true, "fileExtensions": true
  },
  "provider": "", "modelId": "", "thinkingLevel": "",
  "mcpServers": null
}
```

读取时归一化：旧文件缺 `capabilities` 会被补成「全开」；缺字段的 `toolNames`/`compaction`
按数组/对象校验（`isStoredPreset`），写入时 `{ ...原记录, ...校验结果 }` 保留我们不认识的字段。

### 4.2 会话创建（`POST /api/agent/new`）

请求新增 `extensions`（7 个布尔，非布尔 422；未知键忽略），并接受 `toolNames: null`
与 `compaction: null`（与缺省等价）：

```jsonc
{
  "cwd": "…", "message": "…",
  "toolNames": null,          // 不限制白名单
  "compaction": null,         // 不覆盖设置
  "mcpServers": [],
  "extensions": { "planMode": false, "approval": false, "questions": false,
                  "subagents": false, "tasks": false,
                  "observability": false, "fileExtensions": false }
}
```

响应新增会话能力位（`sessionCapabilitiesOf()`，只看入参开关，不看服务装配）：

```jsonc
{ "success": true, "sessionId": "…",
  "capabilities": { "plan": true, "approval": true, "questions": true, "subagent": true,
                    "tasks": true, "observability": true, "fileExtensions": true, "mcp": true } }
```

字段名差异集中在一处：`web/src/lib/preset-capabilities.ts` 的 `capabilitiesToExtensions()`
（`plan → planMode`、`subagent → subagents`），前端测试锁死这份映射。

## 5. 能力位在前端的作用与取舍

- 会话创建成功后，前端把 `capabilities` 存进 `useAgentSession.sessionCapabilities`；
  `ChatWindow` 的计划/任务入口按钮由 `shouldShowWorkPanel(capabilities)` 决定
  （`tasks: false` 时连入口都不出现，避免点开一个永远空着的面板）。
- **历史会话 / 刷新页面后能力位未知（`null`）→ 按「显示」处理**：后端行为早已由创建时的
  开关决定，前端只决定要不要给入口；不为了 UI 去写共享会话文件（决策已冻结，见下）。
- 能力位**不持久化**：它只在创建会话的那一刻决定「装配了哪些工具/扩展」，不需要额外存储；
  前端的内存记忆只为少一个空面板，丢了也不影响任何会话行为。

## 6. 与 CLI 的一致性：极简模式恰好是唯一的例外

原版 pi（TUI）本来就会加载 `~/.pi/agent/extensions/`、`AGENTS.md`、默认提示词与全部内置工具。
因此「能力全开」的 Web 会话在工具层与 CLI 基本一致（多出来的是平台内联扩展），
我们把同名的官方 `plan-mode` / `subagent` 扩展**按目录名过滤**掉（避免双状态机，见
`docs/node-plan-extension-ownership.md`），并且**只过滤本次真的注册了内联实现的那些**：

- 关掉 `plan` → 不再过滤 `plan-mode`，用户装的官方扩展照常加载（改动前是「一律过滤」，属缺陷）；
- 关掉 `subagent` → 同理。

**极简预设是唯一的例外**：它按用户要求把 `fileExtensions` 也关掉（`noExtensions: true`），
所以同一个会话在 CLI 里用户扩展生效、在 Web 极简会话里不生效。这是刻意的取舍：
用户要的是「Web 这边什么都不加」，而不是「和 CLI 逐字节一致」。

trace 记账（`AgentRegistry.publish()` → `SessionLedger`）在极简会话里**保留**：
它是只读旁路、fire-and-forget，不进入模型请求；`observability` 开关关掉的是
provider 层观测钩子（会话侧的采集扩展），不是账本本身。

## 7. 顺带修掉的两个既有缺陷

1. **`subagent` 没并入工具白名单**：`withInlineTools()` 只并了计划工具与 `ask_user`，
   于是任何指定了 `toolNames` 的预设会话里，`subagent` 调用都会 `Tool subagent not found`
   （`tools` 是可用集，不是激活集）。现在按开关并入，spike 直接断言工具列表里含 `subagent`。
2. **同名文件扩展过滤过宽**：以前无论开关如何都 drop `plan-mode` / `subagent`，
   导致「关掉内联 Plan 的预设」连用户自己装的官方 plan-mode 扩展也一起失效。
   现在只 drop 本次实际接管的目录名（`dropInlineOwnedExtensions(result, owned)`）。

## 8. 验证证据

| 命令 | 结果 |
| --- | --- |
| `npm --prefix node-pi/server run typecheck` / `test` | exit 0；**399** 用例全绿（新增 12 条） |
| `npm --prefix node-pi/server run build` / `spike` | exit 0；spike 全绿，新增 `spike/08-preset-capabilities.mjs` **15 项断言** |
| `npm --prefix web run typecheck` / `lint` | exit 0（lint 0 error） |
| `npm --prefix web run test` / `build` | exit 0；**149** 用例全绿（新增 9 条） |

关键断言：

- 后端 `agent-registry-factory.test.ts`：能力关掉后 `tools` 白名单里不再出现对应工具；
  `fileExtensions: false` → `noExtensions: true` 且 `extensionFactories` 为空；
  `mcpServers: []` → 连 MCP 扩展都不装配。
- 后端 `preset-service.test.ts`：极简内置预设的完整形状与不可改删；`plan=true && tasks=false` → 422；
  能力位与 `null` 模式 round-trip；旧文件（无 `capabilities`）读成「全开」。
- 后端 `app.test.ts`：`extensions` 非布尔 422；`toolNames: null` + `compaction: null` + 全关能力 202 且能力位全 false。
- `spike/08-preset-capabilities.mjs`：默认会话里 `subagent` 已并入、用户文件扩展按白名单生效；
  极简会话只剩 SDK 内置工具、不含内联工具也不加载用户扩展。
- 前端 `PresetConfig.test.ts` / `useAgentSession.test.ts` / `preset-capabilities.test.ts`：
  极简卡片摘要、工具「全部」与压缩「跟随设置」保存为 `null`、能力开关落盘、
  创建请求带 `extensions` 且在 `null` 模式下省略 `toolNames`/`compaction`、面板可见性判定。

## 9. 已知限制

1. **极简会话与 CLI 在扩展层不一致**（`fileExtensions: false`，见 §6）——这是用户明确选择的取舍。
2. 能力位**不持久化**：刷新页面后前端不知道这个历史会话关掉了任务面板，入口会重新出现（空态）；
   后端行为不受影响。若将来要持久化，应写成会话 JSONL 里的自定义条目（只增不改）。
3. 已存在的会话**不能中途改能力位**：`set_tools` 一类命令只能改工具数组，没有「取消白名单」或
   「补装 Plan 扩展」的通道。要换能力就新建会话（与「工具集恒定」的缓存策略一致）。
4. 观测钩子关掉后，该会话在「用量」面板里缺少 provider 层 HTTP 明细（run/token 记账仍在）。

## 10. 变更文件

```
改  node-pi/server/src/services/agent-registry.ts
      · SessionExtensions / SessionCapabilities / sessionCapabilitiesOf
      · inlineCapabilities()（开关解析）· loader() 按开关注册 + noExtensions + 定向 drop
      · withInlineTools 按开关并入（含 subagent）· RegistryEntry.capabilities 广播过滤
改  node-pi/server/src/routes/agent.ts        · extensions 透传 + 响应 capabilities + null 语义
改  node-pi/server/src/services/preset-service.ts
      · capabilities / toolNames|null / compaction|null + 内置 minimal + 读时归一化
新  node-pi/server/spike/08-preset-capabilities.mjs（接入 npm run spike）
改  node-pi/server/{test/services/agent-registry-factory,agent-registry-extensions,preset-service}.test.ts
改  node-pi/server/test/app.test.ts
改  web/src/types/index.ts / web/src/lib/api.ts
新  web/src/lib/preset-capabilities.ts（能力映射 + 文案 + 面板可见性）
改  web/src/composables/useAgentSession.ts    · presetCapabilities / sessionCapabilities 透传
改  web/src/components/AgentControls.vue      · 工具四档
改  web/src/components/PresetConfig.vue       · 能力开关区 / 工具三态 / 压缩 follow / 摘要
改  web/src/components/ChatWindow.vue         · 面板入口按能力位隐藏
新  web/test/lib/preset-capabilities.test.ts
改  web/test/{components/PresetConfig,composables/useAgentSession}.test.ts
```
