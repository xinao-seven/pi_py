# pi-agent-python

使用 **Python + FastAPI + Vue 3** 学习性复刻 pi coding agent 与 Pi-Agent-Web 的全栈 Coding Agent。

项目以 pi 的 `pi_ai → pi_agent → pi_coding_agent` 三层包结构组织，兼容 pi Session v3
JSONL，直接复用原版 pi 在 `~/.pi` 下的配置与会话数据（只读），并提供独立的 Web 配置
空间（`~/.pi/agent-python`），不污染原版 pi 的运行。

## 特性

- **三层架构**：`pi_ai`（Provider/流式协议）→ `pi_agent`（通用 Agent loop）→
  `pi_coding_agent`（Session v3 / 工具 / 资源加载），依赖方向由测试强制约束
- **兼容原版 pi 数据**：读取并继续使用原版 pi 的 Session v3 会话与 `~/.pi/agent` 配置
- **安全密钥**：API Key 只从原版 pi 的 `auth.json` 读取，Web 界面只保存 `$ENV_VAR` 引用
- **受控工作区**：会话级目录浏览/文件访问，支持切换项目目录且登记结果持久化
- **流式 Agent 体验**：SSE 事件流、thinking/工具调用展示、分支导航、会话合并、compaction
- **单端口生产模式**：Vue 构建后由 FastAPI 同源托管，一键脚本启动

## 架构与文档

| 文档 | 内容 |
|------|------|
| [`docs/three-layer-architecture.md`](docs/three-layer-architecture.md) | 三层包结构与依赖规则 |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | 完整实施计划与参考基线 |
| [`docs/implementation-status.md`](docs/implementation-status.md) | 当前实施状态与已知差异 |
| [`docs/development-standards.md`](docs/development-standards.md) | **项目开发规范**（编码/配置/测试/提交） |

## 环境要求

- Python ≥ 3.11
- Node.js ≥ 20（仅前端开发/构建需要）

## 快速开始

### 1. 安装后端依赖

```powershell
python -m pip install -e ".[dev]"
```

### 2. 配置 API Key（复用原版 pi）

pi.py 只读原版 pi 的配置，无需单独配置密钥：

- **API Key**：`%USERPROFILE%\.pi\agent\auth.json`（在 pi 中执行 `/login` 写入，
  或手工编辑）：

```json
// %USERPROFILE%\.pi\agent\auth.json
{
  "deepseek": { "type": "api_key", "key": "sk-..." },
  "anthropic": { "type": "api_key", "key": "sk-ant-..." }
}
```

- **默认模型**：`%USERPROFILE%\.pi\agent\settings.json` 中的
  `defaultProvider` / `defaultModel` / `defaultThinkingLevel` 会被自动采用
- **模型目录**：`models-store.json`（内置缓存）与 `models.json`（用户覆盖）只读合并

> 密钥与 pi 的设置不通过环境变量获取；部署覆盖仅限纯 infra 变量（见下文）。

### 3. 启动后端

```powershell
python -m uvicorn server.main:app --host 127.0.0.1 --port 8000 --reload
```

- 健康检查：`http://127.0.0.1:8000/api/health`
- OpenAPI：`http://127.0.0.1:8000/api/openapi.json`（交互文档 `/api/docs`）

### 4. 启动 Vue 前端

```powershell
cd web
npm install
npm run dev
```

浏览器访问 `http://127.0.0.1:5173`（Vite 将 `/api` 与 SSE 代理到 FastAPI）。

Windows 下也可从项目根目录一键启动开发环境：

```powershell
.\scripts\start-dev.ps1
```

### 5. 本地生产模式

```powershell
.\scripts\start-production.ps1          # 构建前端 + 同源托管，访问 http://127.0.0.1:8000
.\scripts\start-production.ps1 -SkipBuild
```

也可双击 `scripts/start-dev.bat` / `scripts/start-production.bat`。服务默认只监听
`127.0.0.1`。

## 配置说明

### 原版 pi 配置（只读）

