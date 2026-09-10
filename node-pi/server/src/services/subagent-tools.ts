/**
 * `subagent` 工具（M5）：父会话委派子任务的模型侧入口。
 *
 * 中文说明：工具名沿用官方扩展的 `subagent`——它是**接管**而不是新增（`INLINE_OWNED_EXTENSION_DIRS`
 * 会把用户 `~/.pi/agent/extensions/subagent/` 那个文件扩展在本服务的加载里屏蔽掉，
 * CLI 不受影响）。这样模型在 CLI 与 Web 里学到的是同一个工具名。
 *
 * 与官方扩展的三个刻意差异：
 * 1. **不做 chain/parallel 参数**：一次调用 = 一个子任务；并行由模型在**同一轮里发多个工具调用**
 *    （`executionMode: 'parallel'`）实现，服务端按并发上限排队。少一个参数维度，
 *    也就少一类「参数写错却看起来在跑」的失败。
 * 2. **不回传子会话全文**：只回摘要 + 用量 + 可选的运行轨迹，父会话上下文才是便宜的。
 * 3. **失败是数据不是异常**：子任务失败/超预算/超时都变成工具结果里的状态与原因，
 *    让父会话自己决定重试、换预设还是自己干。
 */

import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type { SubagentPreset } from './subagent-presets.js';
import type { SubagentRequest, SubagentResult } from './subagent-service.js';

/** 工具名（与官方扩展同名；本服务接管）。 */
export const SUBAGENT_TOOL_NAME = 'subagent';
export const SUBAGENT_TOOL_NAMES: readonly string[] = [SUBAGENT_TOOL_NAME];

/** 上传给工具实现的最小能力面（服务实现它，测试可注入假实现）。 */
export interface SubagentToolbox {
  listPresets(cwd: string): SubagentPreset[];
  run(request: SubagentRequest): Promise<SubagentResult>;
  /** 本次调用所在会话的深度（父会话 0）+ 允许的最大深度。 */
  context(): { depth: number; maxDepth: number };
}

const BUDGET_SCHEMA = Type.Object({
  maxTurns: Type.Optional(Type.Number({ description: '最大模型轮数（默认按预设档位）' })),
  maxTokens: Type.Optional(Type.Number({ description: '最大 token 数（输入+输出）' })),
  maxCostUsd: Type.Optional(
    Type.Number({ description: '最大成本（美元；仅当 provider 上报成本时生效）' }),
  ),
  timeoutMs: Type.Optional(Type.Number({ description: '最长运行时间（毫秒）' })),
});

const SUBAGENT_SCHEMA = Type.Object({
  preset: Type.String({
    description: '子 agent 预设名（来自 ~/.pi/agent/agents/*.md 或项目的 .pi/agents/*.md）',
  }),
  task: Type.String({
    description: '完整、自包含的委派说明：目标、要看的范围、期望产出格式。子会话看不到你的上下文。',
  }),
  cwd: Type.Optional(Type.String({ description: '子会话的工作目录（默认当前工作区）' })),
  model: Type.Optional(
    Type.String({ description: '覆盖预设模型（provider/model、裸 id 或 inherit）' }),
  ),
  budget: Type.Optional(BUDGET_SCHEMA),
});

type SubagentParams = {
  preset: string;
  task: string;
  cwd?: string;
  model?: string;
  budget?: { maxTurns?: number; maxTokens?: number; maxCostUsd?: number; timeoutMs?: number };
};

/** 子任务状态的中文说明（工具结果与前端都用它）。 */
function statusLabel(status: SubagentResult['status']): string {
  switch (status) {
    case 'completed':
      return '完成';
    case 'budget_exceeded':
      return '超预算中止';
    case 'timeout':
      return '超时中止';
    case 'aborted':
      return '已取消';
    case 'failed':
      return '失败';
    default:
      return '不可用';
  }
}

/** 把结果渲染成给模型看的文本（摘要优先，其余是元信息）。 */
export function renderSubagentResult(result: SubagentResult): string {
  const lines: string[] = [];
  lines.push(
    `[子任务 ${statusLabel(result.status)}] 预设 ${result.preset}（深度 ${result.depth}）`,
  );
  if (result.model) lines.push(`模型：${result.model.provider}/${result.model.id}`);
  if (result.note) lines.push(`注意：${result.note}`);
  if (result.reason) lines.push(`原因：${result.reason}`);
  lines.push(
    `用量：${result.usage.turns} 轮 / 输入 ${result.usage.inputTokens} / 输出 ${
      result.usage.outputTokens
    } tokens / 成本 $${result.usage.costUsd.toFixed(4)} / 耗时 ${Math.round(
      result.durationMs / 1000,
    )}s`,
  );
  if (result.trajectory.length > 0) {
    const counts = new Map<string, number>();
    for (const item of result.trajectory) counts.set(item.tool, (counts.get(item.tool) ?? 0) + 1);
    lines.push(
      `轨迹：${[...counts.entries()].map(([tool, count]) => `${tool}×${count}`).join(', ')}`,
    );
  }
  lines.push('', result.summary.trim() || '（子会话没有产出文本摘要）');
  if (result.status !== 'completed') {
    lines.push(
      '',
      '提示：子任务没有正常完成。可以缩小任务范围后重试、换一个预设，或自己在主会话里完成。',
    );
  }
  return lines.join('\n');
}

