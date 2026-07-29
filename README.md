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

可通过 `PI_SERVER_SESSIONS_DIR`、`PI_SERVER_CORS_ORIGINS`、
`PI_SERVER_IDLE_TIMEOUT` 和 `PI_SERVER_SSE_HEARTBEAT` 调整服务配置。
