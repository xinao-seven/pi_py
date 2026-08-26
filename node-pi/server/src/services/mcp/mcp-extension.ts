/**
 * MCP 内联扩展工厂。
 *
 * 中文说明：与文件扩展（jiti 隔离）不同，内联扩展在服务端模块图里创建、不走 jiti，
 * 因此闭包可直接引用 McpService 单例 —— 这是让多个会话共享 MCP 连接、且工具
 * execute() 直达连接池的关键。
 *
 * 职责：
 * - 工厂被每个会话的资源加载器调用（会话创建/打开、reload_resources、MCP 配置变更后
 *   reloadResources）时：await service.ensure(cwd)（对账连接）→ 注册当前工具集；
 * - 注册 tool_call 钩子：对 approval: "required" 的 server 的工具，复用 tool-approval
 *   的事件通道契约（pi:tool_approval:pending/decide/aborted）挂起等待 Web 审批。
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

import { CHANNEL_ABORTED, CHANNEL_DECIDE, CHANNEL_PENDING, type PendingToolApproval } from "../tool-approval.js";
import type { McpService } from "./mcp-service.js";

/** 审批等待时长：前端未决定时自动拒绝。 */
const APPROVAL_TIMEOUT_MS = 120_000;

export function buildMcpExtension(service: McpService, cwd: string): InlineExtension {
  return async (pi: ExtensionAPI): Promise<void> => {
    await service.ensure(cwd);
    for (const tool of service.toolsFor(cwd)) {
      pi.registerTool(tool);
    }

    const waiting = new Set<string>();
    pi.on("tool_call", async (event, ctx) => {
      if (ctx.hasUI) return undefined;
      if (!service.approvalRequired(cwd, event.toolName)) return undefined;
      const pending: PendingToolApproval = {
        sessionId: ctx.sessionManager.getSessionId(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.input as Record<string, unknown>,
        reason: `MCP server 配置为需人工审批，工具 ${event.toolName} 的调用待确认`,
        rule: "mcp-approval-required",
        risk: "high",
        category: "system",
      };
      const key = `${pending.sessionId}:${pending.toolCallId}`;
      if (waiting.has(key)) return { block: true, reason: "Duplicate MCP tool approval request" };
      waiting.add(key);
      const approved = await new Promise<boolean>((resolve) => {
        let off: () => void = () => undefined;
        let timer: NodeJS.Timeout | undefined;
        const cleanup = () => {
          off();
          ctx.signal?.removeEventListener("abort", abort);
          if (timer) clearTimeout(timer);
          waiting.delete(key);
        };
        const settle = (value: boolean) => { cleanup(); resolve(value); };
        const abort = () => {
          pi.events.emit(CHANNEL_ABORTED, { sessionId: pending.sessionId, toolCallId: pending.toolCallId });
          settle(false);
        };
        off = pi.events.on(CHANNEL_DECIDE, (value) => {
          const decision = value as { sessionId?: string; toolCallId?: string; approved?: boolean };
          if (decision.sessionId === pending.sessionId && decision.toolCallId === pending.toolCallId) {
            settle(decision.approved === true);
          }
        });
        ctx.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS);
        pi.events.emit(CHANNEL_PENDING, pending);
      });
      return approved ? undefined : { block: true, reason: "MCP tool execution was not approved" };
    });
  };
}
