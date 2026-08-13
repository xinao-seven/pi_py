/** Node service configuration.
 *
 * 中文说明：Node/原版 Pi 后端的基础运行配置；仅包含服务基础设施参数，
 * 不通过环境变量读取模型凭据，凭据由原版 Pi 管理。
 */

import { homedir } from "node:os";

export interface ServerConfig {
  host: string;
  port: number;
  agentDir: string;
  workspaceParent: string;
}

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
