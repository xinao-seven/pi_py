/**
 * 压缩（compaction）触发策略：把「标称上下文窗口」换算成「实际愿意让它涨到多大」。
 *
 * 中文说明：SDK 的自动压缩条件是 `contextTokens > contextWindow - reserveTokens`，
 * 而 reserveTokens 的缺省值只有 16K——对 1M 级标称窗口的模型意味着涨到约 98 万 token
 * 才压缩，实测会话滚到 30-40 万都不触发（长上下文后半段质量开始衰减，且每一轮的
 * 缓存重读随上下文线性变大）。本模块的策略：
 *
 * - **触发点上限**：工作上下文涨到 `COMPACTION_TRIGGER_TOKENS`（200K）就压缩，
 *   与标称窗口无关——把 reserveTokens 抬到 `contextWindow - 触发点` 来兑现；
 * - **保留区加大**：未显式配置时 keepRecentTokens 从 SDK 默认 20K 提到 48K
 *   （约覆盖 20-40 轮的逐字工作区：正在改的文件最近几版、刚跑的测试输出）；
 * - **尊重显式关闭**：`enabled: false` 原样返回（用户/预设明确不要自动压缩）；
 * - **防御病态配置**：keepRecentTokens 必须小于触发点，否则压缩在保留区里打转
 *   （每次都触发、又压不掉多少），超出时夹到 `触发点 - 16K`。
 *
 * 纯函数、无 IO；接线在 `agent-registry` 的 create/open（解析模型 contextWindow 后调用）。
 */

import type { CompactionSettings } from '@earendil-works/pi-coding-agent';

/** 工作上下文的压缩触发点（token）。无论标称窗口多大，涨到这里就开始压缩。 */
export const COMPACTION_TRIGGER_TOKENS = 200_000;

/** 未显式配置时的 keepRecentTokens（SDK 默认 20K；48K ≈ 20-40 轮的逐字工作区）。 */
export const PLATFORM_KEEP_RECENT_TOKENS = 48_000;

/** 平台默认压缩策略（预设/设置都没有给 compaction 时作为基线）。 */
export const PLATFORM_COMPACTION_DEFAULTS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: PLATFORM_KEEP_RECENT_TOKENS,
};

/** 与 SDK 缺省一致的 keepRecent 安全边距：保留区之外至少再留这么多才切。 */
const KEEP_RECENT_MARGIN_TOKENS = 16_384;

/**
 * 把「配置值 + 模型窗口」解析成实际生效的压缩策略。
 *
 * 中文说明：`configured` 是预设/设置里声明的策略（可能只是 SDK 缺省值的拷贝）；
 * `contextWindow` 是本次会话模型的标称窗口（未知时传 undefined，只做防御性夹取，
 * 不动 reserveTokens——此时无从知道窗口该不该收）。
 */
export function resolveCompactionSettings(
  configured: CompactionSettings,
  contextWindow: number | undefined,
): CompactionSettings {
  // 显式关闭：尊重，不抬 reserveTokens（抬了也没有意义，enabled=false 短路在先）。
  // 字段可能缺省（包根导出的类型全可选）：缺省值与 SDK/本模块的平台默认一致。
  if (configured.enabled === false) {
    return {
      enabled: false,
      reserveTokens: configured.reserveTokens ?? 16_384,
      keepRecentTokens: configured.keepRecentTokens ?? PLATFORM_KEEP_RECENT_TOKENS,
    };
  }
  let reserveTokens = configured.reserveTokens ?? 16_384;
  let keepRecentTokens = configured.keepRecentTokens ?? PLATFORM_KEEP_RECENT_TOKENS;
  if (contextWindow !== undefined && contextWindow > COMPACTION_TRIGGER_TOKENS) {
    // 触发点 = contextWindow - reserveTokens；想让它 ≤ 200K，就要 reserveTokens ≥ 窗口 - 200K。
    // 取 max：显式配置比下限更激进（更大的 reserve）时保留配置值。
    reserveTokens = Math.max(reserveTokens, contextWindow - COMPACTION_TRIGGER_TOKENS);
  }
  if (contextWindow !== undefined) {
    // 触发点必须留出安全边距给保留区，否则压缩永远凑不齐 keepRecent 而反复触发。
    const maxKeepRecent = Math.max(0, contextWindow - reserveTokens - KEEP_RECENT_MARGIN_TOKENS);
    keepRecentTokens = Math.min(keepRecentTokens, maxKeepRecent);
  }
  return { enabled: true, reserveTokens, keepRecentTokens };
}
