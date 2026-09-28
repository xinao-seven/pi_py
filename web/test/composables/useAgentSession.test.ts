/**
 * useAgentSession 的 SSE → 状态回归测试。
 *
 * 中文说明：这里只测「后端推来的事件有没有真的写进前端流式状态」这一条链路，
 * 因为真实缺陷正是它断在中间：`assignStream` 逐个字段手写拷贝、漏掉 `pendingQuestion`，
 * 于是 `question_pending` 被静默丢弃——模型挂起等回答，前端却永远不弹窗
 * （只有刷新页面走 `pendingQuestion` 状态快照才看得到）。
 * 断言的是 ChatWindow 里 `v-if="pendingQuestion"` 读的那个字段，所以组件层不必再重测一遍。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';

import { useAgentSession } from '@/composables/useAgentSession';
import { messageText } from '@/lib/agent-events';
import type { SessionPreset } from '@/types';

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

/** 内置「极简（原版 pi）」预设（与后端 /api/presets 返回的形状一致）。 */
function minimalPreset(): SessionPreset {
  return {
    id: 'minimal',
    name: '极简（原版 pi）',
    builtin: true,
    systemPrompt: '',
    toolNames: null,
    compaction: null,
    capabilities: {
      plan: false,
      approval: false,
      questions: false,
      subagent: false,
      tasks: false,
      observability: false,
      fileExtensions: false,
    },
    provider: '',
    modelId: '',
    thinkingLevel: '',
    mcpServers: [],
  };
}

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

function mountHost(sessionId: string | null = SESSION_ID) {
  let session: ReturnType<typeof useAgentSession> | undefined;
  const wrapper = mount(
    defineComponent({
      setup() {
        session = useAgentSession({
          sessionId: ref(sessionId),
          newSessionCwd: ref('/tmp/workspace'),
        });
        return () => null;
      },
    }),
  );
  return { wrapper, session: session! };
}

/** 各用例共用的接口默认返回值（真实前端的常规路径：running + isStreaming）。 */
function mockApiDefaults(): void {
  api.getSession.mockResolvedValue({
    session: { id: SESSION_ID },
    context: { messages: [], entryIds: [] },
  });
  api.getPlan.mockResolvedValue({ plan: null });
  api.listTasks.mockResolvedValue([]);
  api.getTaskRecovery.mockResolvedValue([]);
  api.getModels.mockResolvedValue({ models: [], defaultModel: null });
  api.getPresets.mockResolvedValue([]);
  api.getAgentState.mockResolvedValue({ running: true, state: { isStreaming: true } });
}

describe('useAgentSession 的提问通道状态', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiDefaults();
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

/**
 * 流式增量合并：SDK 每个 token 发一条带**整条消息快照**的 message_update，
 * 前端必须按帧合并成一次渲染，否则长回复会把主线程压成「页面卡死」。
 */
describe('useAgentSession 的流式增量合并', () => {
  const frames: Array<() => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiDefaults();
    frames.length = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function assistantUpdate(text: string) {
    return {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    };
  }

  it('coalesces per-token message_update into one render per frame', async () => {
    const sse = controllableStream();
    api.fetchAgentEvents.mockResolvedValue({ ok: true, body: sse.stream });

    const { wrapper, session } = mountHost();
    await vi.waitFor(() => expect(api.fetchAgentEvents).toHaveBeenCalled());

    sse.push(assistantUpdate('a'));
    sse.push(assistantUpdate('ab'));
    sse.push(assistantUpdate('abc'));

    // 三条增量只调度一次帧，且在帧回调跑之前不写进响应式状态。
    await vi.waitFor(() => expect(frames.length).toBe(1));
    expect(session.stream.streamingMessage).toBeNull();

    frames.shift()!();
    await vi.waitFor(() => {
      const message = session.stream.streamingMessage;
      expect(message && messageText(message)).toBe('abc');
    });

    sse.close();
    wrapper.unmount();
  });

  it('flushes the pending update before applying message_end', async () => {
    const sse = controllableStream();
    api.fetchAgentEvents.mockResolvedValue({ ok: true, body: sse.stream });

    const { wrapper, session } = mountHost();
    await vi.waitFor(() => expect(api.fetchAgentEvents).toHaveBeenCalled());

    sse.push(assistantUpdate('partial'));
    // 帧还没跑就来 message_end：必须先落地挂起增量、再由 message_end 清空，顺序不能反。
    sse.push({
      type: 'message_end',
      entryId: 'entry-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    });

    await vi.waitFor(() => expect(session.messages.value).toHaveLength(1));
    expect(session.stream.streamingMessage).toBeNull();
    expect(messageText(session.messages.value[0]!)).toBe('done');

    sse.close();
    wrapper.unmount();
  });
});

describe('useAgentSession 的预设能力透传', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiDefaults();
    // 新建会话成功后要接事件流：给一个可控流，避免 connectEvents 炸掉。
    const sse = controllableStream();
    api.fetchAgentEvents.mockResolvedValue({ ok: true, body: sse.stream });
    api.createAgent.mockResolvedValue({
      sessionId: SESSION_ID,
      capabilities: {
        plan: false,
        approval: false,
        questions: false,
        subagent: false,
        tasks: false,
        observability: false,
        fileExtensions: false,
        mcp: false,
      },
    });
  });

  it('把极简预设映射成 extensions，并在 null 模式下省略 toolNames/compaction', async () => {
    const { session } = mountHost(null);
    await flushPromises();

    const minimal: SessionPreset = minimalPreset();
    session.applyPreset(minimal);

    await session.send('你好');

    const payload = api.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.extensions).toEqual({
      planMode: false,
      approval: false,
      questions: false,
      subagents: false,
      tasks: false,
      observability: false,
      fileExtensions: false,
    });
    expect(payload.mcpServers).toEqual([]);
    // null = 不限制白名单 / 不覆盖设置：请求里干脆不带这两个字段。
    expect(payload).not.toHaveProperty('toolNames');
    expect(payload).not.toHaveProperty('compaction');
    // 能力位写进状态：面板据此隐藏。
    expect(session.sessionCapabilities.value).toMatchObject({ tasks: false, mcp: false });
  });

  it('默认能力全开时也发一份 extensions（显式优于隐式）', async () => {
    const { session } = mountHost(null);
    await flushPromises();

    await session.send('你好');

    const payload = api.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.extensions).toEqual({
      planMode: true,
      approval: true,
      questions: true,
      subagents: true,
      tasks: true,
      observability: true,
      fileExtensions: true,
    });
    expect(payload.toolNames).toEqual(['read', 'bash', 'edit', 'write']);
  });
});

