/**
 * 持久化 Pi 会话的发现与详情路由。
 *
 * 中文说明：Pi 会把会话以 JSONL 文件的形式持久化在 ~/.pi/agent/sessions/ 下
 * （每行一条消息/条目）。本文件提供：会话列表、详情（含分支树）、
 * fork（从某条消息分支）、merge（把另一会话摘要合并进来）、重命名、删除。
 *
 * Fastify 概念：
 * - app.get("/") 在插件注册了 prefix "/api/sessions" 后，实际对外路径是
 *   GET /api/sessions；
 * - 路径参数 :sessionId 通过泛型 <{ Params: { sessionId: string } }> 约束类型；
 * - 路由内可以放心使用 async/await 与 Promise.all 并发执行；
 * - throw ApiError 会被全局错误处理器转成对应的 HTTP 响应。
 */

import type { FastifyPluginAsync } from "fastify";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

import { AgentRegistry, type PersistedSessionInfo, type RegistryEntry } from "../services/agent-registry.js";
import { ApiError } from "../errors.js";
import { appendMergeSummary, createMergeSummary, type MergeableSessionManager } from "../services/session-merge.js";

/** 插件选项：会话注册表。 */
export interface SessionRouteOptions {
  registry: AgentRegistry;
}

/**
 * 路径归一化：统一分隔符为 "/" 并转小写。
 * 中文说明：Pi 的会话文件按"编码后的 cwd"分目录存放，同一目录在不同会话里
 * 可能写成 C:\a\b 或 c:/a/b 等形式；归一化后才能可靠地比较"父子会话路径"。
 */
function pathKey(path: string | undefined): string | undefined {
  return path?.replaceAll("\\", "/").toLocaleLowerCase();
}

/**
 * 把磁盘上的 PersistedSessionInfo 序列化成前端需要的 JSON 结构。
 * 中文说明：额外把父会话的"路径"翻译成"父会话 id"（通过 parentIds 反向索引），
 * 这样前端不需要理解路径格式，直接用 id 就能组织会话树。
 */
function serializeInfo(
  session: PersistedSessionInfo,
  parentIds: Map<string, string>,
): Record<string, unknown> {
  return {
    id: session.id,
    path: session.path || null,
    cwd: session.cwd,
    name: session.name ?? null,
    created: session.created.toISOString(),
    modified: session.modified.toISOString(),
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
    // 父会话路径 → 父会话 id（找不到则 null）。
    parentSessionId: pathKey(session.parentSessionPath) === undefined
      ? null
      : parentIds.get(pathKey(session.parentSessionPath)!) ?? null,
    parentSessionPath: session.parentSessionPath ?? null,
  };
}

/**
 * 一次性拿到"会话列表 + 路径→id 反向索引"。
 * 中文说明：listSessions() 会合并磁盘上的持久化会话与当前活跃的内存会话，
 * 并标注 active 标志；反向索引用于上面的父会话 id 翻译。
 */
async function sessionIndex(registry: AgentRegistry): Promise<{
  sessions: Array<PersistedSessionInfo & { active: boolean }>;
  parentIds: Map<string, string>;
}> {
  const sessions = await registry.listSessions();
  const parentIds = new Map<string, string>();
  for (const session of sessions) {
    const key = pathKey(session.path);
    if (key) parentIds.set(key, session.id);
  }
  return { sessions, parentIds };
}

/**
 * 为"内存中活跃但还没写盘"的会话构造一份兜底信息。
 * 中文说明：活跃会话可能还没有持久化文件（比如刚创建、事件还在跑），
 * 此时磁盘索引里找不到它，就用内存里的状态拼一个 PersistedSessionInfo。
 */
function fallbackInfo(entry: RegistryEntry): PersistedSessionInfo {
  return {
    id: entry.session.sessionId,
    path: entry.session.sessionManager?.getSessionFile() ?? "",
    cwd: entry.cwd,
    created: entry.createdAt,
    modified: entry.createdAt,
    messageCount: entry.session.messages.length,
    firstMessage: "",
  };
}

/**
 * 删除目标会话，并把它下面所有"子会话"的父指针改指向目标会话的父会话
 * （即"过继"给祖父节点），保证删除后会话树仍然完整。
 *
 * 中文说明：Pi 的会话文件第一行是 JSON 头部，含 parentSession 字段；
 * 这里对每个子会话：读文件 → 改第一行 → 原子写回（先写临时文件再 rename），
 * 最后删除目标会话文件。返回被过继的子会话数量。
 */
