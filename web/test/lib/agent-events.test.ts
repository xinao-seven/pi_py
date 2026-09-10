import { INITIAL_STREAM_STATE, messageText, normalizeQuestion, reduceAgentEvent } from '@/lib/agent-events';

describe('reduceAgentEvent', () => {
  it('tracks a streaming assistant response through completion', () => {
    const started = reduceAgentEvent(INITIAL_STREAM_STATE, { type: 'agent_start' });
    const streaming = reduceAgentEvent(started, {
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hel' }],
      },
    });
    const ended = reduceAgentEvent(streaming, { type: 'agent_end', error: null });

    expect(streaming.phase).toBe('responding');
    expect(messageText(streaming.streamingMessage!)).toBe('hel');
    expect(ended).toEqual(INITIAL_STREAM_STATE);
  });

  it('preserves a terminal agent error', () => {
    const ended = reduceAgentEvent(INITIAL_STREAM_STATE, {
      type: 'agent_end',
      error: 'provider unavailable',
    });

    expect(ended.error).toBe('provider unavailable');
    expect(ended.running).toBe(false);
  });

  it('shows a pending tool call until approval is resolved', () => {
    const started = reduceAgentEvent(INITIAL_STREAM_STATE, { type: 'agent_start' });
    const pending = reduceAgentEvent(started, {
      type: 'tool_call_pending',
      toolCallId: 'call-1',
      toolName: 'bash',
      reason: '递归/强制删除文件或目录',
      rule: 'recursive-delete',
      risk: 'critical',
      category: 'destructive',
      args: { command: 'rm -rf ./build' },
    });

    expect(pending.phase).toBe('tool');
    expect(pending.pendingToolCall).toEqual({
      toolCallId: 'call-1',
      toolName: 'bash',
      reason: '递归/强制删除文件或目录',
      rule: 'recursive-delete',
      risk: 'critical',
      category: 'destructive',
      args: { command: 'rm -rf ./build' },
    });

    const rejected = reduceAgentEvent(pending, {
      type: 'tool_execution_blocked',
      toolCallId: 'call-1',
    });
    expect(rejected.pendingToolCall).toBeNull();
    expect(rejected.phase).toBe('waiting');
  });

  it('clears pending on execution end and agent end', () => {
    const pending = reduceAgentEvent(INITIAL_STREAM_STATE, {
      type: 'tool_call_pending',
      toolCallId: 'call-1',
      toolName: 'bash',
      reason: '格式化磁盘',
      risk: 'critical',
      category: 'system',
      args: { command: 'format c:' },
    });
    const executed = reduceAgentEvent(pending, {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      isError: false,
    });
    expect(executed.pendingToolCall).toBeNull();

    const again = reduceAgentEvent(INITIAL_STREAM_STATE, {
      type: 'tool_call_pending',
      toolCallId: 'call-2',
      toolName: 'bash',
      reason: '关机',
      risk: 'critical',
      category: 'system',
      args: { command: 'shutdown /s' },
    });
    const ended = reduceAgentEvent(again, { type: 'agent_end', error: null });
    expect(ended.pendingToolCall).toBeNull();
    expect(ended).toEqual(INITIAL_STREAM_STATE);
  });
});

describe('task_updated reduction', () => {
  it('leaves the streaming state untouched (tasks are tracked separately)', () => {
    // 任务状态由 useAgentSession 的 task ref 单独维护（REST + SSE 双通道），
    // 不进流式状态机，避免把「任务变更」误当成「Agent 在跑」。
    const busy = reduceAgentEvent(INITIAL_STREAM_STATE, { type: 'agent_start' });
    const afterTask = reduceAgentEvent(busy, {
      type: 'task_updated',
      task: { id: 'task-1', title: 't', revision: 1 },
    });

    expect(afterTask).toEqual(busy);
  });
});

describe('task_recovery_required reduction', () => {
  it('leaves the streaming state untouched (recovery list is tracked separately)', () => {
    const busy = reduceAgentEvent(INITIAL_STREAM_STATE, { type: 'agent_start' });
    const afterRecovery = reduceAgentEvent(busy, {
      type: 'task_recovery_required',
      tasks: [{ taskId: 'task-1', action: 'auto_resume' }],
    });

    expect(afterRecovery).toEqual(busy);
  });
});

describe('plan_updated（M4：载荷是 PlanView）', () => {
  it('does not touch the streaming state machine (plan lives in its own ref)', () => {
    const before = reduceAgentEvent(INITIAL_STREAM_STATE, { type: 'agent_start' });
    const after = reduceAgentEvent(before, {
      type: 'plan_updated',
      plan: {
        planId: 'task-1',
        taskId: 'task-1',
        sessionId: 'session-1',
        status: 'executing',
        revision: 3,
        title: '重构 Plan 模式',
        goal: 'G',
        steps: [],
        awaitingUserAction: false,
        updatedAt: '2026-08-21T10:00:00.000Z',
      },
    });
    expect(after).toBe(before);
  });
});

describe('question_pending / question_resolved（M4.1 提问通道）', () => {
  function pendingQuestion() {
    return {
      sessionId: 'session-1',
      questionId: 'question-1',
      toolCallId: 'call-1',
      createdAt: '2026-08-21T10:00:00.000Z',
      questions: [
        { id: 'q1', question: '继续吗？', options: ['继续', '停'] },
        { id: 'q2', question: '备注？', multiSelect: true },
      ],
    };
  }

  it('shows the dialog payload while the agent waits for an answer', () => {
    const started = reduceAgentEvent(INITIAL_STREAM_STATE, { type: 'agent_start' });
    const next = reduceAgentEvent(started, {
      type: 'question_pending',
      question: pendingQuestion(),
    });
    expect(next.pendingQuestion).toMatchObject({ questionId: 'question-1' });
    expect(next.pendingQuestion?.questions).toHaveLength(2);
    // 与工具审批同类：说明 Agent 正在等外部输入，仍算「运行中」。
    expect(next).toMatchObject({ running: true, phase: 'tool', pendingToolCall: null });
  });

  it('clears the dialog once the question is resolved (or the run ends)', () => {
    const asked = reduceAgentEvent(INITIAL_STREAM_STATE, {
      type: 'question_pending',
      question: pendingQuestion(),
    });
    expect(reduceAgentEvent(asked, { type: 'question_resolved', questionId: 'question-1' }).pendingQuestion).toBeNull();
    // 没必要的变化不产生新对象（避免无谓重渲染）。
    const cleared = reduceAgentEvent(asked, { type: 'question_resolved' });
    expect(cleared.pendingQuestion).toBeNull();
    expect(
      reduceAgentEvent(cleared, { type: 'question_resolved', questionId: 'question-1' }),
    ).toBe(cleared);
    expect(reduceAgentEvent(asked, { type: 'agent_end' }).pendingQuestion).toBeNull();
  });

  it('normalizes malformed payloads instead of rendering a broken dialog', () => {
    expect(normalizeQuestion(undefined)).toBeNull();
    expect(normalizeQuestion({ questionId: 'q', questions: [] })).toBeNull();
    expect(normalizeQuestion({ questions: [{ question: 'x' }] })).toBeNull();
    expect(
      normalizeQuestion({
        questionId: 'q',
        questions: [{ question: '没有 id', multiSelect: false, allowFreeText: false }],
      }),
    ).toMatchObject({
      sessionId: '',
      toolCallId: '',
      questions: [{ id: 'q1', question: '没有 id', allowFreeText: false }],
    });
  });
});
