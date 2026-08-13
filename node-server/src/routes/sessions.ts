/** Persistent original-Pi session discovery and detail routes. */

import type { FastifyPluginAsync } from "fastify";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

import { AgentRegistry, type PersistedSessionInfo, type RegistryEntry } from "../services/agent-registry.js";
import { ApiError } from "../errors.js";
import { appendMergeSummary, createMergeSummary, type MergeableSessionManager } from "../services/session-merge.js";

export interface SessionRouteOptions {
  registry: AgentRegistry;
}

function pathKey(path: string | undefined): string | undefined {
  return path?.replaceAll("\\", "/").toLocaleLowerCase();
}

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
    parentSessionId: pathKey(session.parentSessionPath) === undefined
      ? null
      : parentIds.get(pathKey(session.parentSessionPath)!) ?? null,
    parentSessionPath: session.parentSessionPath ?? null,
  };
}

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
    if (target.parentSessionPath) header.parentSession = target.parentSessionPath;
    else delete header.parentSession;
    lines[0] = JSON.stringify(header);
    const temporary = `${child.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, lines.join("\n"), "utf8");
    await rename(temporary, child.path);
  }
  await rm(target.path);
  return children.length;
}

export const sessionRoutes: FastifyPluginAsync<SessionRouteOptions> = async (app, options) => {
  app.get("/", async () => {
    const { sessions, parentIds } = await sessionIndex(options.registry);
    return { sessions: sessions.map((session) => serializeInfo(session, parentIds)) };
  });

  app.post<{ Params: { sessionId: string } }>("/:sessionId/fork", async (request) => {
    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)
      || typeof (body as { leafId?: unknown }).leafId !== "string"
      || !(body as { leafId: string }).leafId.trim()) {
      throw new ApiError(422, "validation_error", "leafId is required");
    }
    const source = await options.registry.open(request.params.sessionId);
    const manager = source.session.sessionManager;
    if (manager === undefined) {
      throw new ApiError(409, "fork_unavailable", "Session branching is unavailable for this session");
    }
    const filePath = (manager as typeof manager & { createBranchedSession(leafId: string): string | undefined })
      .createBranchedSession((body as { leafId: string }).leafId);
    if (filePath === undefined) {
      throw new ApiError(409, "fork_not_persisted", "The selected branch cannot be persisted");
    }
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

  app.post<{ Params: { sessionId: string }; Body: { sourceSessionId?: unknown } }>("/:sessionId/merge", async (request) => {
    const sourceSessionId = request.body?.sourceSessionId;
    if (typeof sourceSessionId !== "string" || !sourceSessionId.trim()) {
      throw new ApiError(422, "validation_error", "sourceSessionId is required");
    }
    if (sourceSessionId === request.params.sessionId) {
      throw new ApiError(400, "invalid_merge", "A session cannot be merged into itself");
    }
    const [target, source] = await Promise.all([
      options.registry.open(request.params.sessionId),
      options.registry.open(sourceSessionId),
    ]);
    if (target.session.isStreaming || source.session.isStreaming) {
      throw new ApiError(409, "session_busy", "Stop both sessions before merging");
    }
    const targetManager = target.session.sessionManager as MergeableSessionManager | undefined;
    const sourceManager = source.session.sessionManager as MergeableSessionManager | undefined;
    if (!targetManager || !sourceManager) {
      throw new ApiError(409, "merge_unavailable", "Session merge is unavailable for this session");
    }
    const summary = createMergeSummary(sourceManager, targetManager, sourceSessionId);
    if (!summary) throw new ApiError(409, "nothing_to_merge", "Source session has no mergeable content");
    const entryId = appendMergeSummary(targetManager, sourceSessionId, summary);
    options.registry.syncContext(request.params.sessionId);
    return { ok: true, entryId, sourceUniqueEntryCount: summary.sourceUniqueEntryCount, summarizedItemCount: summary.summarizedItemCount };
  });

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

  app.delete<{ Params: { sessionId: string } }>("/:sessionId", async (request) => {
    const { sessions } = await sessionIndex(options.registry);
    const target = sessions.find((session) => session.id === request.params.sessionId);
    if (!target || !target.path) throw new ApiError(404, "session_not_found", `Session ${request.params.sessionId} was not found`);
    await options.registry.remove(target.id);
    const reparentedCount = await reparentAndDelete(target, sessions);
    return { ok: true, reparentedCount };
  });

  app.get<{ Params: { sessionId: string } }>("/:sessionId", async (request) => {
    const [entry, index] = await Promise.all([
      options.registry.open(request.params.sessionId),
      sessionIndex(options.registry),
    ]);
    const persisted = index.sessions.find((session) => session.id === entry.session.sessionId)
      ?? entry.persisted
      ?? fallbackInfo(entry);
    const manager = entry.session.sessionManager;
    const context = manager?.buildSessionContext();
    return {
      sessionId: entry.session.sessionId,
      filePath: manager?.getSessionFile() ?? persisted.path ?? null,
      info: serializeInfo(persisted, index.parentIds),
      tree: manager?.getTree() ?? [],
      leafId: manager?.getLeafId() ?? null,
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
