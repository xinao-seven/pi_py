/**
 * Node 后端的基础运行配置。
 *
 * 中文说明：只负责服务基础设施参数（监听地址、端口、Pi 数据目录、工作区父目录），
 * 全部通过环境变量读取并带有默认值。
 *
 * 注意：模型凭据（API Key 等）不在这里读取——它们由原版 Pi 的 auth.json /
 * models.json 管理，本服务只是直接读取这些文件（见 model-config-service.ts）。
 */

import { homedir } from "node:os";

/** 服务运行配置的完整结构。 */
export interface ServerConfig {
  host: string;            // 监听地址（默认仅本机 127.0.0.1）
  port: number;            // 监听端口（默认 8001，与 Python 后端一致）
  agentDir: string;        // Pi 的 agent 数据目录，内含 auth.json / models.json / sessions/
  workspaceParent: string; // 默认工作区父目录：未选择工作区时，在此目录下按日期创建
}

/**
 * 从环境变量读取配置并做基础校验；任何一项都有默认值。
 * 默认参数 `env = process.env` 便于单元测试直接传入自定义环境变量对象。
 */
export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const portText = env.PI_NODE_SERVER_PORT ?? "8001";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PI_NODE_SERVER_PORT must be an integer from 1 to 65535");
  }
  return {
    host: env.PI_NODE_SERVER_HOST ?? "127.0.0.1",
    port,
    agentDir: env.PI_NODE_AGENT_DIR ?? `${homedir()}/.pi/agent`,
    workspaceParent: env.PI_NODE_WORKSPACE_PARENT ?? homedir(),
  };
}
