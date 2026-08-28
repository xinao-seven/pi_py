# CLAUDE.md

本文件为 Claude Code 在本仓库工作时的行为指南。

## 项目概览

「两套 pi 实现 + 一个共享 Vue 前端」的仓库：

- **`node-pi/server`（生产）**：Fastify + 原版 `@earendil-works/pi-coding-agent` SDK，监听 `8001`。
- **`pi-python`（复刻/学习）**：Python + FastAPI 三层内核复刻（`pi_ai → pi_agent → pi_coding_agent`），监听 `8000`。
- **`web`（共享前端）**：Vue 3 + Vite + Pinia + Tailwind，通过 `VITE_BACKEND_URL` 切换后端（默认 `8000`，Node 版为 `8001`）。

**核心约束**：两个后端必须对共享 Vue 前端维持**同一套 `/api` REST + SSE + 错误契约**。改动任何路径、响应、SSE 载荷或状态字段前，须同时检查 `web/src/lib/api.ts`、`web/src/lib/agent-events.ts`、Pinia store 与另一个后端实现。

`pi-python` 是对原版内核的学习性复刻，没有明确的读取限制，可作为行为对照参考；生产运行走 `node-pi`。

## 目录结构

```
pi_py/
├── web/                    # Vue 3 前端（共用，VITE_BACKEND_URL 切换后端）
│   └── src/
│       ├── lib/api.ts      # 全部 REST 封装（统一解析 ApiError）
│       ├── lib/agent-events.ts  # SSE 事件 → 流式状态规约（reduceAgentEvent）
│       ├── stores/         # Pinia（app.ts / auth.ts）
│       ├── types/index.ts  # 前端数据类型（与后端 JSON 一一对应）
│       └── components/     # 三栏 IDE：会话侧栏/聊天/文件面板等
├── node-pi/
│   ├── server/             # Node 生产后端（Fastify，8001）
│   │   ├── src/
│   │   │   ├── app.ts      # 应用装配、依赖注入、生命周期、全局错误处理
│   │   │   ├── server.ts   # 进程入口（仅读取配置 + 监听）
│   │   │   ├── config.ts   # 环境变量基础设施配置（PI_NODE_*）
│   │   │   ├── errors.ts   # 统一 API 错误
│   │   │   ├── routes/     # HTTP/SSE 适配层（薄）：agent/auth/files/mcp/models/presets/sessions/skills/workspaces
│   │   │   └── services/   # 业务逻辑 + Pi SDK 适配：agent-registry/tool-approval/plan-mode-service/mcp/...
│   │   ├── extensions/     # ★ 后端专属扩展（每个 .ts 文件一个，自动扫描加载）
│   │   └── test/           # Vitest（映射 src/ 结构）
│   └── utools/             # uTools 桌面插件（拉起 node-pi/server + 加载 web 构建）
├── pi-python/              # Python 复刻（学习参考）
│   ├── src/pi_ai/          # 底层：模型原子类型、Provider（anthropic/openai/deepseek/fake）
│   ├── src/pi_agent/       # 中层：通用 Agent loop、事件、工具抽象
│   ├── src/pi_coding_agent/# 顶层：Session v3、Coding Agent 组装、工具实现
│   ├── server/             # FastAPI 应用层：routes（薄）→ services → errors
│   └── tests/              # unit / integration / compat
├── scripts/                # 启动/运维脚本（.ps1 / .bat / .py）
├── docs/                   # 架构与实施文档（中文）
└── tests/                  # 旧的 Python 测试目录（遗留；实际 pytest 在 pi-python 下运行）
```

## 常用命令

```powershell
# Node 后端（生产）
cd node-pi/server
npm install
npm run dev               # http://127.0.0.1:8001
npm run typecheck && npm test && npm run build

# Python 后端（复刻）
cd pi-python
python -m pip install -e ".[dev]"
python -m uvicorn server.main:app --host 127.0.0.1 --port 8000 --reload
python -m pytest

# 前端
cd web
npm install
npm run dev               # http://127.0.0.1:5173（/api 代理到 VITE_BACKEND_URL）
npm run typecheck && npm run lint && npm run test && npm run build
```

