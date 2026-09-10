/**
 * useAgentSession 的 SSE → 状态回归测试。
 *
 * 中文说明：这里只测「后端推来的事件有没有真的写进前端流式状态」这一条链路，
 * 因为真实缺陷正是它断在中间：`assignStream` 逐个字段手写拷贝、漏掉 `pendingQuestion`，
 * 于是 `question_pending` 被静默丢弃——模型挂起等回答，前端却永远不弹窗
 * （只有刷新页面走 `pendingQuestion` 状态快照才看得到）。
 * 断言的是 ChatWindow 里 `v-if="pendingQuestion"` 读的那个字段，所以组件层不必再重测一遍。
 */
import { mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';

import { useAgentSession } from '@/composables/useAgentSession';

const api = vi.hoisted(() => ({
  createAgent: vi.fn(),
  fetchAgentEvents: vi.fn(),
  getAgentState: vi.fn(),
  getModels: vi.fn(),
  getPlan: vi.fn(),
  getPresets: vi.fn(),
  getSession: vi.fn(),
  getTaskRecovery: vi.fn(),
  listTasks: vi.fn(),
  sendAgentCommand: vi.fn(),
  fireUnauthorized: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  createAgent: api.createAgent,
  fetchAgentEvents: api.fetchAgentEvents,
  getAgentState: api.getAgentState,
  getModels: api.getModels,
  getPlan: api.getPlan,
  getPresets: api.getPresets,
  getSession: api.getSession,
  getTaskRecovery: api.getTaskRecovery,
  listTasks: api.listTasks,
  sendAgentCommand: api.sendAgentCommand,
}));

vi.mock('@/lib/session', () => ({ fireUnauthorized: api.fireUnauthorized }));

const SESSION_ID = 'session-1';

/** 可控 SSE 流：测试自己决定什么时候推哪一帧。 */
function controllableStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (payload: unknown) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  });
  return {
    stream,
    push: (payload) => controller?.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)),
    close: () => {
      try {
        controller?.close();
      } catch {
        // 已经关闭：忽略（测试收尾时会重复调用）。
      }
    },
  };
}

const PENDING_QUESTION = {
  sessionId: SESSION_ID,
  questionId: 'question-1',
  toolCallId: 'call-1',
  createdAt: '2026-08-21T10:00:00.000Z',
  questions: [{ id: 'q1', question: '继续吗？', options: ['继续', '停'] }],
};

function mountHost() {
  let session: ReturnType<typeof useAgentSession> | undefined;
  const wrapper = mount(
    defineComponent({
      setup() {
        session = useAgentSession({
          sessionId: ref(SESSION_ID),
          newSessionCwd: ref('/tmp/workspace'),
        });
        return () => null;
      },
    }),
  );
  return { wrapper, session: session! };
}

describe('useAgentSession 的提问通道状态', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getSession.mockResolvedValue({
      session: { id: SESSION_ID },
      context: { messages: [], entryIds: [] },
    });
    api.getPlan.mockResolvedValue({ plan: null });
    api.listTasks.mockResolvedValue([]);
    api.getTaskRecovery.mockResolvedValue([]);
    api.getModels.mockResolvedValue({ models: [], defaultModel: null });
    api.getPresets.mockResolvedValue([]);
    // running + isStreaming：loadSession 据此建立 SSE 连接（真实前端的常规路径）。
    api.getAgentState.mockResolvedValue({ running: true, state: { isStreaming: true } });
  });

  it('shows the dialog when question_pending arrives over SSE', async () => {
    const sse = controllableStream();
    api.fetchAgentEvents.mockResolvedValue({ ok: true, body: sse.stream });

    const { wrapper, session } = mountHost();
    await vi.waitFor(() => expect(api.fetchAgentEvents).toHaveBeenCalled());

    sse.push({ type: 'question_pending', question: PENDING_QUESTION });
    await vi.waitFor(() => expect(session.stream.pendingQuestion).not.toBeNull());
    expect(session.stream.pendingQuestion?.questionId).toBe('question-1');
    expect(session.stream.pendingQuestion?.questions[0]?.options).toEqual(['继续', '停']);
    // 与工具审批同类：Agent 正在等外部输入，仍算「运行中」。
    expect(session.stream).toMatchObject({ running: true, phase: 'tool' });

    sse.push({ type: 'question_resolved', questionId: 'question-1' });
    await vi.waitFor(() => expect(session.stream.pendingQuestion).toBeNull());

    sse.close();
    wrapper.unmount();
  });

  it('keeps the dialog absent when the run ends', async () => {
    const sse = controllableStream();
    api.fetchAgentEvents.mockResolvedValue({ ok: true, body: sse.stream });

    const { wrapper, session } = mountHost();
    await vi.waitFor(() => expect(api.fetchAgentEvents).toHaveBeenCalled());

    sse.push({ type: 'question_pending', question: PENDING_QUESTION });
    await vi.waitFor(() => expect(session.stream.pendingQuestion).not.toBeNull());

    sse.push({ type: 'agent_end', error: null });
    await vi.waitFor(() => expect(session.stream.pendingQuestion).toBeNull());

    sse.close();
    wrapper.unmount();
  });
});
