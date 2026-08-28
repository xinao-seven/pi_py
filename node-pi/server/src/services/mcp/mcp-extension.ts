/**
 * MCP 内联扩展工厂。
 *
 * 中文说明：内联扩展在服务端模块图里创建、不走 jiti，因此闭包可直接引用 McpService
 * 与 ToolApprovalBroker 单例 —— 这是让多个会话共享 MCP 连接、且工具 execute() 直达
 * 连接池、审批直接等待 broker 决定的关键。
 *
 * 职责：
 * - 工厂被每个会话的资源加载器调用（会话创建/打开、reload_resources、MCP 配置变更后
 *   reloadResources）时：await service.ensure(cwd)（对账连接）→ 注册当前工具集；
 * - 注册 tool_call 钩子：对 approval: "required" 的 server 的工具，直接调用
 *   broker.requestApproval() 挂起等待 Web 审批（决定/超时/中止/会话取消都会结算）。
 */

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

import type { PendingToolApproval, ToolApprovalBroker } from '../tool-approval.js';
import type { McpService } from './mcp-service.js';

/** 审批等待时长：前端未决定时自动拒绝。 */
const APPROVAL_TIMEOUT_MS = 120_000;

export function buildMcpExtension(
  service: McpService,
  cwd: string,
  approvals?: ToolApprovalBroker,
): InlineExtension {
  return async (pi: ExtensionAPI): Promise<void> => {
    await service.ensure(cwd);
    for (const tool of service.toolsFor(cwd)) {
      pi.registerTool(tool);
    }

    pi.on('tool_call', async (event, ctx) => {
      if (ctx.hasUI) return undefined;
      if (!service.approvalRequired(cwd, event.toolName)) return undefined;
      if (!approvals) return undefined; // 未接入审批中枢（测试/预设关闭）时不拦截
      const pending: PendingToolApproval = {
        sessionId: ctx.sessionManager.getSessionId(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.input as Record<string, unknown>,
        reason: `MCP server 配置为需人工审批，工具 ${event.toolName} 的调用待确认`,
        rule: 'mcp-approval-required',
        risk: 'high',
        category: 'system',
      };
      const approved = await approvals.requestApproval(pending, ctx.signal, APPROVAL_TIMEOUT_MS);
      return approved ? undefined : { block: true, reason: 'MCP tool execution was not approved' };
    });
  };
}
