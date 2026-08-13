# pi_py 完整实施计划

## 1. 项目目标

本项目用于以 Python 学习性复刻 `earendil-works/pi` 的 Agent 与 Coding Agent 核心能力，并以 FastAPI 和 Vue 3 重建 `MaddieMo1/Pi-Agent-Web` 的 Web 使用体验。最终产物应当是一个能够独立运行、结构清晰、可逐层测试的全栈 Coding Agent，而不是对 TypeScript 源码逐行翻译。

项目需要同时满足以下目标：

1. 理解并复现 Agent 的 prompt、LLM streaming、tool call、tool result 和继续推理循环。
2. 兼容 pi Session v3 JSONL 的主要数据结构，使既有会话可以被读取、展示和继续使用。
3. 通过稳定的内部事件协议连接 Python Agent、FastAPI SSE 和 Vue 状态管理。
4. 复刻 Pi-Agent-Web 的核心功能和交互，而不是仅实现一个普通聊天页面。
5. 保持模块边界清晰，使 Provider、工具、持久化和 Web 层可以分别学习与测试。

## 2. 参考基线

本计划以 2026-07-22 本地克隆的代码为权威参考：

| 项目 | 本地路径 | Git 提交 |
|------|----------|----------|
| earendil-works/pi | `E:\code\pi` | `dd6bea41efa8caa7a10fe5a6401676dc5699f83f` |
| MaddieMo1/Pi-Agent-Web | `E:\code\pi-agent-web` | `664f5a9c6f908f392d7d58af15ae60121c5d39e1` |

实现时优先级如下：

1. 本文件记录的边界和验收标准；
2. 参考仓库实际代码和测试；
3. `plan-agent-core.md`、`plan-backend.md`、`plan-frontend.md` 中的原始设计草案。

如果参考仓库以后更新，先记录新的提交号和兼容差异，再决定是否跟进，避免开发过程中接口基线漂移。

## 3. 范围划分

### 3.1 第一版必须实现

- Session v3 JSONL：解析、迁移、追加、树遍历、分支、fork、compaction-aware context。
- 基础消息类型：user、assistant、toolResult、custom。
- Agent 主循环和流式事件。
- steer、follow-up、abort。
- 顺序和并行工具调用；单个工具可以覆盖执行策略。
- read、write、edit、bash、grep、find、ls 工具。
- Anthropic 与 OpenAI-compatible Provider；Provider API Key 配置。
- thinking level、模型切换、工具预设。
- 手动 compaction、自动 compaction 和有限自动重试。
- Skills 与 prompt templates 的本地加载。
- FastAPI Session、Agent、SSE、Files、Models、Skills API。
- Vue 三栏界面、会话树、流式聊天、工具面板、分支导航和文件查看器。
- Windows 作为首要开发平台，同时避免阻断 Linux/macOS。

### 3.2 兼容读取但不完整复刻

- Session 中的 `custom`、`custom_message`、`label`、`branch_summary` 和扩展字段。
- 参考 Web 中已有但不影响主循环的 Session merge。
- 旧版 compaction 事件别名。
- 无法识别或损坏的 Session 作为 orphan 展示，不允许继续运行。

### 3.3 第一版暂缓

- pi 完整 Extension 系统与 TUI。
- 通用的任意 Provider 插件体系。
- OAuth 登录流程；第一版使用 API Key。
- Project Trust 的完整交互式实现。
- 在线 Skills 市场安装；第一版先实现本地发现、启停和加载。
- 音频、移动端深度适配等不影响核心学习目标的增强功能。

## 4. 总体架构

```text
web (Vue 3 + TypeScript)
  ├── REST client
  ├── SSE client
  └── UI state / rendering
             │
             ▼
server (FastAPI)
  ├── routes
  ├── AgentRegistry
  ├── SSE subscriber queues
  └── workspace boundary checks
             │
             ▼
Python core packages
  ├── pi_ai: model/message/tool atoms + Provider adapters
  ├── pi_agent: generic Agent loop + state + events + executable tool abstraction
  └── pi_coding_agent: Session v3 + coding tools + compaction/retry/skills
```

采用根目录 `src` 布局，避免包目录与仓库目录混淆：

```text
pi_py/
├── pyproject.toml
├── src/pi_ai/                 # 对应 packages/ai
├── src/pi_agent/              # 对应 packages/agent
├── src/pi_coding_agent/       # 对应 packages/coding-agent
├── server/
├── web/
├── test/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
└── docs/
```

## 5. 兼容契约

### 5.1 Session 文件

