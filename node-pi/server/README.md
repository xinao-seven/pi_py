# Node Pi Server

使用 Fastify 和原版 `@earendil-works/pi-coding-agent` SDK 的实际运行后端。

该服务将逐步实现与现有 FastAPI 服务一致的 `/api` REST 与 SSE 协议；Vue 前端可通过
`VITE_BACKEND_URL=http://127.0.0.1:8001` 切换至该服务。

```powershell
cd node-pi/server
npm install
npm run dev
```

本项目的扩展放在 `extensions/`（即 `node-pi/server/extensions/`），服务为每个 Pi Session
创建资源加载器时会自动扫描加载。接入说明见
[`docs/node-extension-system.md`](../../docs/node-extension-system.md)。

日志输出到 stdout，采用人类可读（pino-pretty）格式，包含请求、错误与启动日志；
级别用环境变量 `PI_NODE_LOG_LEVEL` 控制（`trace|debug|info|warn|error|fatal`，默认 `info`；
`warn` 及以上会屏蔽请求日志）。

本服务还会托管前端构建产物（默认 `../../web/dist`，即 `web/dist`），访问
`http://127.0.0.1:8001/` 即可打开同源界面，非 `/api` 的 GET 会回退到 `index.html`（SPA）；
该目录不存在时仅提供 API。目录可用 `PI_NODE_WEB_DIST_DIR` 覆盖。要开放给局域网其他设备，
启动时设置 `PI_NODE_SERVER_HOST=0.0.0.0` 并放行防火墙端口即可。