一键脚本（仓库根）：`scripts/start-node-dev.ps1`（Node 后端 + 前端）、`scripts/start-dev.ps1`（Python 后端）、`scripts/start-production.ps1`（构建前端后同源托管）。

## 架构与设计原则

### Node 后端（node-pi/server）

- 依赖方向固定：`routes → services → Pi SDK / Node 标准库`。`app.ts` 只负责组装和依赖注入，`server.ts` 只负责启动。
- 路由不得直接创建 Pi Session、读写持久化配置或承载长生命周期状态。
- `AgentRegistry`（`services/agent-registry.ts`）是核心：每个会话一个活跃 `AgentSession`，内存缓存 SSE 事件（每会话最多 256 条）支持 `Last-Event-ID` 回放，命令走统一的 `command()` 分发。
- 会话命令类型（`POST /api/agent/:sessionId` body.type）：`prompt` / `steer` / `follow_up` / `abort` / `set_model` / `set_thinking_level` / `set_tools` / `compact` / `navigate_tree` / `reload_resources` / `approve_tool` / `plan_enable|disable|execute|refine`。
- 新能力落点：新 API → 新增 `routes/<resource>.ts` + 对应 service，在 `app.ts` 显式注册；新会话能力 → `AgentRegistry`；新工具/事件钩子 → `extensions/`（不要为加载单个扩展改 `app.ts`）。

### Python 三层内核（pi-python/src）

依赖方向是**硬性约束**（由 `pi-python/tests/unit/test_architecture.py` 校验）：

- `pi_ai` 不得导入 `pi_agent` / `pi_coding_agent`
- `pi_agent` 可以导入 `pi_ai`，不得导入 `pi_coding_agent`
- `pi_coding_agent` 可导入两者；FastAPI 与 Vue 位于其上层
- 禁止在 `server/routes/` 堆业务逻辑；服务类放 `server/services/`，路由用 `Depends(request.app.state.xxx)` 取服务。

### SSE 与错误契约

- 长任务以 `202` 接收，结果经 SSE 推送；不阻塞 HTTP 等模型完成。SSE 保持 `Last-Event-ID` 回放、断开清理和 15 秒心跳，hijack 响应须显式补 CORS 头。
- 错误响应固定为 `{ error: { code, message, details? } }`，机器码用 snake_case。校验失败抛 `422 validation_error`；不得把堆栈、凭据、绝对敏感路径或 SDK 原始错误返回给浏览器。
- 前端 `EventSource` 无法带 Authorization 头，SSE/media 地址的令牌走查询参数（见 `web/src/lib/api.ts` 的 `appendToken`）。

## 安全规范（重要）

- **`~/.pi/agent` 只读**：`auth.json`（API Key 唯一来源）、`settings.json`、`models.json`、`models-store.json`、`sessions/` 一律只读，绝不创建/改写，避免污染原版 pi。
- **密钥绝不外泄**：任何 API 响应不得包含真实密钥；自身配置只保存 `$ENV_VAR` 引用，按 `auth.json` 的 key 名映射解析（`$DEEPSEEK_API_KEY → auth.json["deepseek"].key`）。
- Node 后端写 `~/.pi/agent/node-server-workspaces.json`（工作区登记）；Python 后端写 `~/.pi/agent-python/`（models.json / workspaces.json）。测试必须隔离 `agentDir` 到临时目录，禁止触碰真实 `~/.pi` 或网络。
- **危险命令人工确认**：`bash` 命中危险规则（递归删除、格式化、关机、强制 Git 推送等）时挂起执行，向 SSE 推 `tool_call_pending`，前端弹窗，由 `approve_tool` 命令允许/拒绝。拒绝或超时（Node 30 秒 / Python 60 秒）按拒绝处理。`ToolApprovalBroker`（Node）/ `ToolApprovalGate`（Python）是唯一真相源。
- 文件访问必须确认工作区已登记，保持路径边界与敏感文件拦截（`.env`、凭据、密钥后缀）。