/**
 * 预设状态是**用户级意图**，不能被「会话 id 变了」这件事清掉。
 *
 * 中文说明：缺陷现场是发完第一条消息后预设被重置（下拉框自己跳回 Coding Agent（默认）、
 * capabilities/mcpServers 回默认），下一条新会话就静默变成全开。这里用与 App.vue 同构的
 * 接线（`onSessionCreated` 把 id 写回 store）复现，断言预设活过创建那一刻。
 */
describe('useAgentSession 的预设状态不被会话切换清掉', () => {
  /** 与 App.vue 同构：创建成功后把 sessionId 写回（store.selectSession）→ 触发 watcher。 */
  function mountWired(initial: string | null = null) {
    const sessionId = ref<string | null>(initial);
    let session: ReturnType<typeof useAgentSession> | undefined;
    const wrapper = mount(
      defineComponent({
        setup() {
          session = useAgentSession({
            sessionId,
            newSessionCwd: ref('/tmp/workspace'),
            onSessionCreated: (id) => {
              sessionId.value = id;
            },
          });
          return () => null;
        },
      }),
    );
    return { wrapper, session: session!, sessionId };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiDefaults();
    // 预设列表是真实 UI 的前置条件（restorePresetForNewSession 按选中预设重建）。
    api.getPresets.mockResolvedValue([minimalPreset()]);
    // running + isStreaming：loadSession 不会用状态快照覆盖 activeTools（保持预设给的值）。
    api.getAgentState.mockResolvedValue({ running: true, state: { isStreaming: true } });
    const sse = controllableStream();
    api.fetchAgentEvents.mockResolvedValue({ ok: true, body: sse.stream });
    api.createAgent.mockResolvedValue({
      sessionId: SESSION_ID,
      capabilities: {
        plan: false,
        approval: false,
        questions: false,
        subagent: false,
        tasks: false,
        observability: false,
        fileExtensions: false,
        mcp: false,
      },
    });
  });

  it('创建会话后预设仍是用户选的那个（不再跳回 coding-agent）', async () => {
    const { wrapper, session } = mountWired();
    await flushPromises();

    session.applyPreset(minimalPreset());
    await session.send('你好');
    await flushPromises();

    expect(session.selectedPreset.value).toBe('minimal');
    expect(session.activeTools.value).toBeNull();
    expect(session.sessionCapabilities.value).toMatchObject({ tasks: false, mcp: false });
    wrapper.unmount();
  });

  it('紧接着新建下一条会话仍沿用极简预设（extensions 全 false + mcpServers: []）', async () => {
    const { wrapper, session, sessionId } = mountWired();
    await flushPromises();

    session.applyPreset(minimalPreset());
    await session.send('第一条');
    await flushPromises();

    // 点「新建会话」：回到新会话模式（sessionId 变 null）→ watcher 触发，但预设不能被清。
    sessionId.value = null;
    await flushPromises();
    expect(session.selectedPreset.value).toBe('minimal');

    await session.send('第二条');
    await flushPromises();

    const payload = api.createAgent.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(payload.extensions).toEqual({
      planMode: false,
      approval: false,
      questions: false,
      subagents: false,
      tasks: false,
      observability: false,
      fileExtensions: false,
    });
    expect(payload.mcpServers).toEqual([]);
    // 极简预设 = 不限制工具白名单，不能因为切换会话而变成四个内置工具的显式白名单。
    expect(payload).not.toHaveProperty('toolNames');
    wrapper.unmount();
  });

  it('切到别的历史会话时仍然清掉会话级状态（activeTools / sessionCapabilities）', async () => {
    const { wrapper, session, sessionId } = mountWired(SESSION_ID);
    await flushPromises();
    expect(session.sessionCapabilities.value).toBeNull();

    sessionId.value = 'session-2';
    await flushPromises();

    expect(session.activeTools.value).toEqual(['read', 'bash', 'edit', 'write']);
    expect(session.sessionCapabilities.value).toBeNull();
    wrapper.unmount();
  });

  it('从状态接口读回能力位（刷新页面后仍知道这是极简会话）', async () => {
    api.getAgentState.mockResolvedValue({
      running: false,
      state: { isStreaming: false },
      capabilities: {
        plan: false,
        approval: false,
        questions: false,
        subagent: false,
        tasks: false,
        observability: false,
        fileExtensions: false,
        mcp: false,
      },
    });
    const { wrapper, session } = mountWired(SESSION_ID);
    await flushPromises();

    expect(session.sessionCapabilities.value).toEqual({
      plan: false,
      approval: false,
      questions: false,
      subagent: false,
      tasks: false,
      observability: false,
      fileExtensions: false,
      mcp: false,
    });
    wrapper.unmount();
  });
});