| 文件 | 用途 |
|------|------|
| `~/.pi/agent/auth.json` | API Key（唯一密钥来源） |
| `~/.pi/agent/settings.json` | 默认 Provider / 模型 / 思考档位 |
| `~/.pi/agent/models.json` | 用户自定义 Provider（只读合并，绝不改写） |
| `~/.pi/agent/models-store.json` | 内置模型缓存目录（只读合并） |
| `~/.pi/agent/sessions/` | 会话数据（复用原版 pi 的会话） |

### pi.py 自身配置（隔离在 `~/.pi/agent-python/`）

| 文件 | 用途 |
|------|------|
| `models.json` | Web“模型配置”界面写入的模型覆盖（`apiKey` 只允许 `$ENV_VAR` 引用） |
| `workspaces.json` | 手动登记的工作区（重启后仍可复用） |

`$OPENAI_API_KEY` 这类引用按原版 pi 的 `auth.json` 解析
（`$DEEPSEEK_API_KEY` → `auth.json["deepseek"].key`），不需要设置任何环境变量。

### 部署覆盖变量（仅纯 infra）

`PI_SERVER_SESSIONS_DIR`、`PI_SERVER_CORS_ORIGINS`、`PI_SERVER_AGENT_DIR`、
`PI_SERVER_IDLE_TIMEOUT`、`PI_SERVER_SSE_HEARTBEAT`；`PI_SERVER_WEB_DIST` 指定
静态前端目录（显式设为空字符串可禁用静态托管）。密钥与默认模型一律来自
原版 pi 的 `~/.pi/agent`，不走环境变量。

## API 概览

| 端点 | 说明 |
|------|------|
| `/api/sessions` | 会话列表、详情、上下文、重命名、删除、merge、fork |
| `/api/agent` | Agent 创建、统一命令、状态与 SSE 事件流 |
| `/api/files` | 限定在 Session 工作区内的目录浏览、文件预览与变化监听 |
| `/api/models`、`/api/models-config` | 模型目录（只读合并）与 pi.py 自身 Provider 配置 |
| `/api/skills` | 本地 Skills 发现、诊断与启停 |
| `/api/workspaces`、`/api/default-cwd` | 受控工作区登记与默认工作区创建 |

### 一键配置 DeepSeek

打开 Web 端“模型配置”，点击“**一键配置 DeepSeek V4**”并保存，即把预设写入
pi.py 自己的 `~/.pi/agent-python/models.json`（**不会**修改原版 pi 的 `models.json`）：

- Provider：`deepseek`，Base URL：`https://api.deepseek.com`
- Key 引用：`$DEEPSEEK_API_KEY`（真实值来自原版 pi 的 `auth.json`）
- 模型：`deepseek-v4-flash` / `deepseek-v4-pro`，上下文窗口 1,000,000 tokens

项目使用 DeepSeek Chat Completions 流式接口，支持文本、思考内容与 Agent 工具调用；
界面中的 thinking level 映射到 DeepSeek V4 的思考开关与 `reasoning_effort`。

## 安全说明

- 不要把 `.env`、`secrets.env`、API Key 或凭据文件放入 Session 工作区；Files API
  会拦截常见敏感文件、密钥后缀与工作区外路径。
- 模型配置界面只保存 `$ENV_VAR` 引用，任何 API 响应都不包含真实密钥。

## 开发

### 检查命令

```powershell
# 后端（项目根目录）
python -m pytest

# 前端（web/ 目录）
npm run typecheck
npm run lint
npm run test
npm run build
```

开发与提交规范见 [`docs/development-standards.md`](docs/development-standards.md)。

### 真实 Provider smoke test

显式执行一次低成本真实请求（会产生少量费用，且不会打印 Key）：

```powershell
$env:PI_SMOKE_PROVIDER = "anthropic"
$env:PI_SMOKE_MODEL = "claude-sonnet-4-6"
.\scripts\test-provider.ps1
```

OpenAI 或自定义 Provider 时替换 `PI_SMOKE_PROVIDER` / `PI_SMOKE_MODEL`，并确保对应
Provider 的密钥已存在于原版 pi 的 `~/.pi/agent/auth.json`。