- Header 使用 `type=session`、`version=3`、UUID、ISO 8601 时间、绝对 cwd 和可选 `parentSession`。
- Session entry 保持 append-only；切换分支只移动内存中的 leaf，不修改旧节点。
- entry 使用 8 位十六进制短 ID，并进行碰撞检测。
- 支持 `message`、`thinking_level_change`、`model_change`、`compaction`、`branch_summary`、`custom`、`custom_message`、`label` 和 `session_info`。
- v1 迁移增加 `id/parentId`，v2 迁移将 `hookMessage` role 改为 `custom`。
- 解析时跳过空行和损坏 JSON 行；非空但无有效 Session header 的文件不得被静默覆盖。
- JSON 写入使用 UTF-8、`ensure_ascii=False` 和每条一行。

### 5.2 上下文构建

- 默认沿当前 leaf 的 parent 链回溯到 root。
- `leaf_id=None` 表示使用最后一个 entry；显式空 leaf 表示空上下文，Python API 使用独立 sentinel 避免二义性。
- thinking level 与 model 从完整活动分支计算，不受 compaction 裁剪影响。
- 仅 message、custom_message、branch_summary 和 compaction 生成运行时消息。
- 使用活动分支上的最后一个 compaction；输出顺序为 compaction summary、被保留的旧条目、compaction 后条目。
- Web API 同时返回与可渲染消息平行的 `entryIds`。

### 5.3 Agent 事件

内部事件至少包括：

- `agent_start` / `agent_end`
- `turn_start` / `turn_end`
- `message_start` / `message_update` / `message_end`
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `compaction_start` / `compaction_end`
- `auto_retry_start` / `auto_retry_end`

内部使用 snake_case 字段；FastAPI 序列化边界转换为 Web 兼容的 camelCase。SSE 每个事件包含单行 JSON data，并发送心跳。运行完成、失败和 abort 都必须产生终结事件。

### 5.4 ToolCall 规范化

持久化格式以 pi 原生字段 `{id, name, arguments}` 为准。Web DTO 输出 `{toolCallId, toolName, input}`，转换只发生在 API/UI 边界，内核不得同时维护两套字段。

## 6. 核心设计决策

### 6.1 Python 与依赖

- Python 3.11+；本机基线为 Python 3.12。
- 核心数据层仅依赖标准库。
- HTTP/服务使用 FastAPI、Uvicorn、HTTPX。
- Provider 使用官方 `anthropic` 和 `openai` SDK。
- 测试使用 pytest、pytest-asyncio。
- 数据结构优先使用 TypedDict/dataclass；HTTP DTO 再使用 Pydantic，避免核心被 Web 框架绑定。

### 6.2 并发与生命周期

- 每个 Session 同时只允许一个主 prompt run。
- steer 和 follow-up 使用独立 FIFO 队列。
- abort 使用 `asyncio.Event`，并向 Provider stream 与工具子进程传播取消。
- AgentRegistry 以 session ID 为键，创建操作加锁，实例在空闲超时后清理。
- fork 后销毁旧 registry wrapper，避免参考 Web 已记录的 in-place session 变更问题。

### 6.3 文件与命令安全

- 所有相对路径以 session cwd 解析。
- File API 默认只允许访问显式 workspace root 内文件。
- 解析 real path 后再次检查边界，阻止 `..` 和符号链接逃逸。
- bash 在 Windows 使用 PowerShell，在 POSIX 使用用户 shell；命令执行保留 cwd、超时、输出截断和 abort。
- 第一版不把 Web 服务暴露到公网，默认监听 loopback。

## 7. 分阶段实施

### 阶段 0：基线与工程骨架

产出：

- 固定参考提交和差异记录。
- 根 `pyproject.toml`、`src` 包结构、测试目录和基础配置。
- 统一的代码风格、类型检查与测试命令。

验收：`python -m pytest` 能发现测试；在 editable install 后或以 `src` 为
`PYTHONPATH` 时，`python -c "import pi_agent"` 成功。

### 阶段 1：Session v3 数据层

产出：

- Session 类型、parser、v1→v2→v3 migration。
- SessionManager create/open/in-memory、append、branch、tree、label、name。
- compaction-aware context 和 entry ID 映射。
- fork/create-branched-session 与 Session list 元数据。
- 来自真实 pi 文件的最小脱敏 fixtures。

验收：正常、分支、compaction、损坏行、旧版迁移和 Unicode JSONL 测试全部通过；生成文件可被参考 TypeScript SessionManager 打开。

### 阶段 2：工具运行时

产出：

