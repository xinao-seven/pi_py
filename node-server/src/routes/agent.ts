/** Agent HTTP and SSE routes.
 *
 * 中文说明：实现现有 Vue 所需的最小 Agent 协议：创建、命令、状态和 SSE 事件流。
 */

import type { FastifyPluginAsync } from "fastify";
import { stat } from "node:fs/promises";

import { AgentRegistry, type ImageAttachment, type StreamEvent } from "../services/agent-registry.js";
import { ApiError } from "../errors.js";

export interface AgentRouteOptions {
  registry: AgentRegistry;
}

interface NewAgentBody {
  cwd?: unknown;
  message?: unknown;
  provider?: unknown;
  modelId?: unknown;
  thinkingLevel?: unknown;
  toolNames?: unknown;
  images?: unknown;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "validation_error", "Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ApiError(422, "validation_error", `${field} must be a string`);
  return value;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ApiError(422, "validation_error", "toolNames must be an array of strings");
  }
  return value;
}

function images(value: unknown): ImageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) {
    throw new ApiError(422, "validation_error", "images must contain at most 4 items");
  }
  return value.map((value) => {
    if (value === null || typeof value !== "object") {
      throw new ApiError(422, "validation_error", "images must contain image content blocks");
    }
    const image = value as Partial<ImageAttachment>;
    if (image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) {
      throw new ApiError(422, "validation_error", "images must contain valid image content blocks");
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length % 4 !== 0) {
      throw new ApiError(422, "validation_error", "image data must be valid base64");
    }
    const decoded = Buffer.from(image.data, "base64");
    if (decoded.length > 5 * 1024 * 1024) {
      throw new ApiError(422, "validation_error", "image exceeds 5 MB");
    }
    return { type: "image", data: image.data, mimeType: image.mimeType };
  });
}

function sendSse(reply: { raw: NodeJS.WritableStream & { write(chunk: string): boolean; end(): void }; hijack(): void }, event: StreamEvent): void {
  reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event.payload)}\n\n`);
}

export const agentRoutes: FastifyPluginAsync<AgentRouteOptions> = async (app, options) => {
  app.post("/new", async (request, reply) => {
    const body = objectBody(request.body) as NewAgentBody;
    const cwd = optionalString(body.cwd, "cwd");
    const message = optionalString(body.message, "message") ?? "";
    const inputImages = images(body.images);
    if (!cwd) throw new ApiError(422, "validation_error", "cwd is required");
    if (!message.trim() && inputImages.length === 0) throw new ApiError(422, "validation_error", "message or images is required");
    try {
      if (!(await stat(cwd)).isDirectory()) throw new ApiError(400, "invalid_workspace", `Workspace does not exist: ${cwd}`);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "invalid_workspace", `Workspace does not exist: ${cwd}`);
    }
    const entry = await options.registry.create({
      cwd,
      provider: optionalString(body.provider, "provider"),
      modelId: optionalString(body.modelId, "modelId"),
      thinkingLevel: optionalString(body.thinkingLevel, "thinkingLevel"),
      toolNames: optionalStringArray(body.toolNames),
    });
    await options.registry.command(entry.session.sessionId, { type: "prompt", message, images: inputImages });
    return reply.code(202).send({ success: true, sessionId: entry.session.sessionId });
  });

  app.post<{ Params: { sessionId: string } }>("/:sessionId", async (request) => {
    const body = objectBody(request.body);
    const inputImages = images(body.images);
    if ((body.type === "prompt" || body.type === "steer" || body.type === "follow_up")
      && (typeof body.message !== "string" || !body.message.trim()) && inputImages.length === 0) {
      throw new ApiError(422, "validation_error", "message or images is required");
    }
    const data = await options.registry.command(request.params.sessionId, { ...body, images: inputImages });
    return { success: true, data };
  });

  app.get<{ Params: { sessionId: string } }>("/:sessionId", async (request) => {
    await options.registry.open(request.params.sessionId);
    const state = options.registry.state(request.params.sessionId);
    return { running: true, state };
  });

  app.get<{ Params: { sessionId: string } }>("/:sessionId/events", async (request, reply) => {
    const lastEventId = Number(request.headers["last-event-id"] ?? 0);
    if (!Number.isInteger(lastEventId) || lastEventId < 0) {
      throw new ApiError(400, "invalid_event_id", "Last-Event-ID must be a non-negative integer");
    }
    await options.registry.open(request.params.sessionId);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      // hijack + writeHead 会绕过 @fastify/cors 的响应头，SSE 需手动补 CORS
      // （EventSource 为简单请求，无预检，此头即可放行跨域流）。
      "Access-Control-Allow-Origin": "*",
    });
    const unsubscribe = options.registry.subscribe(request.params.sessionId, lastEventId, (event) => sendSse(reply, event));
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });
};
