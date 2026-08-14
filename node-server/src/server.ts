/**
 * Node 后端入口文件（进程启动点）。
 *
 * 中文说明：单独监听 8001 端口，便于现有 Vue 通过 VITE_BACKEND_URL 在
 * Python 后端与 Node 后端之间无缝切换。
 *
 * Fastify 相关：本文件只负责"读取配置 → 创建应用 → 启动监听"。真正的路由、
 * 插件、错误处理都在 app.ts 的 createApp() 里装配。这样设计的好处是：
 * 测试代码可以直接构造 app 并用 Fastify 的 app.inject() 发起假请求，
 * 不依赖真实端口，也不需要真的启动服务器。
 */

import { createApp } from "./app.js";
import { readServerConfig } from "./config.js";

const config = readServerConfig();
const app = createApp({ agentDir: config.agentDir, workspaceParent: config.workspaceParent });

try {
  // app.listen({ host, port }) 会真正绑定端口并开始接收 HTTP 请求。
  // 由于 package.json 里 "type": "module"，本文件是 ESM，可以使用顶层 await
  // 直接等待监听建立完成（等价于传统 CommonJS 里 .then() 的写法）。
  await app.listen(config);
} catch (error) {
  // Fastify 实例创建时 logger 被关闭（见 app.ts 的 Fastify({ logger: false })），
  // 但启动失败必须让开发启动器（npm run dev / 前端集成）能看到具体原因。
  console.error("Node Pi backend failed to start:", error);
  process.exit(1);
}
