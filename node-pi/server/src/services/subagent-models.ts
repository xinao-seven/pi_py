/**
 * 子会话的模型解析：把预设里的 `model:` 字符串解析成可用的 `{provider, id}`。
 *
 * 中文说明：这一步是必需的，因为预设里的模型名**很可能在本机不可用**。典型场景：
 * 官方 `subagent` 扩展的四个预设都写死 `model: claude-sonnet-4-5`，而本机只鉴权了
 * deepseek —— 子进程直接以 `Model "claude-sonnet-4-5" is ambiguous across providers:
 * anthropic/..., opencode/... No matching provider is authenticated` 退出，
 * 委派功能整个哑掉且看不出原因。
 *
 * 因此这里的策略是「**能解析就用，解析不了就继承父会话模型并说明原因**」：
 * - `provider/model` 形式：要求该 provider 已配置凭据；
 * - 裸模型 id：必须**唯一命中**且该 provider 已鉴权，多命中（同名不同 provider）视为不可用；
 * - 缺省 / `inherit`：继承父会话模型。
 */

/** 解析所需的最小模型目录能力（ModelRuntime 满足该结构，测试可注入假实现）。 */
export interface ModelCatalog {
  getModel(provider: string, id: string): { provider: string; id: string } | undefined;
  getModels(provider?: string): readonly { provider: string; id: string }[];
  hasConfiguredAuth(provider: string): boolean;
}

export interface ResolvedSubagentModel {
  /** 最终使用的模型；undefined = 交给 SDK 用默认模型（无父会话模型可继承时）。 */
  model?: { provider: string; id: string };
  /** 发生过回退时的说明（写进工具结果，让人知道预设没生效）。 */
  note?: string;
}

/** 表示「继承父会话模型」的取值。 */
export const INHERIT_MODEL = 'inherit';

/**
 * 解析预设模型。
 * 中文说明：返回值里的 `note` 只在**发生回退**时出现——正常解析不该产生噪音。
 */
export function resolveSubagentModel(input: {
  spec?: string;
  /** 父会话当前模型（回退目标）。 */
  fallback?: { provider: string; id: string };
  catalog?: ModelCatalog;
}): ResolvedSubagentModel {
  const spec = input.spec?.trim();
  const fallback = input.fallback;
  const inherit = (reason: string): ResolvedSubagentModel =>
    fallback === undefined
      ? { ...(reason ? { note: reason } : {}) }
      : { model: fallback, ...(reason ? { note: reason } : {}) };

  if (spec === undefined || spec === '' || spec === INHERIT_MODEL) return inherit('');
  if (input.catalog === undefined) return inherit(`无法校验模型「${spec}」，改用父会话模型`);
  const catalog = input.catalog;

  const [provider, ...rest] = spec.split('/');
  if (rest.length > 0) {
    const id = rest.join('/');
    const model = catalog.getModel(provider, id);
    if (model !== undefined && catalog.hasConfiguredAuth(model.provider)) return { model };
    return inherit(`预设模型「${spec}」在本机不可用（未配置 ${provider} 的凭据），改用父会话模型`);
  }

  // 裸模型 id：要求唯一命中且 provider 已鉴权（多命中就是 SDK 报 ambiguous 的那种情况）。
  const matches = catalog.getModels().filter((model) => model.id === spec);
  const usable = matches.filter((model) => catalog.hasConfiguredAuth(model.provider));
  if (usable.length === 1) return { model: usable[0] };
  if (usable.length > 1) {
    return inherit(
      `预设模型「${spec}」在多个 provider 下同名（${usable
        .map((model) => model.provider)
        .join(', ')}），改用父会话模型`,
    );
  }
  return inherit(`预设模型「${spec}」在本机不可用，改用父会话模型`);
}

/** 去掉回退说明里的空串（`note: ''` 不该出现在结果里）。 */
export function modelNote(resolved: ResolvedSubagentModel): string | undefined {
  return resolved.note ? resolved.note : undefined;
}
