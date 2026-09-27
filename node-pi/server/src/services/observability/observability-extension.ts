/**
 * 运行期观测钩子（provider 层 + 会话层）。
 *
 * 中文说明：会话事件流（`AgentRegistry.publish()`）覆盖不了这几件事，它们只有扩展钩子能看到：
 * - `before_provider_headers` / `after_provider_response`：区分「模型慢」与「网络慢」
 *   （请求头组装完 → 收到响应首字节的耗时、HTTP status）；
 * - `before_provider_request`：**实际发出的请求形状**（消息条数 / 工具集 / 系统提示词指纹），
 *   这是判断「前缀缓存是不是被工具增删打穿了」的唯一直接证据；
 * - `context`：每次调用前的消息数组，用于审计**上下文注入**（plan 状态、`[TASK RESUME]`）；
 * - `model_select`：run 中途换模型（会话事件流里没有这个事件）。
 *
 * 扩展本身不做任何决策（不改请求头、不改 payload、不阻断），只把观测点转发给 observer；
 * observer 内部必须自行吞掉异常（见 SessionLedger），保证对 agent loop 零影响。
 */

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

/** 运行期观测点的接收方（由 SessionLedger 实现）。 */
export interface RuntimeObserver {
  /** 一次 provider HTTP 请求即将发出。 */
  noteProviderRequestStart(sessionId: string): void;
  /** 收到 provider 响应（status 非 2xx 时通常是错误响应）。 */
  noteProviderResponse(sessionId: string, status: number): void;
  /** 一次真实请求的载荷（用于提取工具集/系统提示词形状，正文不落库）。 */
  noteProviderPayload(sessionId: string, payload: unknown): void;
  /** 每次调用前的消息数组（用于识别持续存在的上下文注入）。 */
  noteContextMessages(sessionId: string, messages: unknown): void;
  /** run 中途切换模型（`source` 见 SDK 的 ModelSelectSource）。 */
  noteModelSelect(input: {
    sessionId: string;
    model?: string;
    previousModel?: string;
    source: string;
  }): void;
}

/** 兼容别名（M1 时期的名字，语义已扩大为「运行期观测」）。 */
export type ProviderObserver = RuntimeObserver;

/** 从扩展上下文里取会话 id（拿不到就跳过本次观测）。 */
function sessionIdOf(ctx: unknown): string | undefined {
  const manager = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)
    ?.sessionManager;
  try {
    return manager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

/** 从 model 对象里取 `provider/model` 形态的标识（拿不到就返回 undefined）。 */
function modelIdOf(value: unknown): string | undefined {
  const model = value as { id?: unknown; name?: unknown } | null | undefined;
  if (typeof model?.id === 'string') return model.id;
  if (typeof model?.name === 'string') return model.name;
  return undefined;
}

/** 生成运行期观测扩展。 */
export function buildObservabilityExtension(observer: RuntimeObserver): InlineExtension {
  return (pi: ExtensionAPI) => {
    pi.on('before_provider_headers', (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (sessionId) observer.noteProviderRequestStart(sessionId);
    });
    pi.on('after_provider_response', (event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (sessionId) observer.noteProviderResponse(sessionId, event.status);
    });
    pi.on('before_provider_request', (event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (sessionId) observer.noteProviderPayload(sessionId, event.payload);
    });
    pi.on('context', (event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (sessionId) observer.noteContextMessages(sessionId, event.messages);
    });
    pi.on('model_select', (event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      const model = modelIdOf(event.model);
      const previousModel = modelIdOf(event.previousModel);
      observer.noteModelSelect({
        sessionId,
        ...(model === undefined ? {} : { model }),
        ...(previousModel === undefined ? {} : { previousModel }),
        source: String(event.source),
      });
    });
  };
}
