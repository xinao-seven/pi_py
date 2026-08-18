# pi_py 仓库总览

一个「两套 pi 实现 + 一个共享 Vue 前端」的仓库：一套用**原版 pi SDK**（Node，生产），
一套用 **Python 复刻的内核**（学习/参考），共用同一个 `/api` REST + SSE 协议和 `web/` 前端。

## 目录结构

```
pi_py/
├── web/                    # Vue 3 前端（两后端共用，VITE_BACKEND_URL 切换后端）
├── node-pi/               # 【Node 版·生产】原版 pi 能力
│   ├── server/           # Fastify + @earendil-works/pi-coding-agent 后端（端口 8001）
│   ├── extensions/       # ★ 扩展目录：放进 .ts/.js 扩展即被后端自动加载
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

`node-pi/extensions/` 是给 Node 版后端添加工具/钩子的地方。放一个 `.ts` 文件
（default export `ExtensionFactory`，用 `pi.registerTool()` / `pi.on(...)`），后端启动时自动扫描加载。

- 本目录的扩展只在本仓库加载；原版 pi（TUI）的 `~/.pi/agent/extensions/` 与项目
  `.pi/extensions/` 不会被本后端加载，两边隔离。
- 示例与格式说明见 [`node-pi/extensions/README.md`](node-pi/extensions/README.md)。

## 测试

```powershell
# Node 版
cd node-pi/server && npm run typecheck && npm test

# Python 版
cd pi-python && python -m pytest
```

## 文档

| 文档 | 内容 |
|------|------|
| [`pi-python/README.md`](pi-python/README.md) | Python 版项目文档（配置、API、安全） |
| [`docs/three-layer-architecture.md`](docs/three-layer-architecture.md) | Python 三层包结构与依赖规则 |
| [`docs/node-pi-backend.md`](docs/node-pi-backend.md) | Node 版后端说明 |
| [`docs/development-standards.md`](docs/development-standards.md) | 开发与提交规范 |
