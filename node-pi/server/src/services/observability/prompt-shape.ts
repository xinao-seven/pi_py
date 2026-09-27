/**
 * 「每次真实请求长什么样」的纯函数提取（P1）。
 *
 * 中文说明：为什么需要它——`docs/node-plan-cache-stability.md` 把「计划工具常驻、不增删，
 * 注入去抖」定为硬约束，理由是一旦工具列表或系统提示词变化，provider 的**前缀缓存整段失效**，
 * 成本会当场跳起来。这条约束原先只有 `cacheReadTokens` 一个总数在侧面印证，没有归因。
 * 本文件从 `before_provider_request` 的 payload 里抽出「形状」：消息条数、工具名集合、
 * 系统提示词长度与指纹，从而能回答「是工具变了还是系统提示变了」。
 *
 * 两条纪律：
 * - **不落正文**：只记长度与 sha256 前 12 位，正文不落库；
 * - **绝不抛错、绝不拖慢**：payload 是 `unknown`，所有取值都做类型守卫；不 JSON.stringify
 *   整个 payload（长会话下那是几十 MB 的字符串）。
 */

import { digestOf, redactText } from './redact.js';

/**
 * provider 请求载荷里我们关心的那几个字段（其余一律忽略）。
 * 中文说明：SDK 的 `before_provider_request` 把 payload 声明为 `unknown`，不同 provider 的
 * 字段名不完全一致，所以这里用宽容的结构 + 类型守卫读取，而不是断言成某个具体类型。
 */
interface ProviderPayloadLike {
  messages?: unknown;
  tools?: unknown;
  system?: unknown;
  systemPrompt?: unknown;
  system_prompt?: unknown;
  instructions?: unknown;
}

/** 系统提示词参与指纹的最长字符数（超出只取前缀，避免大字符串拖住事件循环）。 */
const MAX_SYSTEM_CHARS = 64 * 1024;

/** 工具名上限（超出只取前若干个，顺序已排序所以结果稳定）。 */
const MAX_TOOLS = 64;

/** 一次请求的「形状」（cache 前缀的可见部分）。 */
export interface PromptShape {
  /** 消息条数。 */
  messages: number;
  /** 按名字排序的工具名（最多 MAX_TOOLS 个）。 */
  tools: string[];
  /** 工具集指纹（顺序无关）：空工具集是空串。 */
  toolsFingerprint: string;
  /** 系统提示词字符数（取不到则为 0）。 */
  systemChars: number;
  /** 系统提示词指纹（脱敏后取 sha256 前 12 位；取不到则为 undefined）。 */
  systemDigest?: string;
}

/** 工具名的三种常见形状：`{name}` / `{function:{name}}` / 裸字符串。 */
function toolNameOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as { name?: unknown; function?: { name?: unknown } };
  if (typeof record.name === 'string') return record.name;
  const nested = record.function;
  if (nested !== null && typeof nested === 'object' && typeof nested.name === 'string') {
    return nested.name;
  }
  return undefined;
}

function systemTextOf(payload: ProviderPayloadLike): string | undefined {
  const candidates = [
    payload.system,
    payload.systemPrompt,
    payload.system_prompt,
    payload.instructions,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * 从 provider 请求载荷里提取形状；无法识别时返回 undefined（调用方跳过本次观测）。
 */
export function promptShapeOf(payload: unknown): PromptShape | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const record = payload as ProviderPayloadLike;
  const rawMessages = record.messages;
  if (!Array.isArray(rawMessages)) return undefined;
  const rawTools = record.tools;
  const tools = Array.isArray(rawTools)
    ? [...new Set(rawTools.map(toolNameOf).filter((name): name is string => name !== undefined))]
        .sort()
        .slice(0, MAX_TOOLS)
    : [];
  const system = systemTextOf(record);
  return {
    messages: rawMessages.length,
    tools,
    toolsFingerprint: tools.join('|'),
    systemChars: system?.length ?? 0,
    ...(system === undefined
      ? {}
      : { systemDigest: digestOf(redactText(system.slice(0, MAX_SYSTEM_CHARS))) }),
  };
}

/** 一条上下文注入（plan 状态 / task resume 等隐藏消息）。 */
export interface ContextInjection {
  /** 注入的消息类型（SDK 的 `customType`）：`web-plan-context` / `task-resume` … */
  customType: string;
  /** 注入正文的字符数。 */
  chars: number;
  /** 注入正文（脱敏后）的指纹，用于去抖：内容没变就不重复记账。 */
  digest: string;
}

/** 注入正文的字符数（字符串直接取长度，数组按块累加，其余按 0 处理）。 */
function contentCharsOf(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((total, block) => {
      const text = (block as { text?: unknown } | null)?.text;
      return total + (typeof text === 'string' ? text.length : 0);
    }, 0);
  }
  return 0;
}

/** 注入正文的文本形态（只用于脱敏与取指纹，不落库）。 */
function contentTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => ((block as { text?: unknown } | null)?.text as string | undefined) ?? '')
      .join('\n');
  }
  return '';
}

/**
 * 从一次 `context` 钩子的消息数组里抽出注入。
 *
 * 中文说明：**从后往前**扫——SDK 侧（`plan-mode` / `task-recovery`）对同类型注入的策略是
 * 「只留最后一条」，所以同一 `customType` 取最后出现的那条才是当前生效的内容。
 * `limit` 同时限制了单次调用最多记几条（正常会话只有 0–2 条）。
 */
export function collectInjections(messages: unknown, limit = 8): ContextInjection[] {
  if (!Array.isArray(messages) || limit <= 0) return [];
  // 记录「发现位置」→ 输出时按历史顺序排列（同类型取最后一次出现的那条）。
  const found = new Map<string, { index: number; injection: ContextInjection }>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const customType = (messages[index] as { customType?: unknown } | null)?.customType;
    if (typeof customType !== 'string' || customType.length === 0) continue;
    if (found.has(customType)) continue;
    const content = (messages[index] as { content?: unknown }).content;
    found.set(customType, {
      index,
      injection: {
        customType,
        chars: contentCharsOf(content),
        digest: digestOf(redactText(contentTextOf(content).slice(0, MAX_SYSTEM_CHARS))),
      },
    });
    if (found.size >= limit) break;
  }
  return [...found.values()]
    .sort((left, right) => left.index - right.index)
    .map((item) => item.injection);
}
