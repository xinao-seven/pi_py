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

import { createApp } from './app.js';
import { readServerConfig } from './config.js';

const config = readServerConfig();
// 启用 Fastify 内置 Pino 日志器：输出人类可读（pino-pretty）格式，级别由 PI_NODE_LOG_LEVEL 控制。
const app = createApp({
  agentDir: config.agentDir,
  workspaceParent: config.workspaceParent,
  logger: {
    level: config.logLevel,
    transport: {
      target: 'pino-pretty',
      options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
    },
  },
});

try {
  // app.listen({ host, port }) 会真正绑定端口并开始接收 HTTP 请求。
  // 由于 package.json 里 "type": "module"，本文件是 ESM，可以使用顶层 await
  // 直接等待监听建立完成（等价于传统 CommonJS 里 .then() 的写法）。
  await app.listen(config);
  app.log.info({ host: config.host, port: config.port }, 'Node Pi backend listening');
} catch (error) {
  // 启动失败必须让开发启动器（npm run dev / 前端集成）能看到具体原因。
  // logger 在 app 创建时已启用，直接通过 app.log 输出；保留 console.error 兜底，
  // 避免 logger 本身初始化失败时没有任何输出。
  app.log.error({ err: error }, 'Node Pi backend failed to start');
  console.error(error);
  process.exit(1);
}
