/**
 * Node 后端的基础运行配置。
 *
 * 中文说明：只负责服务基础设施参数（监听地址、端口、Pi 数据目录、工作区父目录），
 * 全部通过环境变量读取并带有默认值。
 *
 * 注意：模型凭据（API Key 等）不在这里读取——它们由原版 Pi 的 auth.json /
 * models.json 管理，本服务只是直接读取这些文件（见 model-config-service.ts）。
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** trace 存储后端：sqlite（默认）或 memory（测试/无盘环境）。 */
export type StoreMode = 'sqlite' | 'memory';

// server 包根目录（源码 src/ 与构建产物 dist/ 下的 config 模块都只深一层），
// web 构建产物位于仓库根 web/dist，即 server 包的上一层再上一层。
const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultWebDistDir = join(serverRoot, '..', '..', 'web', 'dist');

/**
 * 可观测性（trace）配置。
 *
 * 中文说明：全部走环境变量，默认**开启**且落在本项目私有目录（`~/.pi/agent-node-server/`），
 * 不占用 pi 的命名空间。`PI_NODE_TRACE=0` 时整体关闭（写操作变成空实现），
 * 行为与引入可观测性之前完全一致。
 */
export interface TraceConfig {
  enabled: boolean; // PI_NODE_TRACE（默认 1）
  mode: StoreMode; // PI_NODE_STORE（默认 sqlite）
  dbPath: string; // PI_NODE_TRACE_DB（默认 <dataDir>/platform.db）
  content: boolean; // PI_NODE_TRACE_CONTENT（默认 0：只存 digest 与预览）
  flushMs: number; // PI_NODE_TRACE_FLUSH_MS（默认 250）
  batchSize: number; // PI_NODE_TRACE_BATCH（默认 200）
  maxPending: number; // PI_NODE_TRACE_MAX_PENDING（默认 5000）
}

/** 服务运行配置的完整结构。 */
export interface ServerConfig {
  host: string; // 监听地址（默认仅本机 127.0.0.1）
  port: number; // 监听端口（默认 8001，与 Python 后端一致）
  agentDir: string; // Pi 的 agent 数据目录，内含 auth.json / models.json / sessions/
  dataDir: string; // 本项目私有数据目录（默认 ~/.pi/agent-node-server，不污染 pi 命名空间）
  workspaceParent: string; // 默认工作区父目录：未选择工作区时，在此目录下按日期创建
  logLevel: LogLevel; // 日志级别（默认 info；warn 起会屏蔽请求日志）
  webDistDir: string; // 前端构建产物目录（默认 ../../web/dist；不存在则仅提供 API）
  accessPassword: string; // 访问密码（默认空=不启用密码锁；设置后 /api 需登录令牌）
  trace: TraceConfig; // 可观测性（trace）配置
}

/** 读取布尔型环境变量（1/true/yes/on 为真，0/false/no/off 为假）。 */
function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const text = env[key];
  if (text === undefined || text === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(text.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(text.toLowerCase())) return false;
  throw new Error(`${key} must be a boolean (1/0, true/false, yes/no, on/off)`);
}

/** 读取正整数型环境变量（带范围校验）。 */
function readInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const text = env[key];
  if (text === undefined || text === '') return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/**
 * 从环境变量读取配置并做基础校验；任何一项都有默认值。
 * 默认参数 `env = process.env` 便于单元测试直接传入自定义环境变量对象。
 */
export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const portText = env.PI_NODE_SERVER_PORT ?? '8001';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PI_NODE_SERVER_PORT must be an integer from 1 to 65535');
  }
  const logLevelText = env.PI_NODE_LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.includes(logLevelText as LogLevel)) {
    throw new Error(`PI_NODE_LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`);
  }
  const storeText = env.PI_NODE_STORE ?? 'sqlite';
  if (storeText !== 'sqlite' && storeText !== 'memory') {
    throw new Error('PI_NODE_STORE must be one of: sqlite, memory');
  }
  const agentDir = env.PI_NODE_AGENT_DIR ?? `${homedir()}/.pi/agent`;
  // 本项目私有目录：与 pi 的 ~/.pi/agent 同级但不同名，避免占用 pi 命名空间。
  const dataDir = env.PI_NODE_DATA_DIR ?? join(dirname(agentDir), 'agent-node-server');
  return {
    host: env.PI_NODE_SERVER_HOST ?? '127.0.0.1',
    port,
    agentDir,
    dataDir,
    workspaceParent: env.PI_NODE_WORKSPACE_PARENT ?? homedir(),
    logLevel: logLevelText as LogLevel,
    webDistDir: env.PI_NODE_WEB_DIST_DIR ?? defaultWebDistDir,
    accessPassword: env.PI_NODE_ACCESS_PASSWORD ?? '',
    trace: {
      enabled: readBoolean(env, 'PI_NODE_TRACE', true),
      mode: storeText,
      dbPath: env.PI_NODE_TRACE_DB ?? join(dataDir, 'platform.db'),
      content: readBoolean(env, 'PI_NODE_TRACE_CONTENT', false),
      flushMs: readInteger(env, 'PI_NODE_TRACE_FLUSH_MS', 250, 10, 60_000),
      batchSize: readInteger(env, 'PI_NODE_TRACE_BATCH', 200, 1, 5000),
      maxPending: readInteger(env, 'PI_NODE_TRACE_MAX_PENDING', 5000, 100, 1_000_000),
    },
  };
}
