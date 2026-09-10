# pi_py 仓库总览

一个「两套 pi 实现 + 一个共享 Vue 前端」的仓库：一套用**原版 pi SDK**（Node，生产），
一套用 **Python 复刻的内核**（学习/参考），共用同一个 `/api` REST + SSE 协议和 `web/` 前端。

## 目录结构

```
pi_py/
├── web/                    # Vue 3 前端（两后端共用，VITE_BACKEND_URL 切换后端）
├── node-pi/               # 【Node 版·生产】原版 pi 能力
│   ├── server/           # Fastify + @earendil-works/pi-coding-agent 后端（端口 8001）
│   │   └── extensions/   # ★ 扩展目录：放进 .ts/.js 扩展即被后端自动加载
│   └── utools/           # uTools 桌面插件（拉起 node-pi/server + 加载 web 构建）
├── pi-python/            # 【Python 版·复刻】三层内核 + FastAPI 后端
│   ├── src/             # pi_ai → pi_agent → pi_coding_agent 三层内核
│   ├── server/          # FastAPI 后端（端口 8000）
│   ├── tests/           # unit（内核）/ integration（后端）/ compat（JSONL 兼容）
│   └── pyproject.toml   # Python 项目配置（README 见该目录）
├── scripts/               # 启动/运维脚本（dev、production、smoke）
└── docs/                  # 架构与实施文档
```

## 两个后端怎么选

| | Node 版（生产） | Python 版（复刻） |
|---|---|---|
| 目录 | `node-pi/server` | `pi-python/server` |
| 实现 | 原版 `@earendil-works/pi-coding-agent` SDK | 自研三层内核 + FastAPI |
| 端口 | 8001 | 8000 |
| 前端切换 | `VITE_BACKEND_URL=http://127.0.0.1:8001` | `VITE_BACKEND_URL=http://127.0.0.1:8000`（默认） |
| 用途 | 实际运行 | 学习复刻、兼容验证 |

两个后端都复用原版 pi 的 `~/.pi/agent`（auth.json / models.json / sessions），只读不污染。

## 快速开始

### Node 版（生产）

```powershell
cd node-pi/server
npm install
npm run dev          # 后端 http://127.0.0.1:8001

cd ../../web         # 另开终端，起前端
npm install
npm run dev          # http://127.0.0.1:5173
```

或一键脚本（拉起后端 + 前端，自动等待健康检查）：

```powershell
.\scripts\start-node-dev.ps1
```

### Python 版（复刻）

```powershell
cd pi-python
python -m pip install -e ".[dev]"
python -m uvicorn server.main:app --host 127.0.0.1 --port 8000
```

```powershell
# 另开终端，起前端
cd web
npm install
npm run dev
```

或一键脚本：`.\scripts\start-dev.ps1`（开发）/ `.\scripts\start-production.ps1`（构建前端后同源托管）。

Python 版详细说明见 [`pi-python/README.md`](pi-python/README.md)。

## 扩展（给 Node 版加能力）

Node 版后端把工具审批、Plan 模式与 MCP 工具以**内联扩展**注入每个会话（闭包直连服务单例），
注册点集中在 `OriginalPiSessionFactory.loader()` 的 `extensionFactories`，并支持按预设开关
（`extensions.approval` / `extensions.planMode`）启用/关闭；MCP 服务还可按预设选择白名单
（预设的 `mcpServers` 字段：null = 全部，[] = 禁用，非空数组 = 服务名白名单）。

- 原版 pi（TUI）的 `~/.pi/agent/extensions/` 与项目 `.pi/extensions/` 仍由 SDK 自动发现；
  仓库不再随服务发布 jiti 文件扩展。
- 机制说明见 [`docs/node-extension-system.md`](docs/node-extension-system.md)。

## 测试

```powershell
# Node 版
cd node-pi/server && npm run typecheck && npm test

# Python 版
cd pi-python && python -m pytest
```

CI 见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)，三个 job：`node-backend`（format → typecheck → test → build → spike）、
`web`（typecheck → lint → test → build）、`eval`（离线 golden set，M4 接线后自动生效）。

`npm run spike` 是 **M0 能力守护**，不是探索脚本：它离线验证依赖布局未破坏关键能力
（`fauxProvider` 可解析、`node:sqlite` 可用、父子会话识别、`tool_call` 钩子链与阻断语义）。
详见 [`docs/node-platform-m0-spike.md`](docs/node-platform-m0-spike.md)。

## 文档

| 文档 | 内容 |
|------|------|
| [`pi-python/README.md`](pi-python/README.md) | Python 版项目文档（配置、API、安全） |
| [`docs/three-layer-architecture.md`](docs/three-layer-architecture.md) | Python 三层包结构与依赖规则 |
| [`docs/node-pi-backend.md`](docs/node-pi-backend.md) | Node 版后端说明 |
| [`docs/node-extension-system.md`](docs/node-extension-system.md) | Node 扩展发现与接入 |
| [`docs/node-command-approval.md`](docs/node-command-approval.md) | 命令风险分级与审批事件链路 |
| [`docs/node-web-plan-mode.md`](docs/node-web-plan-mode.md) | Web Plan 模式的 Agent 约束、确认执行与接口契约 |
| [`docs/node-mcp-guide.md`](docs/node-mcp-guide.md) | MCP 支持总结（原理、实现、配置方法与示例） |
| [`docs/node-mcp-support.md`](docs/node-mcp-support.md) | MCP 功能的设计与实现细节 |
| [`docs/node-mcp-implementation.md`](docs/node-mcp-implementation.md) | MCP 实现详解（代码走读） |
| [`docs/node-platform-plan.md`](docs/node-platform-plan.md) | Node 平台化规划（可观测/任务持久化/断点续跑/Plan 重构/Subagent） |
| [`docs/node-platform-m0-spike.md`](docs/node-platform-m0-spike.md) | M0 验证报告：存储选型与 `~/.pi/agent` 只读边界审计 |
| [`docs/node-plan-extension-ownership.md`](docs/node-plan-extension-ownership.md) | Plan 扩展归属决策与 `session_start` 修复 |
| [`docs/development-standards.md`](docs/development-standards.md) | 开发与提交规范 |
