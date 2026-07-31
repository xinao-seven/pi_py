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

配置 Provider，例如 Anthropic：

```powershell
$env:ANTHROPIC_API_KEY = "your-api-key"
```

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

前端检查：

```powershell
npm run typecheck
npm run lint
npm run test
npm run build
```

可通过 `PI_SERVER_SESSIONS_DIR`、`PI_SERVER_CORS_ORIGINS`、
`PI_SERVER_AGENT_DIR`、`PI_SERVER_WORKSPACE_PARENT`、`PI_SERVER_IDLE_TIMEOUT`
和 `PI_SERVER_SSE_HEARTBEAT` 调整服务配置。

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
