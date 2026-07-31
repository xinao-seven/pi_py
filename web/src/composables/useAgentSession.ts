import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { Ref } from "vue";

import {
  agentEventsUrl,
  createAgent,
  getAgentState,
  getModels,
  getSession,
  sendAgentCommand,
} from "@/lib/api";
import { INITIAL_STREAM_STATE, reduceAgentEvent } from "@/lib/agent-events";
import type {
  AgentEvent,
  AgentMessage,
  AgentStreamState,
  AttachedImage,
  ContextUsage,
  ModelCatalog,
  ModelRef,
  RetryInfo,
  SessionDetail,
} from "@/types";

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

interface AgentSessionOptions {
  sessionId: Ref<string | null>;
  newSessionCwd: Ref<string | null>;
  onSessionCreated?: (sessionId: string) => void;
  onAgentEnd?: () => void;
  modelsRevision?: Ref<number>;
}

export function useAgentSession(options: AgentSessionOptions) {
  const activeSessionId = ref<string | null>(options.sessionId.value);
  const detail = ref<SessionDetail | null>(null);
  const messages = ref<AgentMessage[]>([]);
  const entryIds = ref<string[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const stream = reactive<AgentStreamState>({ ...INITIAL_STREAM_STATE });
  const contextUsage = ref<ContextUsage | null>(null);
  const catalog = ref<ModelCatalog | null>(null);
  const newSessionModel = ref<ModelRef | null>(null);
  const thinkingLevel = ref("off");
  const activeTools = ref<string[]>([...DEFAULT_TOOLS]);
  const compacting = ref(false);
  const compactionError = ref<string | null>(null);
  const retryInfo = ref<RetryInfo | null>(null);
  let eventSource: EventSource | null = null;
  let loadSequence = 0;

  const isNew = computed(
    () => activeSessionId.value === null && options.newSessionCwd.value !== null,
  );
  const displayModel = computed(
    () => detail.value?.context.model ?? newSessionModel.value ?? catalog.value?.defaultModel ?? null,
  );
  const statusLabel = computed(() => {
    if (!stream.running) return "空闲";
    if (stream.phase === "responding") return "正在生成回复";
    if (stream.phase === "tool") return "正在执行工具";
    return "正在等待模型";
  });

  function assignStream(next: AgentStreamState): void {
    stream.running = next.running;
    stream.phase = next.phase;
    stream.streamingMessage = next.streamingMessage;
    stream.error = next.error;
  }

  async function loadSession(sessionId: string, showLoading = false): Promise<void> {
    const sequence = ++loadSequence;
    if (showLoading) loading.value = true;
    try {
      const [nextDetail, state] = await Promise.all([
        getSession(sessionId),
        getAgentState(sessionId),
      ]);
      if (sequence !== loadSequence || activeSessionId.value !== sessionId) return;
      detail.value = nextDetail;
      messages.value = nextDetail.context.messages;
      entryIds.value = nextDetail.context.entryIds;
      contextUsage.value = state.state?.contextUsage ?? null;
      thinkingLevel.value = state.state?.thinkingLevel ?? nextDetail.context.thinkingLevel;
      if (state.state?.activeTools) activeTools.value = state.state.activeTools;
      if (state.running && state.state?.isStreaming) {
        stream.running = true;
        stream.phase = "waiting";
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
    if (eventSource && activeSessionId.value === sessionId) return;
    closeEvents();
    const source = new EventSource(agentEventsUrl(sessionId));
    eventSource = source;
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
        error.value = "事件流暂时中断，正在自动重连…";
      }
    };
    source.onopen = () => {
      if (eventSource === source && error.value?.includes("自动重连")) {
        error.value = null;
      }
    };
  }

  function closeEvents(): void {
    eventSource?.close();
    eventSource = null;
  }

  function handleAgentEvent(event: AgentEvent, sessionId: string): void {
    assignStream(reduceAgentEvent(stream, event));
    if (event.contextUsage !== undefined) contextUsage.value = event.contextUsage ?? null;

    if (event.type === "auto_retry_start") {
      retryInfo.value = {
        attempt: event.attempt ?? 0,
        maxAttempts: event.maxAttempts ?? 0,
        errorMessage: event.errorMessage ?? null,
      };
    } else if (event.type === "auto_retry_end") {
      retryInfo.value = null;
    } else if (event.type === "compaction_start") {
      compacting.value = true;
      compactionError.value = null;
    } else if (event.type === "compaction_end") {
      compacting.value = false;
      compactionError.value = typeof event.error === "string" ? event.error : null;
      if (!event.aborted) void loadSession(sessionId);
    }

    if (event.type === "message_end" && event.message) {
      const existingIndex = event.entryId ? entryIds.value.indexOf(event.entryId) : -1;
      if (existingIndex >= 0) {
        messages.value[existingIndex] = event.message;
      } else {
        messages.value = [...messages.value, event.message];
        entryIds.value = [...entryIds.value, event.entryId ?? ""];
      }
    }

    if (event.type === "agent_end") {
      void loadSession(sessionId);
      options.onAgentEnd?.();
    }
  }

  async function send(message: string, images: AttachedImage[] = []): Promise<void> {
    const text = message.trim();
    if ((!text && images.length === 0) || stream.running) return;
    const imageBlocks = images.map(toImageBlock);
    error.value = null;
    assignStream({ running: true, phase: "waiting", streamingMessage: null, error: null });
    try {
      if (activeSessionId.value === null) {
        const cwd = options.newSessionCwd.value;
        if (!cwd) throw new Error("请先选择工作区");
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
        const sessionId = activeSessionId.value;
        await sendAgentCommand(sessionId, {
          type: "prompt",
          message: text,
          images: imageBlocks,
        });
        connectEvents(sessionId);
      }
    } catch (cause) {
      assignStream({
        running: false,
        phase: "idle",
        streamingMessage: null,
        error: errorMessage(cause),
      });
    }
  }

  async function abort(): Promise<void> {
    if (!activeSessionId.value || !stream.running) return;
    try {
      await sendAgentCommand(activeSessionId.value, { type: "abort" });
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }

  async function steer(message: string, images: AttachedImage[] = []): Promise<void> {
    await liveTextCommand("steer", message, images);
  }

  async function followUp(message: string, images: AttachedImage[] = []): Promise<void> {
    await liveTextCommand("follow_up", message, images);
  }

  async function liveTextCommand(
    type: "steer" | "follow_up",
    message: string,
    images: AttachedImage[],
  ): Promise<void> {
    if (!activeSessionId.value || !stream.running || (!message.trim() && images.length === 0)) return;
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
    if (!activeSessionId.value) {
      newSessionModel.value = model;
      return;
    }
    try {
      await sendAgentCommand(activeSessionId.value, { type: "set_model", ...model });
      if (detail.value) detail.value.context.model = model;
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }

  async function changeThinkingLevel(level: string): Promise<void> {
    if (!activeSessionId.value) {
      thinkingLevel.value = level;
      return;
    }
    try {
      await sendAgentCommand(activeSessionId.value, {
        type: "set_thinking_level",
        thinkingLevel: level,
      });
      thinkingLevel.value = level;
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }

  async function changeTools(toolNames: string[]): Promise<void> {
    if (!activeSessionId.value) {
      activeTools.value = toolNames;
      return;
    }
    try {
      await sendAgentCommand(activeSessionId.value, { type: "set_tools", toolNames });
      activeTools.value = toolNames;
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }

  async function compact(): Promise<void> {
    if (!activeSessionId.value || stream.running || compacting.value) return;
    compacting.value = true;
    compactionError.value = null;
    try {
      await sendAgentCommand(activeSessionId.value, { type: "compact" });
      await loadSession(activeSessionId.value);
    } catch (cause) {
      compactionError.value = errorMessage(cause);
    } finally {
      compacting.value = false;
    }
  }

  async function navigateTree(targetId: string): Promise<void> {
    if (!activeSessionId.value || stream.running) return;
    error.value = null;
    await sendAgentCommand(activeSessionId.value, {
      type: "navigate_tree",
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
      messages.value = [];
      entryIds.value = [];
      thinkingLevel.value = "off";
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
      messages.value = [];
      entryIds.value = [];
      thinkingLevel.value = "off";
      activeTools.value = [...DEFAULT_TOOLS];
      assignStream({ ...INITIAL_STREAM_STATE });
      error.value = null;
    }
  });

  onMounted(async () => {
    await loadCatalog();
  });

  async function loadCatalog(): Promise<void> {
    try {
      catalog.value = await getModels();
      newSessionModel.value ??= catalog.value.defaultModel;
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }

  if (options.modelsRevision) watch(options.modelsRevision, loadCatalog);

  onBeforeUnmount(closeEvents);

  return {
    activeSessionId,
    detail,
    messages,
    entryIds,
    loading,
    error,
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
  return cause instanceof Error ? cause.message : "发生未知错误";
}

function toImageBlock(image: AttachedImage): { type: "image"; data: string; mimeType: string } {
  return { type: "image", data: image.data, mimeType: image.mimeType };
}
