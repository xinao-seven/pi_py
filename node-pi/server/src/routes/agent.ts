/**
 * Agent 的 HTTP 与 SSE（Server-Sent Events）路由。
 *
 * 中文说明：实现现有 Vue 所需的最小 Agent 协议：创建会话、下发命令、查询状态，
 * 以及通过 SSE 推送 Pi SDK 的实时事件流（消息增量、工具调用、审批请求等）。
 *
 * Fastify 概念速览：
 * - FastifyPluginAsync<T>：插件类型。插件 = async 函数 (app, options) => {...}。
 *   这里 app 是挂载了 "/api/agent" 前缀的封装实例；options 是 app.ts 注册时
 *   传入的 { registry }（即下面的 AgentRouteOptions）；
 * - app.post<泛型>(path, handler)：注册路由。尖括号里的泛型只约束
 *   request.params / request.query / request.body 的 TypeScript 类型（编译期），
 *   运行期数据仍需自行校验——这就是下面有一堆 optionalString / images 等
 *   校验辅助函数的原因；
 * - handler 可以是 async 函数：直接 return 的值会作为 JSON 响应体自动发送，
 *   也可以 reply.code(...).send(...) 显式控制状态码与响应体；
 * - reply.hijack()：接管响应，之后由我们直接用 reply.raw（Node 原生
 *   http.ServerResponse）写数据——SSE 长连接就是靠它实现的。
 */

import type { CompactionSettings } from '@earendil-works/pi-coding-agent';
import type { FastifyPluginAsync } from 'fastify';
import { stat } from 'node:fs/promises';

import {
  AgentRegistry,
  type ImageAttachment,
  type StreamEvent,
} from '../services/agent-registry.js';
import { ApiError } from '../errors.js';

/** 注册 agentRoutes 插件时所需的选项（由 app.ts 传入）。 */
export interface AgentRouteOptions {
  registry: AgentRegistry;
}

/** POST /new 请求体的宽松类型（运行期还要逐个校验，见下方辅助函数）。 */
interface NewAgentBody {
  cwd?: unknown;
  message?: unknown;
  provider?: unknown;
  modelId?: unknown;
  thinkingLevel?: unknown;
  toolNames?: unknown;
  systemPrompt?: unknown;
  compaction?: unknown;
  images?: unknown;
}

// ---- 下面是一组"手写校验"辅助函数 ------------------------------------------
// 中文说明：Fastify 官方推荐用 JSON Schema 做请求校验，但本项目为了让 Vue
// 前端拿到与 FastAPI 后端完全一致的 { error: { code, message } } 错误结构，
// 选择在代码里手工校验并抛 ApiError，由全局错误处理器统一转成响应。

/** 请求体必须是 JSON 对象（拒绝 null / 数组 / 原始类型）。 */
function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(422, 'validation_error', 'Request body must be an object');
  }
  return value as Record<string, unknown>;
}

/** 可选字符串字段：undefined 放行；提供了但类型不对则抛 422。 */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new ApiError(422, 'validation_error', `${field} must be a string`);
  return value;
}

/** 可选字符串数组（用于 toolNames 工具白名单）。 */
function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ApiError(422, 'validation_error', 'toolNames must be an array of strings');
  }
  return value;
}

/** 可选压缩策略：enabled 布尔，keepRecentTokens/reserveTokens 正整数。 */
function optionalCompaction(value: unknown): CompactionSettings | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(422, 'validation_error', 'compaction must be an object');
  }
  const { enabled, keepRecentTokens, reserveTokens } = value as Record<string, unknown>;
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

/**
 * 图片附件校验与归一化：最多 4 张、每张是 { type: "image", data, mimeType }、
 * data 必须是合法 base64、解码后不超过 5MB。
 * 中文说明：与 Python 后端的限制保持一致，防止超大图片打爆上下文。
 */
