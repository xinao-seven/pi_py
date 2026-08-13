# Node Pi Server

使用 Fastify 和原版 `@earendil-works/pi-coding-agent` SDK 的实际运行后端。

该服务将逐步实现与现有 FastAPI 服务一致的 `/api` REST 与 SSE 协议；Vue 前端可通过
`VITE_BACKEND_URL=http://127.0.0.1:8001` 切换至该服务。

```powershell
cd node-server
npm install
npm run dev
```
