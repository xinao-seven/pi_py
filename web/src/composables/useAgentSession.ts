// Agent 会话核心组合函数：管理消息列表、SSE 事件流、模型/思考/工具配置，
// 以及发送/中止/压缩/分支导航等全部会话操作。
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { Ref } from 'vue';

import {
  createAgent,
  fetchAgentEvents,
  getAgentState,
  getModels,
  getPlan,
  getPresets,
  getSession,
  getTaskRecovery,
  listTasks,
  sendAgentCommand,
} from '@/lib/api';
import {
  INITIAL_STREAM_STATE,
  applyStreamState,
  normalizeQuestion,
  reduceAgentEvent,
} from '@/lib/agent-events';
import { fireUnauthorized } from '@/lib/session';
import type {
  AgentEvent,
  AgentMessage,
  AgentStreamState,
  AttachedImage,
  ContextUsage,
  ModelCatalog,
  ModelRef,
  PlanView,
  PresetCompaction,
  PromptMode,
  RetryInfo,
  SessionDetail,
  SessionPreset,
  QuestionAnswer,
  TaskRecord,
  TaskRecoveryItem,
} from '@/types';

const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write'];
// 默认激活的工具集合（与后端默认一致）
const BUILTIN_PRESET_ID = 'coding-agent';