function images(value: unknown): ImageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) {
    throw new ApiError(422, 'validation_error', 'images must contain at most 4 items');
  }
  return value.map((value) => {
    if (value === null || typeof value !== 'object') {
      throw new ApiError(422, 'validation_error', 'images must contain image content blocks');
    }
    const image = value as Partial<ImageAttachment>;
    if (
      image.type !== 'image' ||
      typeof image.data !== 'string' ||
      typeof image.mimeType !== 'string' ||
      !image.mimeType.startsWith('image/')
    ) {
      throw new ApiError(422, 'validation_error', 'images must contain valid image content blocks');
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length % 4 !== 0) {
      throw new ApiError(422, 'validation_error', 'image data must be valid base64');
    }
    const decoded = Buffer.from(image.data, 'base64');
    if (decoded.length > 5 * 1024 * 1024) {
      throw new ApiError(422, 'validation_error', 'image exceeds 5 MB');
    }
    return { type: 'image', data: image.data, mimeType: image.mimeType };
  });
}

/**
 * 把一条 StreamEvent 写成 SSE 报文。
 * SSE 协议格式：每帧由若干 "字段: 值" 行组成，空行结束一帧。
 * 这里只输出 id 与 data 两行，例如：
 *   id: 3
 *   data: {"type":"agent_message",...}
 *
 * 前端 EventSource 会自动解析 id 字段，断线重连时通过 Last-Event-ID 请求头
 * 告知服务端从哪条事件之后开始补发。
 */
