/**
 * 会话预设（Preset）持久化服务。
 *
 * 中文说明：预设是"新会话的一组初始配置"，包含系统提示词、可用工具、上下文
 * 压缩策略、默认模型与思考等级。用户可在设置里增删改自定义预设；内置的
 * coding-agent 预设（保留 SDK 默认提示词与默认工具集）由 list() 合成返回，
 * 不落盘、不可改删。
 *
 * 设计要点：
 * - 与 WorkspaceService/ModelConfigService 一致：读到 `~/.pi/agent/node-server-presets.json`，
 *   原子写（临时文件 + rename），读取/解析失败静默返回空；
 * - 磁盘只存自定义预设（无 builtin 字段）；list() 把内置预设拼在最前；
 * - 校验在写方向做（parsePresetInput），失败抛 ApiError 422，前端据此展示错误。
 */

import {
  type CompactionSettings,
  DEFAULT_COMPACTION_SETTINGS,
} from '@earendil-works/pi-coding-agent';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ApiError } from '../errors.js';

/** 内置预设 id（保留 SDK 默认提示词与工具集，不可改删）。 */
export const BUILTIN_PRESET_ID = 'coding-agent';

/** 预设里的上下文压缩策略（对应 SDK 的 CompactionSettings 数值）。 */
export interface PresetCompaction {
  enabled: boolean;
  keepRecentTokens: number;
  reserveTokens: number;
}

/** 创建/更新预设的输入（provider/modelId/thinkingLevel 空串表示"未指定"）。 */
export interface PresetInput {
  name: string;
  systemPrompt: string; // '' = 用 SDK 默认系统提示词
  toolNames: string[]; // [] = 无工具
  compaction: PresetCompaction;
  provider: string;
  modelId: string;
  thinkingLevel: string;
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
  compaction: { ...DEFAULT_COMPACTION_SETTINGS },
  provider: '',
  modelId: '',
  thinkingLevel: '',
};

export class PresetService {
  private readonly path: string;

  constructor(agentDir: string) {
    this.path = join(agentDir, 'node-server-presets.json');
  }

  /** 列表 = 内置 coding-agent（合成） + 磁盘上的自定义预设。 */
  async list(): Promise<SessionPreset[]> {
    const stored = await this.read();
    return [BUILTIN_CODING_AGENT, ...stored.map((preset) => ({ ...preset, builtin: false }))];
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
    if (id === BUILTIN_PRESET_ID) {
      throw new ApiError(400, 'builtin_preset', 'The built-in preset cannot be modified');
    }
    const validated = parsePresetInput(input);
    const stored = await this.read();
    const index = stored.findIndex((preset) => preset.id === id);
    if (index < 0) {
      throw new ApiError(404, 'preset_not_found', `Preset ${id} was not found`);
    }
    stored[index] = { id, ...validated };
    await this.write(stored);
    return { id, ...validated, builtin: false };
  }

  /** 删除自定义预设；内置预设拒绝删除。 */
  async delete(id: string): Promise<void> {
    if (id === BUILTIN_PRESET_ID) {
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
      return presets.filter(isStoredPreset);
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
  return { name, systemPrompt, toolNames, compaction, provider, modelId, thinkingLevel };
}

/** 可选字符串字段：undefined 归一化为空串。 */
function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 工具白名单：非空字符串数组并去重（未知工具名由 SDK 静默忽略）。 */
function parseToolNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new ApiError(422, 'validation_error', 'toolNames must be an array of strings');
  }
  return [...new Set(value.map((name) => name.trim()))];
}

/** 压缩策略：enabled 布尔，keepRecentTokens/reserveTokens 正整数。 */
function parseCompaction(value: unknown): PresetCompaction {
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
