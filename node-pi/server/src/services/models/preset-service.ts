/**
 * 会话预设（Preset）持久化服务。
 *
 * 中文说明：预设是"新会话的一组初始配置"，包含系统提示词、可用工具、上下文
 * 压缩策略、默认模型与思考等级，以及**会话能力开关**（Plan / 审批 / 提问 /
 * 子 agent / 任务面板 / 观测钩子 / 文件扩展）。用户可在设置里增删改自定义预设；
 * 内置预设（coding-agent 与极简（原版 pi））由 list() 合成返回，不落盘、不可改删。
 *
 * 设计要点：
 * - 与 WorkspaceService/ModelConfigService 一致：读到 `~/.pi/agent/node-server-presets.json`，
 *   原子写（临时文件 + rename），读取/解析失败静默返回空；
 * - 磁盘只存自定义预设（无 builtin 字段）；list() 把内置预设拼在最前；
 * - 兼容旧文件：缺 capabilities / toolNames 为 null / compaction 为 null 都能读，
 *   缺省能力按"全开"处理（与改动前的行为一致）；
 * - 校验在写方向做（parsePresetInput），失败抛 ApiError 422，前端据此展示错误。
 */

import {
  type CompactionSettings,
  DEFAULT_COMPACTION_SETTINGS,
} from '@earendil-works/pi-coding-agent';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ApiError } from '../../errors.js';
import { PLATFORM_KEEP_RECENT_TOKENS } from '../agent/compaction-policy.js';

/** 内置预设 id（保留 SDK 默认提示词与工具集，不可改删）。 */
export const BUILTIN_PRESET_ID = 'coding-agent';

/** 内置「极简（原版 pi）」预设 id：什么都不加，只留 SDK 原生行为。 */
export const MINIMAL_PRESET_ID = 'minimal';

/** 内置预设 id 集合（都不可改删）。 */
const BUILTIN_PRESET_IDS: ReadonlySet<string> = new Set([BUILTIN_PRESET_ID, MINIMAL_PRESET_ID]);

/** 预设里的上下文压缩策略（对应 SDK 的 CompactionSettings 数值）。 */
export interface PresetCompaction {
  enabled: boolean;
  keepRecentTokens: number;
  reserveTokens: number;
}

/**
 * 预设里的会话能力开关。
 * 中文说明：字段名贴近用户概念（plan / subagent / tasks）；前端在创建会话时
 * 把它映射成 `CreateSessionInput.extensions`（plan→planMode）。
 */
export interface PresetCapabilities {
  plan: boolean; // Plan 模式（计划工具 + 规划期只读）
  approval: boolean; // 危险命令人工审批
  questions: boolean; // 向用户提问（ask_user）
  subagent: boolean; // 子任务委派（subagent 工具）
  tasks: boolean; // 任务面板/任务域（Plan 依赖它）
  observability: boolean; // 平台观测钩子（provider 层只读）
  fileExtensions: boolean; // 是否加载用户级/工作区级文件扩展
}

/** 缺省能力：全开（与 M0–M5 的现状一致，旧预设零迁移）。 */
const DEFAULT_CAPABILITIES: PresetCapabilities = {
  plan: true,
  approval: true,
  questions: true,
  subagent: true,
  tasks: true,
  observability: true,
  fileExtensions: true,
};

/** 创建/更新预设的输入（provider/modelId/thinkingLevel 空串表示"未指定"）。 */
export interface PresetInput {
  name: string;
  systemPrompt: string; // '' = 用 SDK 默认系统提示词
  toolNames: string[] | null; // null = SDK 默认发现（不限制白名单）；[] = 无工具
  compaction: PresetCompaction | null; // null = 不覆盖设置（用 SDK/设置解析）
  capabilities: PresetCapabilities; // 会话能力开关
  provider: string;
  modelId: string;
  thinkingLevel: string;
  mcpServers: string[] | null; // null = 全部 MCP 服务；[] = 禁用；否则为服务名白名单
}

/** 返回给前端的预设视图（含内置标志）。 */
export interface SessionPreset extends PresetInput {
  id: string;
  builtin: boolean;
}

/** 磁盘上持久化的自定义预设（无 builtin 字段）。 */
interface StoredPreset extends PresetInput {
  id: string;
}