## 扩展系统（内联扩展）

- 仓库内的工具审批、Plan 模式与 MCP 工具都是**内联扩展**：各服务类（`ToolApprovalBroker` / `PlanModeService` / `buildMcpExtension`）提供 `buildExtension(): InlineExtension`，由 `OriginalPiSessionFactory.loader()` 的 `extensionFactories` 注入每个会话（闭包直连服务单例，无事件总线桥接）。
- 按预设开关动态启用/关闭：`CreateSessionInput.extensions.{approval,planMode}`，默认开启；`loader()` 里按 `plan → approval → mcp` 顺序注册（规划期先拦，避免先弹审批框）。
- 用户级 `~/.pi/agent/extensions/` 与工作区 `.pi/extensions/` 的文件扩展仍由 SDK 自动发现（jiti 隔离，协作需走 `pi.events`）；仓库不再随服务发布文件扩展。

## 代码规范

- **注释**：默认不写注释；需要时用中文解释「为什么」，不用中文复述代码「是什么」。Node 公开类/关键方法保留「英文 docstring + 中文说明」双语风格；Python 文件头英文 docstring + 一行 `中文说明：...`。
- **TypeScript**：ESM + NodeNext，相对 import 带 `.js` 后缀，类型用 `import type`，`strict`，避免无理由的 `any`。前端组件统一 `<script setup lang="ts">` + 组合式 API。
- **Python**：`from __future__ import annotations` + 完整类型注解，优先 `dataclass`（只读加 `frozen=True, slots=True`）。业务错误抛 `server.errors.APIError(status, code, message)`。
- **提交**：Conventional Commits（`feat|fix|docs|refactor|test|chore`），描述用中文，一个提交只做一件事，代码与文档分开提交。
- **测试**：改动必须附带测试；行为变更至少覆盖正常路径 + 一个失败/边界路径。Node 用 `app.inject()` + fake session + 临时目录；Python 集成测试注入 `FakeProvider`，绝不访问网络。

## 前端要点

- 类型集中在 `web/src/types/index.ts`；API 调用统一走 `web/src/lib/api.ts`（统一解析为 `ApiError`）；状态用 Pinia，组件间不 props 深传。
- SSE 事件 → 流式状态：`web/src/lib/agent-events.ts` 的 `reduceAgentEvent` 是纯函数规约，新增事件类型时同步更新。
- 关键组件：`ChatWindow.vue`（会话/流式）、`SessionSidebar.vue`、`ToolApprovalDialog.vue`（危险命令确认）、`ModelsConfig.vue`、`McpConfig.vue`、`PresetConfig.vue`、`SkillsConfig.vue`、`PlanProgress.vue`。
- 主题/声音偏好存 localStorage（`pi.theme` / `pi.sound`），写入 `<html data-theme>`。

## 关键文档

| 文档 | 内容 |
|------|------|
| `README.md` | 仓库总览与快速开始（唯一入口） |
| `docs/development-standards.md` | Python 项目开发规范 |
| `node-pi/server/DEVELOPMENT.md` | Node 后端开发规范 |
| `docs/node-pi-backend.md` | Node 后端功能清单 |
| `docs/three-layer-architecture.md` | Python 三层包结构与依赖规则 |
| `docs/node-extension-system.md` | 扩展发现与接入 |
| `docs/node-command-approval.md` | 命令风险分级与审批链路 |
| `docs/node-web-plan-mode.md` | Web Plan 模式接口契约 |
| `docs/node-mcp-guide.md` / `node-mcp-support.md` / `node-mcp-implementation.md` | MCP 支持 |

行为变化须同步更新 README 与对应 docs 文档。