- ToolDefinition、ToolRegistry、参数验证和统一 ToolResult。
- read、write、edit、bash、grep、find、ls。
- 输出大小/行数限制、二进制检测、路径边界、取消和超时。
- 默认工具预设 none/default/full。

验收：每个工具具备成功、参数错误、越界、超时/取消测试；Windows 集成测试通过。

### 阶段 3：Provider 与 Agent 主循环

产出：

- Provider protocol 与规范化流式 delta。
- Anthropic 和 OpenAI-compatible adapters。
- Agent loop、事件订阅、顺序/并行 tool call。
- steer、follow-up、abort、模型与 thinking level 切换。
- fake Provider，用于完全离线集成测试。

验收：用 fake Provider 完成 `prompt → tool call → tool result → final text`；所有生命周期事件顺序可断言；测试不消耗真实 API。

### 阶段 4：上下文管理与资源加载

产出：

- token/context usage 估算。
- 手动和自动 compaction、branch summary。
- rate limit/5xx 的有限重试与退避。
- system prompt、`.agents/skills` 和 prompt templates 加载。
- Session usage/cost 统计。

验收：压缩后仍保留模型、thinking 和必要 tool-result 配对；abort compaction 和 retry 事件完整。

### 阶段 5：FastAPI 服务

产出：

- Application factory 与配置。
- Session CRUD/context/merge API。
- Agent new/command/state 与 SSE。
- Files、Models、Models Config、Skills、本机目录选择的安全替代 API。
- AgentRegistry、断开清理、心跳与错误 DTO。

验收：HTTPX ASGI 集成测试覆盖全部核心路由；SSE 支持多订阅者、刷新重连和断开回收；API schema 可生成。

### 阶段 6：Vue 最小纵向界面

产出：

- Vue 3 + Vite + TypeScript + Pinia + Tailwind 工程。
- AppShell、SessionSidebar、ChatWindow、ChatInput。
- REST client、SSE client 和 `useAgentSession`。
- 新建/加载 Session，纯文本流式消息，abort。

验收：浏览器中能够创建会话、流式接收回复、刷新后恢复 Session；TypeScript 和 lint 通过。

### 阶段 7：Web 完整功能

产出：

- Markdown/GFM、代码高亮、thinking、tool call/result。
- steer/follow-up、模型/thinking/工具预设、图片输入。
- fork、BranchNavigator、compact、Session merge。
- FileExplorer、FileViewer、TabBar、ModelsConfig、SkillsConfig。
- orphan Session、错误和重试状态。

验收：按参考 Web 的功能清单逐项进行交互回归；前后端字段契约测试通过。

### 阶段 8：打磨、发布与文档

产出：

- 深浅主题、拖拽、声音、响应式和可访问性。
- Windows 一键开发启动脚本与生产启动说明。
- Vue 静态构建由 FastAPI 托管。
- 架构说明、学习笔记、配置和安全说明。

验收：全新环境按 README 可启动；离线自动化测试通过；至少一次受控真实 Provider smoke test 通过。

## 8. 测试矩阵

| 层 | 测试类型 | 核心内容 |
|----|----------|----------|
| Session | unit + compatibility | migration、tree、fork、compaction、Unicode、坏文件 |
| Tools | unit + integration | schema、路径、执行、取消、截断、Windows |
| Provider | unit | request 转换、delta 转换、错误归一化 |
| Agent | integration | 多轮工具循环、队列、abort、并发、事件顺序 |
| FastAPI | ASGI integration | REST DTO、SSE、registry、权限边界 |
| Vue | type/lint + component | reducer/composable、事件处理、消息渲染 |
| E2E | browser | 新会话、工具、分支、压缩、刷新恢复 |

真实 Provider 测试默认不在自动测试中运行，必须通过显式环境变量开启，避免意外产生费用。

## 9. 完成定义

一个阶段只有在以下条件同时满足时才算完成：

- 代码与模块边界符合本计划；
- 对应自动测试通过；
- 没有把未验证行为描述为已兼容；
- 新增或改变的协议同步到文档；
- 已知差异记录在兼容性清单中；
- 未依赖参考仓库运行时源码，参考仓库只作为行为和测试基线。

## 10. 当前执行入口

从阶段 0 和阶段 1 开始，先完成可独立验证的 Session v3 垂直切片：

1. 初始化 Python 工程和包结构；
2. 建立 Session 类型与 JSONL parser；
3. 实现 migration、活动分支和 compaction-aware context；
4. 实现最小 SessionManager；
5. 添加离线 pytest；
6. 再进入工具系统，避免在数据契约未稳定时同时铺开后端和前端。