/** 合法思考等级集合（与 Pi 语义一致）。 */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** 内置 coding-agent 预设：全部字段取"未指定"，即用 SDK/设置默认值。 */
const BUILTIN_CODING_AGENT: SessionPreset = {
  id: BUILTIN_PRESET_ID,
  name: 'Coding Agent（默认）',
  builtin: true,
  systemPrompt: '',
  toolNames: ['read', 'bash', 'edit', 'write'],
  // 中文说明：keepRecentTokens 从 SDK 默认 20K 提到 48K（约 20-40 轮的逐字工作区，
  // 压缩后模型仍能看到正在改的文件最近几版）；reserveTokens 保持 SDK 值，
  // 实际触发点由 create/open 按模型 contextWindow 换算（≤200K，见 compaction-policy）。
  compaction: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: PLATFORM_KEEP_RECENT_TOKENS },
  capabilities: { ...DEFAULT_CAPABILITIES },
  provider: '',
  modelId: '',
  thinkingLevel: '',
  mcpServers: null,
};

/**
 * 内置「极简（原版 pi）」预设：什么都不加，让会话退化成原版 pi。
 * 中文说明：所有平台能力关闭 + 不限制工具白名单（SDK 自己发现）+ 不覆盖压缩与
 * 系统提示词 + 禁用 MCP + 不加载用户文件扩展。代价是它与 CLI 不再完全一致
 * （同一个会话在 CLI 里用户扩展生效），取舍写在 docs/node-preset-capabilities.md。
 */
const BUILTIN_MINIMAL: SessionPreset = {
  id: MINIMAL_PRESET_ID,
  name: '极简（原版 pi）',
  builtin: true,
  systemPrompt: '',
  toolNames: null,
  compaction: null,
  capabilities: {
    plan: false,
    approval: false,
    questions: false,
    subagent: false,
    tasks: false,
    observability: false,
    fileExtensions: false,
  },
  provider: '',
  modelId: '',
  thinkingLevel: '',
  mcpServers: [],
};

export class PresetService {
  private readonly path: string;

  constructor(agentDir: string) {
    this.path = join(agentDir, 'node-server-presets.json');
  }

  /** 列表 = 内置预设（合成） + 磁盘上的自定义预设。 */
  async list(): Promise<SessionPreset[]> {
    const stored = await this.read();
    return [
      BUILTIN_CODING_AGENT,
      BUILTIN_MINIMAL,
      ...stored.map((preset) => ({ ...preset, builtin: false })),
    ];
  }

  /** 新建自定义预设。 */
  async create(input: unknown): Promise<SessionPreset> {
    const preset: StoredPreset = { id: crypto.randomUUID(), ...parsePresetInput(input) };
    const stored = await this.read();
    stored.push(preset);
    await this.write(stored);
    return { ...preset, builtin: false };
  }

  /** 更新自定义预设；内置预设拒绝修改。 */
  async update(id: string, input: unknown): Promise<SessionPreset> {
    if (BUILTIN_PRESET_IDS.has(id)) {
      throw new ApiError(400, 'builtin_preset', 'The built-in preset cannot be modified');
    }
    const validated = parsePresetInput(input);
    const stored = await this.read();
    const index = stored.findIndex((preset) => preset.id === id);
    if (index < 0) {
      throw new ApiError(404, 'preset_not_found', `Preset ${id} was not found`);
    }
    // spread 原记录：写入时保留我们不认识的字段（磁盘上的文件可能被更高版本写过）。
    stored[index] = { ...stored[index], id, ...validated };
    await this.write(stored);
    return { id, ...validated, builtin: false };
  }

  /** 删除自定义预设；内置预设拒绝删除。 */
  async delete(id: string): Promise<void> {
    if (BUILTIN_PRESET_IDS.has(id)) {
      throw new ApiError(400, 'builtin_preset', 'The built-in preset cannot be deleted');
    }
    const stored = await this.read();
    const next = stored.filter((preset) => preset.id !== id);
    if (next.length === stored.length) {
      throw new ApiError(404, 'preset_not_found', `Preset ${id} was not found`);
    }
    await this.write(next);
  }