// ---- SSE 断线重连与心跳参数 ----
const RECONNECT_BASE_DELAY_MS = 500; // 首退避 0.5s
const RECONNECT_MAX_DELAY_MS = 10_000; // 退避封顶 10s
const STREAM_IDLE_TIMEOUT_MS = 45_000; // 超过 3 倍心跳间隔（15s）没有数据 = 连接假死
const ACTIVITY_CHECK_INTERVAL_MS = 10_000; // 假死检测轮询间隔

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
  const plan = ref<PlanView | null>(null);
  // 当前会话的任务（M2）：由 REST 首次加载 + SSE task_updated 增量更新。
  const task = ref<TaskRecord | null>(null);
  // 待恢复任务清单（M3）：重启后由 SSE 补推或 REST 拉取，只展示不自动执行。
  const recovery = ref<TaskRecoveryItem[]>([]);
  const stream = reactive<AgentStreamState>({ ...INITIAL_STREAM_STATE });
  const contextUsage = ref<ContextUsage | null>(null);
  const catalog = ref<ModelCatalog | null>(null);
  const newSessionModel = ref<ModelRef | null>(null);
  const thinkingLevel = ref('off');
  const activeTools = ref<string[]>([...DEFAULT_TOOLS]);
  const presets = ref<SessionPreset[]>([]);
  const selectedPreset = ref(BUILTIN_PRESET_ID);
  const presetSystemPrompt = ref('');
  const presetCompaction = ref<PresetCompaction | null>(null);
  const presetMcpServers = ref<string[] | null>(null);
  // 思考等级是否被显式选择过（用户改下拉或预设指定）：为 true 才随创建请求发送，
  // 避免默认的 'off' 占位值把新会话的思考意外关掉（后端现在会把 'off' 透传给 SDK）。
  const thinkingExplicit = ref(false);
  const compacting = ref(false);
  const compactionError = ref<string | null>(null);
  const retryInfo = ref<RetryInfo | null>(null);
  // ---- SSE 事件流（fetch + ReadableStream 手写解析，自建断线重连）----
  // eventStream：当前活跃的流（controller 用于中止，generation 用于竞态防护）；
  // lastEventId：已处理的最新事件序号，重连时作为 Last-Event-ID 请求头续传；
  // reconnectTimer / reconnectAttempt：指数退避重连；activityTimer：心跳假死检测。
  let eventStream: { controller: AbortController; generation: number } | null = null;
  let streamGeneration = 0;
  let lastEventId = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let activityTimer: ReturnType<typeof setInterval> | undefined;
  let lastActivityAt = 0;

  let loadSequence = 0;
  let catalogRetryTimer: ReturnType<typeof setInterval> | undefined;

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
    // 整对象拷贝（不再逐字段手写）：漏一个字段就等于丢一类弹窗，
    // 尤其是 pendingQuestion（提问）与 pendingToolCall（审批）。
    applyStreamState(stream, next);
  }

  /** 重新拉取计划视图（步骤编辑后立即刷新，避免等 SSE 的往返延迟）。 */
  async function refreshPlan(): Promise<void> {
    const sessionId = activeSessionId.value;
    if (sessionId === null) return;
    try {
      const response = await getPlan(sessionId);
      if (activeSessionId.value === sessionId) plan.value = response.plan;
    } catch {
      // 计划是增量信息：拉取失败保留旧视图，等 SSE 校正。
    }
  }

  async function loadSession(sessionId: string, showLoading = false): Promise<void> {
    // 加载会话详情与 Agent 状态；用序号防止并发加载时旧结果覆盖新结果
    const sequence = ++loadSequence;
    if (showLoading) loading.value = true;
    try {
      const [nextDetail, state, planSnapshot, taskRecord, recoveryItems] = await Promise.all([
        getSession(sessionId),
        getAgentState(sessionId),
        getPlan(sessionId)
          .then((response) => response.plan)
          .catch(() => null),
        // 任务面板展示「该会话最新的未取消任务」；没有也照常打开会话。
        listTasks({ sessionId, limit: 20 })
          .then((tasks) => tasks.find((item) => item.status !== 'cancelled') ?? tasks[0] ?? null)
          .catch(() => null),
        // 待恢复清单是全局的，面板只展示与会话相关的那几条。
        getTaskRecovery().catch(() => []),
      ]);
      if (sequence !== loadSequence || activeSessionId.value !== sessionId) return;
      detail.value = nextDetail;
      plan.value = planSnapshot;
      task.value = taskRecord;
      recovery.value = recoveryItems;
      messages.value = nextDetail.context.messages;
      entryIds.value = nextDetail.context.entryIds;
      contextUsage.value = state.state?.contextUsage ?? null;
      // 提问是「Agent 正在等外部输入」的阻塞状态：刷新后必须恢复弹窗，
      // 否则模型会一直等着一个用户看不到的问题（后端挂起队列是唯一真相源）。
      stream.pendingQuestion = normalizeQuestion(state.state?.pendingQuestion) ?? null;
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
    // 建立 SSE 连接（fetch + ReadableStream）；已有活跃连接则复用。
    if (eventStream && activeSessionId.value === sessionId) return;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (eventStream) {
      eventStream.controller.abort();
      eventStream = null;
    }
    stopActivityTimer();
    const generation = ++streamGeneration;
    const controller = new AbortController();
    eventStream = { controller, generation };
    void readStream(sessionId, generation);
  }

  function closeEvents(): void {
    // 完全拆除事件流：使当前 generation 失效，旧的读取循环立刻停止且不再调度重连。
    ++streamGeneration;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    stopActivityTimer();
    if (eventStream) {
      eventStream.controller.abort();
      eventStream = null;
    }
  }

  /**
   * 读取并解析事件流。generation 用于竞态防护：重连/关闭后旧循环发现序号不匹配
   * 就直接退出，保证同一时间只有一个活跃流在喂 handleAgentEvent。
   * 断线（网络错误 / 流结束）时进入指数退避重连；被主动中止则静默退出。
   */
  async function readStream(sessionId: string, generation: number): Promise<void> {
    const controller = eventStream?.controller;
    if (!controller) return;
    try {
      const response = await fetchAgentEvents(sessionId, lastEventId, controller.signal);
      if (controller.signal.aborted || generation !== streamGeneration) return;
      if (!response.ok) {
        if (response.status === 401) {
          fireUnauthorized(); // 鉴权失效：通知 auth store 上锁，不无限重连
          eventStream = null; // 清掉死连接，避免挡住下次 connectEvents
          return;
        }
        throw new Error(`事件流请求失败（${response.status}）`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('事件流响应缺少 body');
      // 连接建立成功：重置退避，清除"自动重连"提示，启动假死检测。
      reconnectAttempt = 0;
      if (error.value?.includes('自动重连')) error.value = null;
      lastActivityAt = Date.now();
      startActivityTimer();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (controller.signal.aborted || generation !== streamGeneration) return;
        lastActivityAt = Date.now();
        buffer += decoder.decode(value, { stream: true });
        // 按空行切分 SSE 帧（后端每帧以 \n\n 结尾），心跳注释帧直接跳过。
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith(':')) continue;
          const parsed = parseSseFrame(frame);
          if (parsed.data) {
            if (parsed.id !== undefined) lastEventId = parsed.id;
            try {
              handleAgentEvent(JSON.parse(parsed.data) as AgentEvent, sessionId);
            } catch {
              // 忽略畸形事件，保持流存活
            }
          }
        }
      }
      stopActivityTimer();
    } catch {
      stopActivityTimer();
      if (controller.signal.aborted || generation !== streamGeneration) return;
    }
    if (controller.signal.aborted || generation !== streamGeneration) return;
    scheduleReconnect(sessionId);
  }

  /** 指数退避调度重连：0.5s → 1s → 2s … 封顶 10s。 */
  function scheduleReconnect(sessionId: string): void {
    if (activeSessionId.value !== sessionId || reconnectTimer !== undefined) return;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS);
    reconnectAttempt += 1;
    if (stream.running) error.value = '事件流暂时中断，正在自动重连…';
    // 让当前流失效，之后 connectEvents 创建全新连接。
    ++streamGeneration;
    if (eventStream) {
      eventStream.controller.abort();
      eventStream = null;
    }
    stopActivityTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (activeSessionId.value !== sessionId) return;
      connectEvents(sessionId);
    }, delay);
  }

  /** 强制重连：心跳假死 / 页面恢复可见时调用，中断旧连接并立即重连。 */
  function forceReconnect(): void {
    const sessionId = activeSessionId.value;
    if (!sessionId || !eventStream) return;
    ++streamGeneration;
    if (eventStream) {
      eventStream.controller.abort();
      eventStream = null;
    }
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    stopActivityTimer();
    connectEvents(sessionId);
  }

  /** 假死检测：超过 STREAM_IDLE_TIMEOUT_MS 没收到任何数据（含心跳）则强制重连。 */
  function startActivityTimer(): void {
    stopActivityTimer();
    lastActivityAt = Date.now();
    activityTimer = setInterval(() => {
      if (eventStream && Date.now() - lastActivityAt > STREAM_IDLE_TIMEOUT_MS) forceReconnect();
    }, ACTIVITY_CHECK_INTERVAL_MS);
  }

  function stopActivityTimer(): void {
    if (activityTimer !== undefined) {
      clearInterval(activityTimer);
      activityTimer = undefined;
    }
  }

  function onVisibilityChange(): void {
    // 后台时连接可能被系统挂起/假死，恢复可见后主动重连以加速恢复。
    // 只在正在运行（有活跃回合）时触发，空闲时保留连接，避免无谓断开。
    if (document.visibilityState === 'visible' && stream.running && eventStream) forceReconnect();
  }

  function applyPendingToolCall(pending: AgentStreamState['pendingToolCall'] | undefined): void {
    if (!pending) return;
    stream.pendingToolCall = pending;
    stream.running = true;
    stream.phase = 'tool';
  }

  function handleAgentEvent(event: AgentEvent, sessionId: string): void {
    // 处理一个 SSE 事件：更新流式状态、上下文占用、重试/压缩状态与消息列表
    assignStream(reduceAgentEvent(stream, event));
    if (event.contextUsage !== undefined) contextUsage.value = event.contextUsage ?? null;

    if (event.type === 'plan_updated' && event.plan) {
      plan.value = event.plan as PlanView;
    } else if (event.type === 'task_updated' && event.task) {
      // 任务变更实时刷新面板（本会话的任务；其它会话的任务不会推到这里）。
      task.value = event.task as TaskRecord;
    } else if (event.type === 'task_recovery_required' && event.tasks) {
      // 重启后首个连接时后端补推的待恢复清单（之后由 REST 保持）。
      recovery.value = event.tasks;
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
      void loadSession(sessionId);
      options.onAgentEnd?.();
    }
  }

  async function send(
    message: string,
    images: AttachedImage[] = [],
    mode: PromptMode = 'direct',
  ): Promise<void> {
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
      pendingQuestion: null,
    });
    try {
      if (activeSessionId.value === null) {
        // 新会话：带模型/思考/工具配置创建 Agent 并连接事件流
        const cwd = options.newSessionCwd.value;
        if (!cwd) throw new Error('请先选择工作区');
        const sessionId = await createAgent({
          cwd,
          message: text,
          // 执行方式（M4）：消息级属性——「先规划」不再需要先切换全局开关，
          // 新会话也能直接进入规划（修 P1）。
          ...(mode === 'plan' ? { mode } : {}),
          provider: displayModel.value?.provider,
          modelId: displayModel.value?.modelId,
          // 默认路径（未显式选择思考）不发送 thinkingLevel，保持与改动前一致。
          ...(thinkingExplicit.value ? { thinkingLevel: thinkingLevel.value } : {}),
          toolNames: activeTools.value,
          images: imageBlocks,
          ...(presetSystemPrompt.value ? { systemPrompt: presetSystemPrompt.value } : {}),
          ...(presetCompaction.value ? { compaction: presetCompaction.value } : {}),
          // mcpServers 仅在预设显式配置（非 null）时发送；null/缺省 = 后端默认全部
          ...(presetMcpServers.value !== null ? { mcpServers: presetMcpServers.value } : {}),
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
          ...(mode === 'plan' ? { mode } : {}),
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
        pendingQuestion: null,
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

  /**
   * 提交对「向用户提问」的回答（M4.1）。
   * `cancelled` 表示让 AI 自己决定（不是错误）：模型会按最合理的假设继续并写明假设。
   */
  async function answerQuestion(payload: {
    questionId: string;
    answers?: QuestionAnswer[];
    cancelled?: boolean;
  }): Promise<void> {
    if (!activeSessionId.value) return;
    try {
      await sendAgentCommand(activeSessionId.value, {
        type: 'answer_question',
        ...payload,
      });
      // 乐观清除弹窗；服务端结算后会再推 question_resolved。
      stream.pendingQuestion = null;
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

  function applyPreset(preset: SessionPreset): void {
    // 应用预设：预填模型/推理/工具（仍可在控件里修改），并记住系统提示词与压缩策略
    selectedPreset.value = preset.id;
    presetSystemPrompt.value = preset.systemPrompt;
    presetCompaction.value = { ...preset.compaction };
    presetMcpServers.value = preset.mcpServers ?? null;
    activeTools.value = [...preset.toolNames];
    // 预设指定了模型就用它，否则退回目录默认模型。
    newSessionModel.value =
      preset.provider && preset.modelId
        ? { provider: preset.provider, modelId: preset.modelId }
        : (catalog.value?.defaultModel ?? null);
    if (preset.thinkingLevel) {
      thinkingLevel.value = preset.thinkingLevel;
      thinkingExplicit.value = true;
    } else {
      // 预设未指定思考等级：回到初始占位值（不随请求发送，走 SDK 默认思考）。
      thinkingLevel.value = 'off';
      thinkingExplicit.value = false;
    }
  }

  async function changeThinkingLevel(level: string): Promise<void> {
    // 切换思考档位
    if (!activeSessionId.value) {
      thinkingLevel.value = level;
      thinkingExplicit.value = true; // 用户显式选择，创建时发送
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
      lastEventId = 0; // 新会话从头接收，重放其缓存中的全部事件
      reconnectAttempt = 0;
      assignStream({ ...INITIAL_STREAM_STATE });
      detail.value = null;
      plan.value = null;
      task.value = null;
      messages.value = [];
      entryIds.value = [];
      thinkingLevel.value = 'off';
      activeTools.value = [...DEFAULT_TOOLS];
      selectedPreset.value = BUILTIN_PRESET_ID;
      presetSystemPrompt.value = '';
      presetCompaction.value = null;
      presetMcpServers.value = null;
      thinkingExplicit.value = false;
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
      closeEvents();
      lastEventId = 0;
      reconnectAttempt = 0;
      detail.value = null;
      plan.value = null;
      task.value = null;
      messages.value = [];
      entryIds.value = [];
      thinkingLevel.value = 'off';
      activeTools.value = [...DEFAULT_TOOLS];
      selectedPreset.value = BUILTIN_PRESET_ID;
      presetSystemPrompt.value = '';
      presetCompaction.value = null;
      presetMcpServers.value = null;
      thinkingExplicit.value = false;
      assignStream({ ...INITIAL_STREAM_STATE });
      error.value = null;
    }
  });

  onMounted(async () => {
    document.addEventListener('visibilitychange', onVisibilityChange);
    await Promise.all([loadCatalog(), loadPresets()]);
  });

  async function loadPresets(): Promise<void> {
    // 预设加载失败不阻塞新会话；回退到只有内置默认。
    try {
      presets.value = await getPresets();
    } catch {
      presets.value = [];
    }
  }

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

  /** 重新加载当前会话的任务（面板写入成功后调用；SSE 也会推，用于兜底）。 */
  async function refreshTask(): Promise<void> {
    const sessionId = activeSessionId.value;
    if (!sessionId) {
      task.value = null;
      return;
    }
    try {
      const tasks = await listTasks({ sessionId, limit: 20 });
      task.value = tasks.find((item) => item.status !== 'cancelled') ?? tasks[0] ?? null;
    } catch {
      // 任务面板是增量能力：拉取失败不影响会话本身。
    }
  }

  /** 重新拉取待恢复清单（续跑成功后调用）。 */
  async function refreshRecovery(): Promise<void> {
    try {
      recovery.value = await getTaskRecovery();
    } catch {
      // 恢复清单是增量能力：拉取失败不影响会话本身。
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
    document.removeEventListener('visibilitychange', onVisibilityChange);
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
    refreshPlan,
    task,
    recovery,
    refreshTask,
    refreshRecovery,
    stream,
    contextUsage,
    catalog,
    thinkingLevel,
    activeTools,
    presets,
    selectedPreset,
    applyPreset,
    compacting,
    compactionError,
    retryInfo,
    isNew,
    displayModel,
    statusLabel,
    send,
    abort,
    approveToolCall,
    answerQuestion,
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

interface SseFrame {
  id?: number;
  data?: string;
}

/** 解析一帧 SSE：取 id: 与 data: 两行（按协议，data 可多行拼接）；无这些行则忽略。 */
export function parseSseFrame(frame: string): SseFrame {
  let id: number | undefined;
  let data: string | undefined;
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('id:')) {
      const parsed = Number(line.slice(3).trim());
      if (Number.isInteger(parsed)) id = parsed;
    } else if (line.startsWith('data:')) {
      const payload = line.slice(5).replace(/^ /, '');
      data = data === undefined ? payload : `${data}\n${payload}`;
    }
  }
  return { id, data };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : '发生未知错误';
}

function toImageBlock(image: AttachedImage): { type: 'image'; data: string; mimeType: string } {
  return { type: 'image', data: image.data, mimeType: image.mimeType };
}