/**
 * 构造 `subagent` 工具。
 * 中文说明：`executionMode: 'parallel'` 是刻意的——模型可以在同一轮发起多个委派，
 * 服务端的并发上限（`maxConcurrent` / `maxPerParent`）负责排队与限流。
 */
export function buildSubagentTools(toolbox: SubagentToolbox): ToolDefinition[] {
  return [
    defineTool({
      name: SUBAGENT_TOOL_NAME,
      label: '委派子任务',
      description:
        '把一件自包含的任务委派给子 agent（独立上下文窗口），拿回摘要而不是整段过程。' +
        '适合「大范围搜代码」「跑测试复核改动」这类会污染主上下文的活；' +
        '子会话看不到你的对话历史，所以 task 必须写全：要做什么、范围、期望产出格式。' +
        '一次调用只管一个子任务；并行请在同一轮里发多个调用。' +
        '子任务失败/超预算/超时会作为结果返回，由你决定重试还是自己处理。',
      promptSnippet: '把自包含的子任务委派给子 agent（独立上下文，只回摘要）',
      promptGuidelines: [
        `委派前先用 subagent 列出可用预设（工具结果里会给出可选预设名）。`,
        '需要大范围检索/复核、且过程不需要留在主上下文时用 subagent；小事自己做，别为委派而委派。',
        'task 要自包含：写清目标、范围、产出格式；子会话看不到当前对话。',
        '子任务返回摘要后，把它当作线索而不是结论：涉及改动的结论要自己核实。',
      ],
      parameters: SUBAGENT_SCHEMA,
      executionMode: 'parallel',
      async execute(_toolCallId, params: SubagentParams, signal, _onUpdate, ctx) {
        const presets = toolbox.listPresets(ctx.cwd);
        if (presets.length === 0) {
          return textResult(
            `没有可用的子 agent 预设：请在 ~/.pi/agent/agents/ 下新建 .md（frontmatter 需要 name / description）。`,
            { status: 'unavailable', presets: [] },
          );
        }
        const { depth, maxDepth } = toolbox.context();
        const { cwd: nextCwd, error } = resolveCwd(params.cwd, ctx.cwd);
        if (error !== undefined) return textResult(error, { status: 'unavailable' });

        const result = await toolbox.run({
          parentSessionId: ctx.sessionManager.getSessionId(),
          cwd: nextCwd,
          preset: params.preset,
          prompt: params.task,
          // 新的子会话深度 = 当前会话深度 + 1。
          depth: depth + 1,
          ...(params.model === undefined ? {} : { model: params.model }),
          ...(params.budget === undefined ? {} : { budget: params.budget }),
          ...(signal === undefined ? {} : { signal }),
        });

        const details: Record<string, unknown> = {
          status: result.status,
          preset: result.preset,
          depth: result.depth,
          subagentSessionId: result.subagentSessionId ?? null,
          runId: result.runId ?? null,
          // 前端约定：ModelRef = { provider, modelId }
          model:
            result.model === undefined
              ? null
              : { provider: result.model.provider, modelId: result.model.id },
          usage: result.usage,
          durationMs: result.durationMs,
          trajectory: result.trajectory,
          ...(result.note === undefined ? {} : { note: result.note }),
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          maxDepth,
        };
        const text = renderSubagentResult(result);
        // 「连子会话都没跑起来」才是错误（抛异常 → SDK 标 isError）；
        // 跑过但失败/超预算/超时属于**结果**：把摘要、用量、轨迹一并交给父会话决策。
        if (result.status === 'unavailable' || result.subagentSessionId === undefined) {
          throw new Error(text);
        }
        return {
          content: [{ type: 'text' as const, text }],
          details,
        };
      },
    }),
  ];
}

/** 子会话的工作目录：默认父会话 cwd；越界（非绝对路径）直接拒绝。 */
function resolveCwd(
  requested: string | undefined,
  fallback: string,
): {
  cwd: string;
  error?: string;
} {
  if (requested === undefined || requested.trim() === '') return { cwd: fallback };
  const value = requested.trim();
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value)) {
    return { cwd: fallback, error: `cwd 必须是绝对路径：${value}` };
  }
  return { cwd: value };
}

function textResult(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: 'text' as const, text }], details };
}
