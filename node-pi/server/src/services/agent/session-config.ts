/**
 * 会话预设配置的持久化：把「创建这个会话时用的预设」写进会话 JSONL，重开时读回来。
 *
 * 中文说明：创建会话时的预设不只是工具白名单——**能力开关**（Plan / 审批 / 提问 /
 * 子 agent / 任务 / 观测 / 文件扩展）、系统提示词、压缩策略、MCP 白名单都只存在于
 * 内存里的那个会话对象上。会话一旦离开注册表（服务重启、被 `open()` 重新打开），
 * 恢复路径只能按「全开」重建，于是极简会话会被**悄悄放大**成全量能力
 * （MCP 工具 + 用户文件扩展 + plan/subagent/ask_user），且模型真的能用它们。
 *
 * 这里用 SDK 给扩展准备的机制落盘：`SessionManager.appendCustomEntry(customType, data)`
 * 写一条 `type: "custom"` 条目——SDK 明确说它**不参与 `buildSessionContext()`**，
 * 因此原版 CLI 读到它既不进上下文也不报错（官方 plan-mode 扩展也用同一机制写自己的
 * customType）。三条硬约束：
 * - **只增不改**：只追加一行，不重写文件、不删条目、不动别人的字段；
 * - **读侧防御**：形状不认识就当「没有配置」（回退全开，与改动前行为一致），绝不抛错；
 * - **不碰 CLI 语义**：CLI 照常以自己的方式跑同一个会话文件。
 */

import type { CompactionSettings } from '@earendil-works/pi-coding-agent';

import type { SessionExtensions } from './agent-registry.js';

/**
 * 自定义条目的 customType。
 * 中文说明：带命名空间前缀，避免与官方扩展（如 `plan-mode`）或用户扩展撞名——
 * 撞名的后果是对方可能把自己的数据当成状态解析。
 */
export const SESSION_CONFIG_CUSTOM_TYPE = 'pi-web/session-config';

/**
 * 落盘的那份预设配置（字段语义与 `CreateSessionInput` 一致）。
 * 中文说明：只存**影响会话装配**的字段；provider/modelId/thinkingLevel 由会话文件
 * 自己的 `model_change` / `thinking_level_change` 条目承载，不需要重复存。
 */
export interface PersistedSessionConfig {
  /** 能力开关；缺省 = 全开。 */
  extensions?: SessionExtensions;
  /** 工具白名单；缺省 = 不限制（SDK 自己发现）。空数组 = 无工具。 */
  toolNames?: string[];
  /** 预设系统提示词；缺省/空串 = SDK 默认发现。 */
  systemPrompt?: string;
  /** 预设压缩策略；缺省 = 跟随 settings.json。 */
  compaction?: CompactionSettings;
  /** MCP 服务白名单；缺省 = 全部；空数组 = 禁用。 */
  mcpServers?: string[];
}

/** 能力开关的合法键（与 SessionExtensions 一一对应，解析时用来过滤未知键）。 */
const EXTENSION_KEYS = [
  'approval',
  'planMode',
  'questions',
  'subagents',
  'tasks',
  'observability',
  'fileExtensions',
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从创建输入里挑出要落盘的配置。
 * 中文说明：只写**显式给了**的字段——`toolNames: undefined`（不限制白名单）与
 * `mcpServers: undefined`（全部 server）都不写，读回来同样是 undefined，语义天然一致。
 * 空数组是**有意义的取值**（极简模式禁用 MCP），必须原样落盘。
 */
export function sessionConfigOf(input: {
  extensions?: SessionExtensions;
  toolNames?: string[];
  systemPrompt?: string;
  compaction?: CompactionSettings;
  mcpServers?: string[] | null;
}): PersistedSessionConfig {
  const config: PersistedSessionConfig = {};
  if (isObject(input.extensions)) {
    const extensions: SessionExtensions = {};
    for (const key of EXTENSION_KEYS) {
      const value = input.extensions[key];
      if (typeof value === 'boolean') extensions[key] = value;
    }
    config.extensions = extensions;
  }
  if (Array.isArray(input.toolNames)) config.toolNames = [...new Set(input.toolNames)];
  if (typeof input.systemPrompt === 'string' && input.systemPrompt !== '') {
    config.systemPrompt = input.systemPrompt;
  }
  if (isObject(input.compaction)) config.compaction = { ...input.compaction };
  if (Array.isArray(input.mcpServers)) config.mcpServers = [...new Set(input.mcpServers)];
  return config;
}

/**
 * 解析自定义条目里的配置（**防御式**：任何不认识的形状都返回 undefined）。
 *
 * 中文说明：这是从**共享会话文件**里读数据，可能是旧版本写的、被手工改过的、
 * 或者未来版本写的。策略是「认不出来就当作没有配置」——立刻回退到改动前的行为
 * （全开），而不是抛错或半信半疑地套用一半字段。未知的**键**会忽略（向前兼容），
 * 但已知键的类型不对就整份作废。
 */
export function parseSessionConfig(value: unknown): PersistedSessionConfig | undefined {
  if (!isObject(value)) return undefined;
  const config: PersistedSessionConfig = {};
  if (value.extensions !== undefined) {
    if (!isObject(value.extensions)) return undefined;
    const extensions: SessionExtensions = {};
    for (const key of EXTENSION_KEYS) {
      const item = value.extensions[key];
      if (item === undefined) continue;
      if (typeof item !== 'boolean') return undefined;
      extensions[key] = item;
    }
    config.extensions = extensions;
  }
  if (value.toolNames !== undefined) {
    if (!Array.isArray(value.toolNames)) return undefined;
    if (value.toolNames.some((name) => typeof name !== 'string')) return undefined;
    config.toolNames = [...new Set(value.toolNames as string[])];
  }
  if (value.systemPrompt !== undefined) {
    if (typeof value.systemPrompt !== 'string') return undefined;
    if (value.systemPrompt !== '') config.systemPrompt = value.systemPrompt;
  }
  if (value.compaction !== undefined) {
    const compaction = parseCompaction(value.compaction);
    if (compaction === undefined) return undefined;
    config.compaction = compaction;
  }
  if (value.mcpServers !== undefined) {
    if (!Array.isArray(value.mcpServers)) return undefined;
    if (value.mcpServers.some((name) => typeof name !== 'string')) return undefined;
    config.mcpServers = [...new Set(value.mcpServers as string[])];
  }
  return config;
}

/** 压缩策略：三个字段都必须是合法数值，否则 undefined（由调用方整份作废）。 */
function parseCompaction(value: unknown): CompactionSettings | undefined {
  if (!isObject(value)) return undefined;
  const { enabled, keepRecentTokens, reserveTokens } = value;
  if (typeof enabled !== 'boolean') return undefined;
  if (!isPositiveInteger(keepRecentTokens) || !isPositiveInteger(reserveTokens)) return undefined;
  return { enabled, keepRecentTokens, reserveTokens };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * 从会话条目里找出最后一条配置（没有/认不出来 → undefined）。
 *
 * 中文说明：会话是 append-only 的树，同一 customType 可能有多条（未来若支持中途改
 * 能力位就会多写一条），**最后一条即当前生效的那条**——与 plan-mode-service 读自己
 * 状态的口径一致。只看 `type: "custom"`：`custom_message` 是注入上下文的消息，不是配置。
 */
export function findSessionConfig(entries: readonly unknown[]): PersistedSessionConfig | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry?.type !== 'custom' || entry.customType !== SESSION_CONFIG_CUSTOM_TYPE) continue;
    return parseSessionConfig(entry.data);
  }
  return undefined;
}
