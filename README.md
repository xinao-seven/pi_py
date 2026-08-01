# pi-agent-python

使用 Python、FastAPI 和 Vue 3 学习性复刻 pi coding agent 与 Pi-Agent-Web。

项目采用与 pi 对应的 `pi_ai → pi_agent → pi_coding_agent` 三层包结构。架构说明见
[`docs/three-layer-architecture.md`](docs/three-layer-architecture.md)，完整路线见
[`docs/implementation-plan.md`](docs/implementation-plan.md)。

## 开发检查

```powershell
$env:PYTHONPATH = "src"
python -c "import pi_agent"
python -m pytest
```

## 启动后端

安装开发依赖：

```powershell
python -m pip install -e ".[dev]"
```

首次配置 Provider Key 时，把仓库中的示例复制到用户级配置目录：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.pi\agent"
Copy-Item .\secrets.env.example "$env:USERPROFILE\.pi\agent\secrets.env"
notepad "$env:USERPROFILE\.pi\agent\secrets.env"
```

在 `%USERPROFILE%\.pi\agent\secrets.env` 中填写实际使用的 Key：

```dotenv
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=sk-...
# CUSTOM_API_KEY=真实密钥
```

该文件位于仓库外，并被 Files API 视为敏感文件。`models.json` 和模型配置 API 仍然只保存
`$ANTHROPIC_API_KEY`、`$OPENAI_API_KEY` 之类的变量引用，不会返回真实 Key。修改密钥文件后请
重启后端。当前终端里的同名环境变量仍受支持，并且优先于密钥文件。

启动仅监听本机的 FastAPI 服务：

```powershell
python -m uvicorn server.main:app --host 127.0.0.1 --port 8000 --reload
```

健康检查、OpenAPI 和交互文档分别位于：

- `http://127.0.0.1:8000/api/health`
- `http://127.0.0.1:8000/api/openapi.json`
- `http://127.0.0.1:8000/api/docs`

## 启动 Vue 前端

首次安装依赖：

```powershell
cd web
npm install
```

后端运行在 `127.0.0.1:8000` 时，启动 Vite 开发服务器：

```powershell
npm run dev
```

浏览器访问 `http://127.0.0.1:5173`。Vite 会将 `/api` 请求和 SSE 连接代理到 FastAPI。

Windows 下也可以从项目根目录运行一键开发入口：

```powershell
.\scripts\start-dev.ps1
```

聊天顶部的“切换项目”可以在当前/历史项目之间切换，也可以输入新的绝对路径。切换项目会在目标
目录中准备一个新会话，原会话及其 cwd 保持不变。新目录必须位于
`PI_SERVER_WORKSPACE_PARENT` 或已登记工作区之下；需要管理其他盘符或父目录时，请在启动服务前
调整该变量，或先复用已有 Session 登记的工作区根目录。

前端检查：

```powershell
npm run typecheck
npm run lint
npm run test
npm run build
```

## 本地生产模式

生产入口会先构建 Vue，再由 FastAPI 同源托管静态文件和 `/api`，只需要访问一个端口：

```powershell
.\scripts\start-production.ps1
```

随后打开 `http://127.0.0.1:8000`。已经构建过前端时可使用：

```powershell
.\scripts\start-production.ps1 -SkipBuild
```

也可以双击 `scripts/start-dev.bat` 或 `scripts/start-production.bat`。服务默认只监听
`127.0.0.1`，不会直接暴露到局域网。

可通过 `PI_SERVER_SESSIONS_DIR`、`PI_SERVER_CORS_ORIGINS`、
`PI_SERVER_AGENT_DIR`、`PI_SERVER_WORKSPACE_PARENT`、`PI_SERVER_IDLE_TIMEOUT`
和 `PI_SERVER_SSE_HEARTBEAT` 调整服务配置。密钥文件默认跟随 `PI_SERVER_AGENT_DIR`，也可在
启动前通过 `PI_SERVER_SECRETS_FILE` 指向仓库外的其他位置。
设置 `PI_SERVER_WEB_DIST` 可指定静态前端目录；显式设为空字符串可禁用静态托管。

当前后端已经提供：

- `/api/sessions`：会话列表、详情、上下文、重命名、删除和 merge
- `/api/agent`：Agent 创建、状态、命令和 SSE 事件流
- `/api/files`：限定在 Session 工作区内的目录浏览、文件预览和变化监听
- `/api/models`、`/api/models-config`：模型目录与 Provider 配置
- `/api/skills`：本地 Skills 列表与启停
- `/api/workspaces`、`/api/default-cwd`：受控工作目录登记与创建

`models.json` 中的 `apiKey` 必须写成环境变量引用，例如：

```json
{
  "providers": {
    "openai": {
      "api": "openai-completions",
      "apiKey": "$OPENAI_API_KEY",
      "models": [{"id": "your-model-id"}]
    }
  }
}
```

### 一键配置 DeepSeek

打开 Web 端“模型配置”，点击“**一键配置 DeepSeek V4**”并保存，即可自动写入：

- Provider：`deepseek`
- Base URL：`https://api.deepseek.com`
- Key 引用：`$DEEPSEEK_API_KEY`
- 模型：`deepseek-v4-flash`、`deepseek-v4-pro`
- 上下文窗口：1,000,000 tokens

随后只需在 `%USERPROFILE%\.pi\agent\secrets.env` 中填写
`DEEPSEEK_API_KEY=你的真实Key` 并重启后端。项目使用 DeepSeek Chat Completions 流式接口，支持
文本、思考内容和 Agent 工具调用；界面中的 thinking level 会映射到 DeepSeek V4 的思考开关与
`reasoning_effort`。

不要把 `.env`、`secrets.env`、API Key 或凭据文件放入 Session 工作区供 Agent 读取。Files API
会阻止常见敏感文件、密钥后缀和工作区外路径；模型配置界面同样只保存 `$ENV_VAR` 引用。

## 真实 Provider smoke test

配置并重启服务后，可以显式执行一次低成本真实请求。以 Anthropic 为例：

```powershell
$env:PI_SMOKE_PROVIDER = "anthropic"
$env:PI_SMOKE_MODEL = "claude-sonnet-4-6"
.\scripts\test-provider.ps1
```

OpenAI 或自定义 Provider 时，替换 `PI_SMOKE_PROVIDER` 和 `PI_SMOKE_MODEL`，并确保 `models.json`
中的 `apiKey` 引用了密钥文件中的变量名。脚本会显示
Provider 和模型、但绝不会打印 Key；它会产生一次真实 API 调用，可能产生少量费用。
