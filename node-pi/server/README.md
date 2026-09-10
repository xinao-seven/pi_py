# Node Pi Server

使用 Fastify 和原版 `@earendil-works/pi-coding-agent` SDK 的实际运行后端。

该服务将逐步实现与现有 FastAPI 服务一致的 `/api` REST 与 SSE 协议；Vue 前端可通过
`VITE_BACKEND_URL=http://127.0.0.1:8001` 切换至该服务。

```powershell
cd node-pi/server
npm install
npm run dev
```

本项目的工具审批、Plan 模式与 MCP 工具以**内联扩展**注入每个 Pi Session（闭包直连服务单例），
由 `OriginalPiSessionFactory.loader()` 的 `extensionFactories` 注册；用户级/工作区级文件扩展仍由
SDK 自动发现。接入说明见 [`docs/node-extension-system.md`](../../docs/node-extension-system.md)。

日志输出到 stdout，采用人类可读（pino-pretty）格式，包含请求、错误与启动日志；
级别用环境变量 `PI_NODE_LOG_LEVEL` 控制（`trace|debug|info|warn|error|fatal`，默认 `info`；
`warn` 及以上会屏蔽请求日志）。

本服务还会托管前端构建产物（默认 `../../web/dist`，即 `web/dist`），访问
`http://127.0.0.1:8001/` 即可打开同源界面，非 `/api` 的 GET 会回退到 `index.html`（SPA）；
该目录不存在时仅提供 API。目录可用 `PI_NODE_WEB_DIST_DIR` 覆盖。要开放给局域网其他设备，
启动时设置 `PI_NODE_SERVER_HOST=0.0.0.0` 并放行防火墙端口即可。

**访问密码锁**：设置 `PI_NODE_ACCESS_PASSWORD=<密码>` 后，`/api` 除登录/状态/健康检查外
都需要先登录。前端会弹出密码输入框；登录令牌持久化到 localStorage（刷新保持登录），
可直接构造 URL 访问 API 会被服务端 401 拒绝。未设置该变量则不启用，本地开发不受影响。

**用量与可观测性（M1）**：默认开启，把每次运行的成本、延迟、工具成功率与审批命中率写入
`~/.pi/agent-node-server/platform.db`（不碰 `~/.pi/agent`），由前端「设置 → 用量」展示，
查询接口在 `/api/observability/*`。默认不落对话正文、不落密钥。相关变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_NODE_TRACE` | `1` | `0` 关闭（写操作变空实现，接口返回空集） |
| `PI_NODE_STORE` | `sqlite` | `memory` 时整体走内存实现 |
| `PI_NODE_TRACE_DB` | `<PI_NODE_DATA_DIR>/platform.db` | 库文件路径 |
| `PI_NODE_TRACE_CONTENT` | `0` | `1` 时额外保留已脱敏正文 |
| `PI_NODE_TRACE_FLUSH_MS` / `_BATCH` / `_MAX_PENDING` | `250` / `200` / `5000` | 写入队列参数 |

完整口径与取舍见 [`docs/node-observability-m1.md`](../../docs/node-observability-m1.md)。