async function reparentAndDelete(target: PersistedSessionInfo, sessions: PersistedSessionInfo[]): Promise<number> {
  const targetKey = pathKey(target.path);
  const children = sessions.filter((session) => pathKey(session.parentSessionPath) === targetKey);
  for (const child of children) {
    const content = await readFile(child.path, "utf8");
    const lines = content.split(/\r?\n/);
    if (!lines[0]) throw new ApiError(409, "session_delete_failed", `Session header is missing: ${child.id}`);
    let header: Record<string, unknown>;
    try { header = JSON.parse(lines[0]) as Record<string, unknown>; }
    catch { throw new ApiError(409, "session_delete_failed", `Session header is invalid: ${child.id}`); }
    // 父会话指向目标会话的父会话；目标没有父会话则删除该字段。
    if (target.parentSessionPath) header.parentSession = target.parentSessionPath;
    else delete header.parentSession;
    lines[0] = JSON.stringify(header);
    // 原子写：先写临时文件再 rename，避免写一半崩溃留下损坏文件。
    const temporary = `${child.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, lines.join("\n"), "utf8");
    await rename(temporary, child.path);
  }
  await rm(target.path);
  return children.length;
}

/** 会话路由插件：对外路径都以 /api/sessions 开头。 */
export const sessionRoutes: FastifyPluginAsync<SessionRouteOptions> = async (app, options) => {
  // GET /api/sessions —— 会话列表（持久化 + 活跃，按修改时间倒序）。
  app.get("/", async () => {
    const { sessions, parentIds } = await sessionIndex(options.registry);
    return { sessions: sessions.map((session) => serializeInfo(session, parentIds)) };
  });

  // POST /api/sessions/:sessionId/fork —— 在指定会话的某条消息（leafId）处分叉。
  // 中文说明：Pi 的会话本质是一棵消息树（分支/回退会产生新叶子）。
  // leafId 是树中某条消息的 id，fork 后从那一点继续，得到一个新的持久化会话。
  app.post<{ Params: { sessionId: string } }>("/:sessionId/fork", async (request) => {
    const body = request.body;
    // 校验 body.leafId 是合法的非空字符串。
    if (body === null || typeof body !== "object" || Array.isArray(body)
      || typeof (body as { leafId?: unknown }).leafId !== "string"
      || !(body as { leafId: string }).leafId.trim()) {
      throw new ApiError(422, "validation_error", "leafId is required");
    }
    // 打开源会话（活跃的直接取，未活跃的从磁盘恢复）。
    const source = await options.registry.open(request.params.sessionId);
    const manager = source.session.sessionManager;
    if (manager === undefined) {
      throw new ApiError(409, "fork_unavailable", "Session branching is unavailable for this session");
    }
    // createBranchedSession 是 SessionManager 提供的分叉能力：
    // 复制当前会话到新文件并定位到指定叶子，返回新会话文件路径。
    const filePath = (manager as typeof manager & { createBranchedSession(leafId: string): string | undefined })
      .createBranchedSession((body as { leafId: string }).leafId);
    if (filePath === undefined) {
      throw new ApiError(409, "fork_not_persisted", "The selected branch cannot be persisted");
    }
    // 从新文件打开拿到新会话 id，再查索引拿到它的序列化信息返回给前端。
    const forkedId = SessionManager.open(filePath).getSessionId();
    const { sessions, parentIds } = await sessionIndex(options.registry);
    const forked = sessions.find((session) => session.id === forkedId);
    return {
      ok: true,
      sessionId: forkedId,
      info: serializeInfo(forked ?? {
        ...fallbackInfo(source),
        id: forkedId,
        path: filePath,
      }, parentIds),
    };
  });

  // POST /api/sessions/:sessionId/merge —— 把"源会话"的可合并内容摘要后并入目标会话。
  // 中文说明：两个会话各自积累了不同分支的上下文；merge 不是简单拼接消息，
  // 而是生成一份"可审计的有界摘要"（见 session-merge.ts）追加到目标会话，
  // 让目标会话的模型能"看到"另一个会话的关键内容，又不撑爆上下文。
  app.post<{ Params: { sessionId: string }; Body: { sourceSessionId?: unknown } }>("/:sessionId/merge", async (request) => {
    const sourceSessionId = request.body?.sourceSessionId;
    if (typeof sourceSessionId !== "string" || !sourceSessionId.trim()) {
      throw new ApiError(422, "validation_error", "sourceSessionId is required");
    }
    if (sourceSessionId === request.params.sessionId) {
      throw new ApiError(400, "invalid_merge", "A session cannot be merged into itself");
    }
    // 并发打开两个会话（互不依赖，用 Promise.all 提速）。
    const [target, source] = await Promise.all([
      options.registry.open(request.params.sessionId),
      options.registry.open(sourceSessionId),
    ]);
    // 任一会话正在流式输出时不允许合并（防止写坏会话文件）。
    if (target.session.isStreaming || source.session.isStreaming) {
      throw new ApiError(409, "session_busy", "Stop both sessions before merging");
    }
    const targetManager = target.session.sessionManager as MergeableSessionManager | undefined;
    const sourceManager = source.session.sessionManager as MergeableSessionManager | undefined;
    if (!targetManager || !sourceManager) {
      throw new ApiError(409, "merge_unavailable", "Session merge is unavailable for this session");
    }
    // 生成摘要（源会话里"目标会话没有的条目"的压缩文本）；没有可合并内容则 409。
    const summary = createMergeSummary(sourceManager, targetManager, sourceSessionId);
    if (!summary) throw new ApiError(409, "nothing_to_merge", "Source session has no mergeable content");
    // 把摘要作为一条 custom_message 追加进目标会话，返回新条目的 id。
    const entryId = appendMergeSummary(targetManager, sourceSessionId, summary);
    // 同步内存里 agent 的上下文消息，让模型立即感知新内容。
    options.registry.syncContext(request.params.sessionId);
    return { ok: true, entryId, sourceUniqueEntryCount: summary.sourceUniqueEntryCount, summarizedItemCount: summary.summarizedItemCount };
  });

  // PATCH /api/sessions/:sessionId —— 重命名会话（name 1~200 字符）。
  // 中文说明：名字写入会话文件头部的 JSON（appendSessionInfo 是 SessionManager
  // 提供的能力），不改变消息内容。
  app.patch<{ Params: { sessionId: string }; Body: { name?: unknown } }>("/:sessionId", async (request) => {
    const name = request.body?.name;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 200) {
      throw new ApiError(422, "validation_error", "name must be 1 to 200 characters");
    }
    const entry = await options.registry.open(request.params.sessionId);
    const manager = entry.session.sessionManager as (typeof entry.session.sessionManager & { appendSessionInfo(name: string): string }) | undefined;
    if (!manager) throw new ApiError(409, "rename_unavailable", "Session rename is unavailable for this session");
    manager.appendSessionInfo(name.trim());
    return { ok: true };
  });

  // DELETE /api/sessions/:sessionId —— 删除会话（含子会话过继，见 reparentAndDelete）。
  app.delete<{ Params: { sessionId: string } }>("/:sessionId", async (request) => {
    const { sessions } = await sessionIndex(options.registry);
    const target = sessions.find((session) => session.id === request.params.sessionId);
    if (!target || !target.path) throw new ApiError(404, "session_not_found", `Session ${request.params.sessionId} was not found`);
    // 先从注册表移除活跃会话（停止流式输出、释放资源），再删磁盘文件。
    await options.registry.remove(target.id);
    const reparentedCount = await reparentAndDelete(target, sessions);
    return { ok: true, reparentedCount };
  });

  // GET /api/sessions/:sessionId —— 会话详情：信息 + 分支树 + 叶子 + 上下文。
  // 中文说明：context 里的 messages 是"模型的真实上下文"（含压缩/合并后的内容），
  // 与磁盘上的原始消息可能不同；前端用它在详情页展示模型"看到了什么"。
  app.get<{ Params: { sessionId: string } }>("/:sessionId", async (request) => {
    const [entry, index] = await Promise.all([
      options.registry.open(request.params.sessionId),
      sessionIndex(options.registry),
    ]);
    // 优先用磁盘索引里的持久化信息；其次用 entry 自带的 persisted；都没有就兜底。
    const persisted = index.sessions.find((session) => session.id === entry.session.sessionId)
      ?? entry.persisted
      ?? fallbackInfo(entry);
    const manager = entry.session.sessionManager;
    const context = manager?.buildSessionContext();
    return {
      sessionId: entry.session.sessionId,
      filePath: manager?.getSessionFile() ?? persisted.path ?? null,
      info: serializeInfo(persisted, index.parentIds),
      tree: manager?.getTree() ?? [],      // 消息分支树
      leafId: manager?.getLeafId() ?? null, // 当前叶子消息 id
      context: {
        messages: context?.messages ?? entry.session.messages,
        entryIds: [],
        thinkingLevel: context?.thinkingLevel ?? entry.session.thinkingLevel,
        model: context?.model ?? (entry.session.model === undefined
          ? null
          : { provider: entry.session.model.provider, modelId: entry.session.model.id }),
      },
    };
  });
};
