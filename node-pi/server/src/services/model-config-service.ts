/**
 * 模型配置（models.json）读写服务。
 *
 * 中文说明：models.json 是原版 Pi 的模型配置文件，位于 agentDir 下，
 * 结构大致为 { "providers": { "<provider名>": { api, baseUrl, apiKey, models[] } } }。
 * 本服务提供：
 * - read()：读取并"净化"——只保留允许的字段，apiKey 只接受环境变量引用（$XXX），
 *   绝不允许把明文密钥读回给前端；
 * - write()：严格校验后整体替换（先写临时文件再原子 rename，防写坏配置）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ApiError } from '../errors.js';

// apiKey 的合法格式：必须是 $XXX 形式的环境变量引用（如 $ANTHROPIC_API_KEY）。
const ENV_REFERENCE = /^\$[A-Z_][A-Z0-9_]*$/;
// 合法思考等级集合（与 Pi 语义一致）。
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export class ModelConfigService {
  private readonly path: string;

  constructor(agentDir: string) {
    this.path = join(agentDir, 'models.json');
  }

  /** 读取配置：文件不存在/解析失败时返回空配置而不是报错。 */
  async read(): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      return this.sanitize(parsed);
    } catch {
      return { providers: {} };
    }
  }

  /** 写入配置：严格校验后原子替换（写临时文件 → rename）。 */
  async write(value: unknown): Promise<void> {
    const validated = this.validate(value);
    await mkdir(dirname(this.path), { recursive: true }); // 目录不存在时先创建
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    await rename(temporary, this.path); // rename 是原子的，避免中途崩溃留下半截文件
  }

  /**
   * 净化（读方向）：白名单式过滤，只保留我们允许暴露给前端的字段。
   * 关键：apiKey 只保留环境变量引用形式（$XXX）；明文密钥一律丢弃。
   */
  private sanitize(value: unknown): Record<string, unknown> {
    if (!this.isObject(value) || !this.isObject(value.providers)) return { providers: {} };
    const providers: Record<string, unknown> = {};
    for (const [name, candidate] of Object.entries(value.providers)) {
      if (!this.isObject(candidate)) continue;
      const provider: Record<string, unknown> = {};
      if (typeof candidate.api === 'string') provider.api = candidate.api;
      if (typeof candidate.baseUrl === 'string') provider.baseUrl = candidate.baseUrl;
      if (typeof candidate.apiKey === 'string' && ENV_REFERENCE.test(candidate.apiKey))
        provider.apiKey = candidate.apiKey;
      if (Array.isArray(candidate.models))
        provider.models = candidate.models.filter(this.isObject).map((model) => ({ ...model }));
      providers[name] = provider;
    }
    return { providers };
  }

  /**
   * 校验（写方向）：逐项检查，任何一项不合法就抛 422 并整体拒绝写入。
   */
  private validate(value: unknown): Record<string, unknown> {
    if (!this.isObject(value) || !this.isObject(value.providers)) {
      throw new ApiError(
        422,
        'invalid_models_config',
        'models config must contain a providers object',
      );
    }
    const providers: Record<string, unknown> = {};
    for (const [name, candidate] of Object.entries(value.providers)) {
      if (!name.trim() || !this.isObject(candidate)) {
        throw new ApiError(
          422,
          'invalid_models_config',
          'provider names must be non-empty and values must be objects',
        );
      }
      const provider = { ...candidate };
      // apiKey 必须引用环境变量（不允许写明文密钥到配置文件）。
      if (
        provider.apiKey !== undefined &&
        (typeof provider.apiKey !== 'string' || !ENV_REFERENCE.test(provider.apiKey))
      ) {
        throw new ApiError(
          422,
          'invalid_models_config',
          `provider ${name} apiKey must reference an environment variable`,
        );
      }
      if (provider.models !== undefined && !Array.isArray(provider.models)) {
        throw new ApiError(
          422,
          'invalid_models_config',
          `provider ${name} models must be an array`,
        );
      }
      for (const model of provider.models ?? []) {
        // 每个模型必须有非空 id。
        if (!this.isObject(model) || typeof model.id !== 'string' || !model.id.trim()) {
          throw new ApiError(
            422,
            'invalid_models_config',
            `provider ${name} models must contain non-empty ids`,
          );
        }
        if (
          model.contextWindow !== undefined &&
          (!Number.isInteger(model.contextWindow) || (model.contextWindow as number) <= 0)
        ) {
          throw new ApiError(
            422,
            'invalid_models_config',
            `model ${name}:${model.id} contextWindow must be a positive integer`,
          );
        }
        if (model.reasoning !== undefined && typeof model.reasoning !== 'boolean') {
          throw new ApiError(
            422,
            'invalid_models_config',
            `model ${name}:${model.id} reasoning must be a boolean`,
          );
        }
        if (
          model.thinkingLevels !== undefined &&
          (!Array.isArray(model.thinkingLevels) ||
            model.thinkingLevels.some(
              (level) => typeof level !== 'string' || !THINKING_LEVELS.has(level),
            ))
        ) {
          throw new ApiError(
            422,
            'invalid_models_config',
            `model ${name}:${model.id} contains an unsupported thinking level`,
          );
        }
      }
      providers[name] = provider;
    }
    return { providers };
  }

  /** 类型守卫：非 null 的普通对象（排除数组）。 */
  private isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}