  /** 读取磁盘上的自定义预设（文件不存在/损坏时返回空列表）。 */
  private async read(): Promise<StoredPreset[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      const presets =
        value && typeof value === 'object' ? (value as { presets?: unknown }).presets : undefined;
      if (!Array.isArray(presets)) return [];
      // 读时归一化：旧文件没有 capabilities / 可能缺字段，parsePresetInput 会补默认值，
      // 保证 API 返回的每个预设形状一致；spread 原记录以保留不认识的字段。
      return presets
        .filter(isStoredPreset)
        .map((preset) => ({ ...preset, ...parsePresetInput(preset) }));
    } catch {
      return [];
    }
  }

  /** 原子写（临时文件 + rename），避免中途崩溃留下半截文件。 */
  private async write(presets: StoredPreset[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ presets }, null, 2)}\n`, 'utf8');
    await rename(temporary, this.path);
  }
}

/** 校验并归一化来自 HTTP body 的预设输入。 */
function parsePresetInput(value: unknown): PresetInput {
  if (!isObject(value)) {
    throw new ApiError(422, 'validation_error', 'preset must be an object');
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) throw new ApiError(422, 'validation_error', 'preset name is required');
  const systemPrompt = typeof value.systemPrompt === 'string' ? value.systemPrompt : '';
  const toolNames = parseToolNames(value.toolNames);
  const compaction = parseCompaction(value.compaction);
  const capabilities = parseCapabilities(value.capabilities);
  const provider = optionalString(value.provider);
  const modelId = optionalString(value.modelId);
  // provider 与 modelId 必须成对：只给一个会导致模型解析错误。
  if ((provider === '') !== (modelId === '')) {
    throw new ApiError(422, 'validation_error', 'provider and modelId must be provided together');
  }
  const thinkingLevel = optionalString(value.thinkingLevel);
  if (thinkingLevel && !THINKING_LEVELS.has(thinkingLevel)) {
    throw new ApiError(422, 'validation_error', 'unsupported thinking level');
  }
  return {
    name,
    systemPrompt,
    toolNames,
    compaction,
    capabilities,
    provider,
    modelId,
    thinkingLevel,
    mcpServers: parseMcpServers(value.mcpServers),
  };
}

/** 可选字符串字段：undefined 归一化为空串。 */
function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 工具白名单：null/缺省 = SDK 默认发现（不限制白名单）；
 * 非空字符串数组 = 只允许这些工具；空数组 = 无工具。
 */
function parseToolNames(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new ApiError(422, 'validation_error', 'toolNames must be null or an array of strings');
  }
  return [...new Set(value.map((name) => name.trim()))];
}

/** 能力开关的合法键（与 PresetCapabilities 一一对应）。 */
const CAPABILITY_KEYS = [
  'plan',
  'approval',
  'questions',
  'subagent',
  'tasks',
  'observability',
  'fileExtensions',
] as const;

/**
 * 会话能力开关：缺省 = 全开（与改动前行为一致，旧预设零迁移）。
 * 中文说明：`plan` 依赖 `tasks`——Plan 是 `origin='plan'` 任务的受控视图，
 * 关掉任务域后它没有任何落点，所以在写入方向直接 422，而不是运行时静默降级。
 */
function parseCapabilities(value: unknown): PresetCapabilities {
  if (value === undefined || value === null) return { ...DEFAULT_CAPABILITIES };
  if (!isObject(value)) {
    throw new ApiError(422, 'validation_error', 'capabilities must be an object');
  }
  const result: PresetCapabilities = { ...DEFAULT_CAPABILITIES };
  for (const key of CAPABILITY_KEYS) {
    const item = value[key];
    if (item === undefined) continue;
    if (typeof item !== 'boolean') {
      throw new ApiError(422, 'validation_error', `capabilities.${key} must be a boolean`);
    }
    result[key] = item;
  }
  if (result.plan && !result.tasks) {
    throw new ApiError(422, 'validation_error', 'capabilities.plan requires capabilities.tasks');
  }
  return result;
}

/**
 * MCP 服务白名单：null/缺省 = 全部；空数组 = 禁用全部；
 * 非空数组 = 服务名白名单（未知的名字在创建会话时由扩展过滤，自然失效）。
 */
function parseMcpServers(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new ApiError(422, 'validation_error', 'mcpServers must be null or an array of strings');
  }
  return [...new Set(value.map((name) => name.trim()))];
}

/** 压缩策略：null = 不覆盖设置；否则 enabled 布尔，keepRecentTokens/reserveTokens 正整数。 */
function parseCompaction(value: unknown): PresetCompaction | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) {
    throw new ApiError(422, 'validation_error', 'compaction must be an object');
  }
  const enabled = value.enabled;
  const keepRecentTokens = value.keepRecentTokens;
  const reserveTokens = value.reserveTokens;
  if (typeof enabled !== 'boolean') {
    throw new ApiError(422, 'validation_error', 'compaction.enabled must be a boolean');
  }
  if (
    typeof keepRecentTokens !== 'number' ||
    !Number.isInteger(keepRecentTokens) ||
    keepRecentTokens <= 0
  ) {
    throw new ApiError(
      422,
      'validation_error',
      'compaction.keepRecentTokens must be a positive integer',
    );
  }
  if (typeof reserveTokens !== 'number' || !Number.isInteger(reserveTokens) || reserveTokens <= 0) {
    throw new ApiError(
      422,
      'validation_error',
      'compaction.reserveTokens must be a positive integer',
    );
  }
  return { enabled, keepRecentTokens, reserveTokens };
}

/** 防御性形状检查：磁盘上的条目至少具备必需字段。 */
function isStoredPreset(value: unknown): value is StoredPreset {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id) return false;
  try {
    parsePresetInput(value);
    return true;
  } catch {
    return false;
  }
}

/** 类型守卫：非 null 的普通对象（排除数组）。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