function sendSse(
  reply: {
    raw: NodeJS.WritableStream & {
      write(chunk: string): boolean;
      end(): void;
    };
    hijack(): void;
  },
  event: StreamEvent,
): void {
  reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event.payload)}\n\n`);
}

/** Agent 路由插件：对外路径都以 /api/agent 开头（前缀由 app.ts 注册时指定）。 */
export const agentRoutes: FastifyPluginAsync<AgentRouteOptions> = async (app, options) => {
  // POST /api/agent/new —— 创建新会话并立刻发送第一条 prompt。
  // 返回 202（Accepted）表示已受理：prompt 是异步执行的，结果通过 SSE 流推送。
  app.post('/new', async (request, reply) => {
    const body = objectBody(request.body) as NewAgentBody;
    const cwd = optionalString(body.cwd, 'cwd');
    const message = optionalString(body.message, 'message') ?? '';
    const inputImages = images(body.images);
    // cwd 必填；message 与图片至少提供一个，否则没有内容可发给模型。
    if (!cwd) throw new ApiError(422, 'validation_error', 'cwd is required');
    if (!message.trim() && inputImages.length === 0)
      throw new ApiError(422, 'validation_error', 'message or images is required');
    // 校验 cwd 确实存在且是一个目录（stat 不存在或不是目录都抛 400）。
    try {
      if (!(await stat(cwd)).isDirectory())
        throw new ApiError(400, 'invalid_workspace', `Workspace does not exist: ${cwd}`);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, 'invalid_workspace', `Workspace does not exist: ${cwd}`);
    }
    // 1) 在注册表中创建会话（内部会调用 Pi SDK 的 createAgentSession）；
    // 2) 下发 type: "prompt" 命令，让模型开始工作。
    const entry = await options.registry.create({
      cwd,
      provider: optionalString(body.provider, 'provider'),
      modelId: optionalString(body.modelId, 'modelId'),
      thinkingLevel: optionalString(body.thinkingLevel, 'thinkingLevel'),
      toolNames: optionalStringArray(body.toolNames),
      systemPrompt: optionalString(body.systemPrompt, 'systemPrompt'),
      compaction: optionalCompaction(body.compaction),
    });
    await options.registry.command(entry.session.sessionId, {
      type: 'prompt',
      message,
      images: inputImages,
    });
    return reply.code(202).send({ success: true, sessionId: entry.session.sessionId });
  });

  // POST /api/agent/:sessionId —— 向已有会话下发命令。
  // 命令类型由 body.type 决定：prompt / steer / follow_up / abort / set_model /
  // set_thinking_level / set_tools / compact / navigate_tree / reload_resources /
  // approve_tool 等（完整实现见 agent-registry.ts 的 command()）。
  // :sessionId 是路径参数，Fastify 通过泛型 <{ Params: { sessionId: string } }>
  // 让 request.params.sessionId 有正确的类型。
  app.post<{ Params: { sessionId: string } }>('/:sessionId', async (request) => {
    const body = objectBody(request.body);
    const inputImages = images(body.images);
    // 文本类命令（prompt / steer / follow_up）要求 message 或图片至少有一个。
    if (
      (body.type === 'prompt' || body.type === 'steer' || body.type === 'follow_up') &&
      (typeof body.message !== 'string' || !body.message.trim()) &&
      inputImages.length === 0
    ) {
      throw new ApiError(422, 'validation_error', 'message or images is required');
    }
    const data = await options.registry.command(request.params.sessionId, {
      ...body,
      images: inputImages,
    });
    return { success: true, data };
  });

  // GET /api/agent/:sessionId —— 打开会话（若未活跃则从磁盘恢复）并返回当前状态。
  app.get<{ Params: { sessionId: string } }>('/:sessionId', async (request) => {
    await options.registry.open(request.params.sessionId);
    const state = options.registry.state(request.params.sessionId);
    return { running: true, state };
  });

  app.get<{ Params: { sessionId: string } }>('/:sessionId/plan', async (request) => {
    await options.registry.open(request.params.sessionId);
    return {
      plan: options.registry.planState(request.params.sessionId),
    };
  });

  // GET /api/agent/:sessionId/events —— SSE 实时事件流。
  //
  // 中文说明：这是本后端与前端交互的核心通道。Vue 用 EventSource 连接此端点，
  // 后端把 Pi SDK 产生的事件（agent_message / agent_state / tool_call_pending 等）
  // 通过注册表的事件缓存 + 订阅机制推送给前端。支持断线续传：
  // 请求头 Last-Event-ID 告诉服务端"我收到了第 N 条"，服务端从 N 之后补发。
  app.get<{ Params: { sessionId: string } }>('/:sessionId/events', async (request, reply) => {
    const lastEventId = Number(request.headers['last-event-id'] ?? 0);
    if (!Number.isInteger(lastEventId) || lastEventId < 0) {
      throw new ApiError(400, 'invalid_event_id', 'Last-Event-ID must be a non-negative integer');
    }
    // 确保会话已打开（可能从磁盘恢复），否则无法订阅到它的事件。
    await options.registry.open(request.params.sessionId);

    // reply.hijack()：告诉 Fastify"这个响应我们自己接管"。
    // 之后不再用 reply.send()，而是直接操作 reply.raw（Node 原生响应对象），
    // 这样连接可以保持打开，随时写入新的 SSE 帧。
    reply.hijack();
    reply.raw.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      // hijack + writeHead 会绕过 @fastify/cors 自动添加的响应头，SSE 需要手动补 CORS。
      // （EventSource 是"简单请求"，不会触发预检，这个头即可放行跨域流。）
      'Access-Control-Allow-Origin': '*',
    });
    // 订阅注册表的事件流：subscribe() 会先补发 lastEventId 之后的历史事件（断线重连），
    // 然后持续把新事件写入连接；返回的 unsubscribe 用于断开时取消订阅。
    const unsubscribe = options.registry.subscribe(request.params.sessionId, lastEventId, (event) =>
      sendSse(reply, event),
    );
    // 心跳：每 15 秒写一条注释帧，防止代理/浏览器因"长时间无数据"判定连接超时。
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    // 客户端断开（关闭页面/网络中断）时，Node 会在 request.raw 上触发 "close" 事件。
    // 这里做清理：停心跳、取消订阅、结束响应，避免资源泄漏。
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });
};
