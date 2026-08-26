// Agent 会话核心组合函数：管理消息列表、SSE 事件流、模型/思考/工具配置，
// 以及发送/中止/压缩/分支导航等全部会话操作。
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { Ref } from 'vue';

import {
  agentEventsUrl,
  createAgent,
  getAgentState,
  getModels,
  getPlan,
  getSession,
  sendAgentCommand,
} from '@/lib/api';
import { INITIAL_STREAM_STATE, reduceAgentEvent } from '@/lib/agent-events';
import type {
  AgentEvent,
  AgentMessage,
  AgentStreamState,
  AttachedImage,
  ContextUsage,
  ModelCatalog,
  ModelRef,
  PlanSnapshot,
  RetryInfo,
  SessionDetail,
} from '@/types';

const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write'];
// 默认激活的工具集合（与后端默认一致）

interface AgentSessionOptions {
  sessionId: Ref<string | null>;
  newSessionCwd: Ref<string | null>;
  onSessionCreated?: (sessionId: string) => void;
  onAgentEnd?: () => void;
  modelsRevision?: Ref<number>;
}

export function useAgentSession(options: AgentSessionOptions) {
  // 会话状态：当前会话 id、详情、消息与 entryIds（SSE 去重）
  const activeSessionId = ref<string | null>(options.sessionId.value);
  const detail = ref<SessionDetail | null>(null);
  const messages = ref<AgentMessage[]>([]);
  const entryIds = ref<string[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const plan = ref<PlanSnapshot | null>(null);
  const stream = reactive<AgentStreamState>({ ...INITIAL_STREAM_STATE });
  const contextUsage = ref<ContextUsage | null>(null);
  const catalog = ref<ModelCatalog | null>(null);
  const newSessionModel = ref<ModelRef | null>(null);
  const thinkingLevel = ref('off');
  const activeTools = ref<string[]>([...DEFAULT_TOOLS]);
  const compacting = ref(false);
  const compactionError = ref<string | null>(null);
  const retryInfo = ref<RetryInfo | null>(null);
  let eventSource: EventSource | null = null;
  let loadSequence = 0;
  let catalogRetryTimer: ReturnType<typeof setInterval> | undefined;
  let pendingSyncTimer: ReturnType<typeof setInterval> | undefined;

  const isNew = computed(
    // 是否处于“新会话”模式（无历史会话且已选工作区）
    () => activeSessionId.value === null && options.newSessionCwd.value !== null,
  );
  const displayModel = computed(
    // 展示用的模型：优先会话上下文里保存的，其次新会话选择的，最后默认模型
    () =>
      detail.value?.context.model ?? newSessionModel.value ?? catalog.value?.defaultModel ?? null,
  );
  const statusLabel = computed(() => {
    // 顶栏状态文案：空闲/生成/工具/等待
    if (!stream.running) return '空闲';
    if (stream.phase === 'responding') return '正在生成回复';
    if (stream.phase === 'tool') return '正在执行工具';
    return '正在等待模型';
  });

  function assignStream(next: AgentStreamState): void {
    stream.running = next.running;
    stream.phase = next.phase;
    stream.streamingMessage = next.streamingMessage;
    stream.error = next.error;
    stream.pendingToolCall = next.pendingToolCall;
  }

  async function loadSession(sessionId: string, showLoading = false): Promise<void> {
    // 加载会话详情与 Agent 状态；用序号防止并发加载时旧结果覆盖新结果
    const sequence = ++loadSequence;
    if (showLoading) loading.value = true;
    try {
      const [nextDetail, state, planSnapshot] = await Promise.all([
        getSession(sessionId),
        getAgentState(sessionId),
        getPlan(sessionId)
          .then((response) => response.plan)
          .catch(() => null),
      ]);
      if (sequence !== loadSequence || activeSessionId.value !== sessionId) return;
      detail.value = nextDetail;
      plan.value = planSnapshot;
      messages.value = nextDetail.context.messages;
      entryIds.value = nextDetail.context.entryIds;
      contextUsage.value = state.state?.contextUsage ?? null;
      thinkingLevel.value = state.state?.thinkingLevel ?? nextDetail.context.thinkingLevel;
      if (state.state?.activeTools) activeTools.value = state.state.activeTools;
      applyPendingToolCall(state.state?.pendingToolCall);
      if (state.running && state.state?.isStreaming) {
        stream.running = true;
        stream.phase = 'waiting';
        connectEvents(sessionId);
      } else {
        assignStream({ ...INITIAL_STREAM_STATE, error: stream.error });
      }
      error.value = null;
    } catch (cause) {
      if (sequence === loadSequence) {
        error.value = errorMessage(cause);
      }
    } finally {
      if (sequence === loadSequence) loading.value = false;
    }
  }

  function connectEvents(sessionId: string): void {
    // 建立 SSE 连接；收到事件交给 handleAgentEvent 处理
    if (eventSource && activeSessionId.value === sessionId) return;
    closeEvents();
    const source = new EventSource(agentEventsUrl(sessionId));
    eventSource = source;
    startPendingSync(sessionId);
    source.onmessage = (messageEvent) => {
      if (eventSource !== source || activeSessionId.value !== sessionId) return;
      try {
        handleAgentEvent(JSON.parse(messageEvent.data) as AgentEvent, sessionId);
      } catch {
        // Ignore malformed third-party events and keep the stream alive.
      }
    };
    source.onerror = () => {
      if (eventSource === source && stream.running) {
        error.value = '事件流暂时中断，正在自动重连…';
      }
    };
    source.onopen = () => {
      if (eventSource === source && error.value?.includes('自动重连')) {
        error.value = null;
      }
    };
  }

  function closeEvents(): void {
    eventSource?.close();
    eventSource = null;
    stopPendingSync();
  }

  function applyPendingToolCall(pending: AgentStreamState['pendingToolCall'] | undefined): void {
    if (!pending) return;
    stream.pendingToolCall = pending;
    stream.running = true;
    stream.phase = 'tool';
  }

  function startPendingSync(sessionId: string): void {
    if (pendingSyncTimer !== undefined) return;
    pendingSyncTimer = setInterval(() => {
      if (!stream.running) {
        stopPendingSync();
        return;
      }
      void getAgentState(sessionId)
        .then((response) => applyPendingToolCall(response.state?.pendingToolCall))
        .catch(() => undefined);
    }, 1_000);
  }

  function stopPendingSync(): void {
    if (pendingSyncTimer === undefined) return;
    clearInterval(pendingSyncTimer);
    pendingSyncTimer = undefined;
  }

  function handleAgentEvent(event: AgentEvent, sessionId: string): void {
    // 处理一个 SSE 事件：更新流式状态、上下文占用、重试/压缩状态与消息列表
    assignStream(reduceAgentEvent(stream, event));
    if (event.contextUsage !== undefined) contextUsage.value = event.contextUsage ?? null;

    if (event.type === 'plan_updated' && event.plan) {
      plan.value = event.plan as PlanSnapshot;
    } else if (event.type === 'auto_retry_start') {
      retryInfo.value = {
        attempt: event.attempt ?? 0,
        maxAttempts: event.maxAttempts ?? 0,
        errorMessage: event.errorMessage ?? null,
      };
    } else if (event.type === 'auto_retry_end') {
      retryInfo.value = null;
    } else if (event.type === 'compaction_start') {
      compacting.value = true;
      compactionError.value = null;
    } else if (event.type === 'compaction_end') {
      compacting.value = false;
      compactionError.value = typeof event.error === 'string' ? event.error : null;
      if (!event.aborted) void loadSession(sessionId);
    }

    if (event.type === 'message_end' && event.message) {
      // 按 entryId 去重：已存在则原地替换，否则追加到列表末尾
      const existingIndex = event.entryId ? entryIds.value.indexOf(event.entryId) : -1;
      if (existingIndex >= 0) {
        messages.value[existingIndex] = event.message;
      } else {
        messages.value = [...messages.value, event.message];
        entryIds.value = [...entryIds.value, event.entryId ?? ''];
      }
    }

    if (event.type === 'agent_end') {
      // 一轮结束：重新加载会话以同步持久化内容
      stopPendingSync();
      void loadSession(sessionId);
      options.onAgentEnd?.();
    }
  }

  async function send(message: string, images: AttachedImage[] = []): Promise<void> {
    // 发送消息：新会话先创建 Agent，历史会话直接发 prompt 命令
    const text = message.trim();
    if ((!text && images.length === 0) || stream.running) return;
    const imageBlocks = images.map(toImageBlock);
    error.value = null;
    assignStream({
      running: true,
      phase: 'waiting',
      streamingMessage: null,
      error: null,
      pendingToolCall: null,
    });
    try {
      if (activeSessionId.value === null) {
        // 新会话：带模型/思考/工具配置创建 Agent 并连接事件流
        const cwd = options.newSessionCwd.value;
        if (!cwd) throw new Error('请先选择工作区');
        const sessionId = await createAgent({
          cwd,
          message: text,
          provider: displayModel.value?.provider,
          modelId: displayModel.value?.modelId,
          thinkingLevel: thinkingLevel.value,
          toolNames: activeTools.value,
          images: imageBlocks,
        });
        activeSessionId.value = sessionId;
        options.onSessionCreated?.(sessionId);
        await loadSession(sessionId);
        connectEvents(sessionId);
      } else {
        // 历史会话：直接发送 prompt 命令
        const sessionId = activeSessionId.value;
        await sendAgentCommand(sessionId, {
          type: 'prompt',
          message: text,
          images: imageBlocks,
        });
        connectEvents(sessionId);
      }
    } catch (cause) {
      assignStream({
        running: false,
        phase: 'idle',
        streamingMessage: null,
        error: errorMessage(cause),
        pendingToolCall: null,
      });
    }
  }

  async function abort(): Promise<void> {
    // 中止当前运行
    if (!activeSessionId.value || !stream.running) return;
    try {
      await sendAgentCommand(activeSessionId.value, { type: 'abort' });
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }

  async function approveToolCall(approved: boolean): Promise<void> {
    // 危险命令人工确认：对挂起的工具调用给出允许/拒绝
    const pending = stream.pendingToolCall;
    if (!activeSessionId.value || !pending) return;
    try {
      await sendAgentCommand(activeSessionId.value, {
        type: 'approve_tool',
        toolCallId: pending.toolCallId,
        approved,
      });
      // 乐观清除弹窗；后续 tool_execution_end/blocked 事件会再次同步状态
      stream.pendingToolCall = null;
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }

  async function steer(message: string, images: AttachedImage[] = []): Promise<void> {
    // 运行中插入指令（立即参与当前回合）
    await liveTextCommand('steer', message, images);
  }

  async function followUp(message: string, images: AttachedImage[] = []): Promise<void> {
    // 运行中排队消息（当前回合结束后处理）
    await liveTextCommand('follow_up', message, images);
  }

  async function liveTextCommand(
    type: 'steer' | 'follow_up',
    message: string,
    images: AttachedImage[],
  ): Promise<void> {
    // steer/follow_up 共用的发送逻辑：要求会话正在运行
    if (!activeSessionId.value || !stream.running || (!message.trim() && images.length === 0))
      return;
    try {
      await sendAgentCommand(activeSessionId.value, {
        type,
        message: message.trim(),
        images: images.map(toImageBlock),
      });
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }

  async function changeModel(model: ModelRef): Promise<void> {
    // 切换模型：新会话只记录选择，历史会话发 set_model 命令
    if (!activeSessionId.value) {
      newSessionModel.value = model;
      return;
    }
    try {
      await sendAgentCommand(activeSessionId.value, { type: 'set_model', ...model });
      if (detail.value) detail.value.context.model = model;
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }

  async function changeThinkingLevel(level: string): Promise<void> {
    // 切换思考档位
    if (!activeSessionId.value) {
      thinkingLevel.value = level;
      return;
    }
    try {
      await sendAgentCommand(activeSessionId.value, {
        type: 'set_thinking_level',
        thinkingLevel: level,
      });
      thinkingLevel.value = level;
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }

  async function changeTools(toolNames: string[]): Promise<void> {
    // 切换激活工具集合
    if (!activeSessionId.value) {
      activeTools.value = toolNames;
      return;
    }
    try {
      await sendAgentCommand(activeSessionId.value, { type: 'set_tools', toolNames });
      activeTools.value = toolNames;
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }

  async function compact(): Promise<void> {
    // 手动压缩上下文
    if (!activeSessionId.value || stream.running || compacting.value) return;
    compacting.value = true;
    compactionError.value = null;
    try {
      await sendAgentCommand(activeSessionId.value, { type: 'compact' });
      await loadSession(activeSessionId.value);
    } catch (cause) {
      compactionError.value = errorMessage(cause);
    } finally {
      compacting.value = false;
    }
  }

  async function navigateTree(targetId: string): Promise<void> {
    // 会话树导航（切换到指定节点）
    if (!activeSessionId.value || stream.running) return;
    error.value = null;
    await sendAgentCommand(activeSessionId.value, {
      type: 'navigate_tree',
      targetId,
    });
    await loadSession(activeSessionId.value);
  }

  async function reloadSession(): Promise<void> {
    if (activeSessionId.value) await loadSession(activeSessionId.value);
  }

  watch(
    options.sessionId,
    (sessionId) => {
      activeSessionId.value = sessionId;
      closeEvents();
      assignStream({ ...INITIAL_STREAM_STATE });
      detail.value = null;
      plan.value = null;
      messages.value = [];
      entryIds.value = [];
      thinkingLevel.value = 'off';
      activeTools.value = [...DEFAULT_TOOLS];
      retryInfo.value = null;
      compacting.value = false;
      compactionError.value = null;
      error.value = null;
      if (sessionId) void loadSession(sessionId, true);
    },
    { immediate: true },
  );

  watch(options.newSessionCwd, () => {
    if (options.sessionId.value === null) {
      activeSessionId.value = null;
      detail.value = null;
      plan.value = null;
      messages.value = [];
      entryIds.value = [];
      thinkingLevel.value = 'off';
      activeTools.value = [...DEFAULT_TOOLS];
      assignStream({ ...INITIAL_STREAM_STATE });
      error.value = null;
    }
  });

  onMounted(async () => {
    await loadCatalog();
  });

  async function loadCatalog(): Promise<void> {
    // 加载模型目录，为新会话初始化默认模型
    try {
      catalog.value = await getModels();
      newSessionModel.value ??= catalog.value.defaultModel;
      stopCatalogRecovery();
      if (error.value?.includes('模型')) error.value = null;
    } catch (cause) {
      error.value = errorMessage(cause);
      startCatalogRecovery();
    }
  }

  function startCatalogRecovery(): void {
    if (catalogRetryTimer !== undefined) return;
    catalogRetryTimer = setInterval(() => void loadCatalog(), 2_000);
  }

  function stopCatalogRecovery(): void {
    if (catalogRetryTimer === undefined) return;
    clearInterval(catalogRetryTimer);
    catalogRetryTimer = undefined;
  }

  if (options.modelsRevision) watch(options.modelsRevision, loadCatalog);

  onBeforeUnmount(() => {
    closeEvents();
    stopCatalogRecovery();
  });

  return {
    activeSessionId,
    detail,
    messages,
    entryIds,
    loading,
    error,
    plan,
    stream,
    contextUsage,
    catalog,
    thinkingLevel,
    activeTools,
    compacting,
    compactionError,
    retryInfo,
    isNew,
    displayModel,
    statusLabel,
    send,
    abort,
    approveToolCall,
    steer,
    followUp,
    changeModel,
    changeThinkingLevel,
    changeTools,
    compact,
    navigateTree,
    reloadSession,
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : '发生未知错误';
}

function toImageBlock(image: AttachedImage): { type: 'image'; data: string; mimeType: string } {
  return { type: 'image', data: image.data, mimeType: image.mimeType };
}
