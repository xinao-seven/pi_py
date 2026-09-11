/**
 * 内置模型目录的价格兜底（M1 成本口径的补丁）。
 *
 * 中文说明：`models.json` 里重复定义同名模型时，SDK 的 provider-composer 会用它覆盖
 * 内置模型，并把未填写的 `cost` 归零（见 pi-coding-agent/core/provider-composer.js 的
 * `modelFromJson`）。于是「自定义了 provider 但没写价格」的配置（典型是 DeepSeek）在用量
 * 面板里永远是 $0。这里按 provider/model id 回查内置目录，拿到官方价格后用与 pi-ai
 * `calculateCost` 相同的口径重算，只作为账本的兜底：模型显式给出的非零 cost 永远优先。
 */

import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';

/** 重算成本只需要这几个 token 计数。 */
export interface TokenUsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface CostWithTiers extends CostRates {
  tiers?: Array<CostRates & { inputTokensAbove: number }>;
}

/** getBuiltinModel 的强类型签名只接受字面量 provider/id；运行期 id 是配置拼出来的。 */
const lookupBuiltin = getBuiltinModel as unknown as (
  provider: string,
  modelId: string,
) => { cost?: CostWithTiers } | undefined;

/**
 * 用内置目录价格计算一次调用的美元成本。
 * 中文说明：目录里没有该模型、或模型没带价格时返回 undefined（调用方保持原值 0）。
 */
export function builtinCostUsd(
  provider: string | undefined,
  model: string | undefined,
  usage: TokenUsageLike,
): number | undefined {
  if (!provider || !model) return undefined;
  const base = lookupBuiltin(provider, model)?.cost;
  if (!base) return undefined;
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  // 与 pi-ai calculateCost 一致：按「输入 + 缓存」总量匹配阶梯价，取满足条件的最高档。
  const totalInput = input + cacheRead + cacheWrite;
  let rates: CostRates = base;
  let matched = -1;
  for (const tier of base.tiers ?? []) {
    if (totalInput > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
      rates = tier;
      matched = tier.inputTokensAbove;
    }
  }
  return (
    (rates.input / 1_000_000) * input +
    (rates.output / 1_000_000) * output +
    (rates.cacheRead / 1_000_000) * cacheRead +
    (rates.cacheWrite / 1_000_000) * cacheWrite
  );
}
