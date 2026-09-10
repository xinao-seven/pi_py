// Agent 事件状态机与消息文本工具：把后端 SSE 事件规约成前端流式状态。
import type {
  AgentEvent,
  AgentMessage,
  AgentStreamState,
  PendingQuestion,
  PendingToolCall,
} from '@/types';

export const INITIAL_STREAM_STATE: AgentStreamState = {
  running: false,
  phase: 'idle',
  streamingMessage: null,
  error: null,
  pendingToolCall: null,
  pendingQuestion: null,
};

/**
 * 把规约结果完整拷进响应式状态对象。
 * 中文说明：这里必须整对象拷贝，不能逐字段手写——曾经 assignStream 只抄了五个字段、
 * 漏掉 pendingQuestion，导致 SSE 的 question_pending 被静默丢弃：模型挂起等回答、
 * 前端永远不弹窗（只有刷新页面走状态快照才看得到）。字段完整性由 agent-events 测试守住。
 */
export function applyStreamState(
  target: AgentStreamState,
  next: AgentStreamState,
): AgentStreamState {
  return Object.assign(target, next);
}

export function reduceAgentEvent(state: AgentStreamState, event: AgentEvent): AgentStreamState {
  // 事件 -> 状态的规约函数（纯函数，便于测试）：
  // agent_start 进入等待；message_update 显示流式回复；
  // tool_execution_start 进入工具阶段；tool_call_pending 挂起等待人工确认；
  // tool_execution_end / tool_execution_blocked 回到等待；agent_end 回到空闲。
  // 注意：task_updated（M2）与 task_recovery_required（M3）刻意不在这里处理——
  // 任务与恢复清单由 useAgentSession 的独立 ref 维护，不能污染「Agent 在不在跑」的判断。
  // 提问（M4.1）在这里处理：它同样是「Agent 正在等外部输入」的阻塞状态，
  // 与 pendingToolCall 同类，弹窗需要随流式状态一起出现/消失。
  switch (event.type) {
    case 'agent_start':
      return { ...INITIAL_STREAM_STATE, running: true, phase: 'waiting' };
    case 'message_update':
      return event.message?.role === 'assistant'
        ? {
            ...state,
            running: true,
            phase: 'responding',
            streamingMessage: event.message,
            pendingToolCall: null,
          }
        : state;
    case 'message_end':
      return event.message?.role === 'assistant'
        ? { ...state, phase: 'waiting', streamingMessage: null }
        : state;
    case 'tool_execution_start':
      return {
        ...state,
        running: true,
        phase: 'tool',
        streamingMessage: null,
        pendingToolCall: null,
      };
    case 'tool_call_pending':
      return {
        ...state,
        running: true,
        phase: 'tool',
        streamingMessage: null,
        pendingToolCall: {
          toolCallId: String(event.toolCallId ?? ''),
          toolName: String(event.toolName ?? 'bash'),
          reason: String(event.reason ?? '危险命令'),
          rule: String(event.rule ?? ''),
          risk:
            event.risk === 'medium' || event.risk === 'high' || event.risk === 'critical'
              ? event.risk
              : 'critical',
          category:
            event.category === 'workspace_write' ||
            event.category === 'dependency_change' ||
            event.category === 'network' ||
            event.category === 'git_remote' ||
            event.category === 'destructive' ||
            event.category === 'system'
              ? event.category
              : 'destructive',
          args: (event.args ?? {}) as Record<string, unknown>,
        } satisfies PendingToolCall,
      };
    case 'question_pending':
      return {
        ...state,
        running: true,
        phase: 'tool',
        streamingMessage: null,
        pendingQuestion: normalizeQuestion(event.question),
      };
    case 'question_resolved':
      return state.pendingQuestion === null ? state : { ...state, pendingQuestion: null };
    case 'tool_execution_end':
      return { ...state, phase: 'waiting', pendingToolCall: null };
    case 'tool_execution_blocked':
      return { ...state, phase: 'waiting', pendingToolCall: null };
    case 'agent_end':
      return {
        running: false,
        phase: 'idle',
        streamingMessage: null,
        error: typeof event.error === 'string' && event.error ? event.error : null,
        pendingToolCall: null,
        // 提问与工具审批一样是「外部输入」：run 结束时一并清掉，避免留下过期的弹窗。
        pendingQuestion: null,
      };
    default:
      return state;
  }
}

/** 把 SSE 载荷收敛成前端可安全渲染的形状（缺字段时给保守默认值）。 */
export function normalizeQuestion(value: unknown): PendingQuestion | null {
  const raw = value as Partial<PendingQuestion> | undefined;
  if (!raw || typeof raw.questionId !== 'string' || !Array.isArray(raw.questions)) return null;
  const questions = raw.questions
    .filter((item) => item && typeof item.question === 'string')
    .map((item, index) => ({
      id: typeof item.id === 'string' && item.id ? item.id : `q${index + 1}`,
      question: item.question,
      ...(Array.isArray(item.options) ? { options: item.options.map(String) } : {}),
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
      ...(item.allowFreeText === false ? { allowFreeText: false } : {}),
      ...(typeof item.details === 'string' ? { details: item.details } : {}),
    }));
  if (questions.length === 0) return null;
  return {
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    questionId: raw.questionId,
    toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : '',
    questions,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
}

export function messageText(message: AgentMessage): string {
  // 提取消息的纯文本（拼接全部 text 内容块），用于预览与搜索
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return '';
  }
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}
