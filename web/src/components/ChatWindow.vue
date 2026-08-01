<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from "vue";

import AgentControls from "@/components/AgentControls.vue";
import BranchNavigator from "@/components/BranchNavigator.vue";
import ChatInput from "@/components/ChatInput.vue";
import MessageView from "@/components/MessageView.vue";
import { useAgentSession } from "@/composables/useAgentSession";
import { forkSession, mergeSession } from "@/lib/api";
import type { SessionInfo } from "@/types";

const props = defineProps<{
  sessionId: string | null;
  newSessionCwd: string | null;
  sessions: SessionInfo[];
  modelsRevision: number;
}>();

const emit = defineEmits<{
  sessionCreated: [sessionId: string];
  agentEnd: [];
  openSidebar: [];
  toggleFiles: [root: string];
  sessionForked: [sessionId: string];
  switchWorkspace: [];
  runningChange: [running: boolean];
}>();

const messagesEnd = ref<HTMLElement | null>(null);
const branchBusy = ref(false);
const branchError = ref<string | null>(null);
const {
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
} = useAgentSession({
  sessionId: toRef(props, "sessionId"),
  newSessionCwd: toRef(props, "newSessionCwd"),
  onSessionCreated: (sessionId) => emit("sessionCreated", sessionId),
  onAgentEnd: () => emit("agentEnd"),
  modelsRevision: toRef(props, "modelsRevision"),
});

const visibleMessages = computed(() =>
  messages.value
    .map((message, index) => ({ message, entryId: entryIds.value[index] ?? String(index) }))
    .filter(({ message }) => message.role === "user" || message.role === "assistant"),
);
const empty = computed(
  () => visibleMessages.value.length === 0 && !stream.streamingMessage && !stream.running,
);
const title = computed(() => {
  if (isNew.value) return "新会话";
  return detail.value?.info.name || detail.value?.info.firstMessage || "pi 会话";
});
const workspace = computed(() => detail.value?.info.cwd ?? props.newSessionCwd ?? "");
const toolResults = computed(() =>
  Object.fromEntries(
    messages.value
      .filter((message) => message.role === "toolResult" && message.toolCallId)
      .map((message) => [message.toolCallId as string, message]),
  ),
);

async function navigateBranch(entryId: string): Promise<void> {
  branchBusy.value = true;
  branchError.value = null;
  try {
    await navigateTree(entryId);
  } catch (cause) {
    branchError.value = cause instanceof Error ? cause.message : "无法切换分支";
  } finally {
    branchBusy.value = false;
  }
}

async function forkBranch(entryId: string): Promise<void> {
  if (!props.sessionId) return;
  branchBusy.value = true;
  branchError.value = null;
  try {
    const forked = await forkSession(props.sessionId, entryId);
    emit("sessionForked", forked.sessionId);
  } catch (cause) {
    branchError.value = cause instanceof Error ? cause.message : "无法创建 Fork";
  } finally {
    branchBusy.value = false;
  }
}

async function mergeFrom(sourceSessionId: string): Promise<void> {
  if (!props.sessionId) return;
  branchBusy.value = true;
  branchError.value = null;
  try {
    await mergeSession(props.sessionId, sourceSessionId);
    await reloadSession();
    emit("agentEnd");
  } catch (cause) {
    branchError.value = cause instanceof Error ? cause.message : "无法合并 Session";
  } finally {
    branchBusy.value = false;
  }
}

watch(
  () => [messages.value.length, stream.streamingMessage] as const,
  async () => {
    await nextTick();
    messagesEnd.value?.scrollIntoView({ behavior: "smooth" });
  },
  { deep: true },
);

watch(
  () => stream.running,
  (running) => emit("runningChange", running),
  { immediate: true },
);
</script>

<template>
  <section class="chat-window">
    <header class="chat-header">
      <button class="mobile-menu-button" type="button" aria-label="打开会话侧栏" @click="emit('openSidebar')">
        ☰
      </button>
      <div class="chat-heading">
        <h1>{{ title }}</h1>
        <div class="workspace-path" :title="workspace">{{ workspace || "选择一个工作区开始" }}</div>
      </div>
      <div class="header-meta">
        <button
          class="workspace-switch-button"
          type="button"
          :disabled="stream.running"
          @click="emit('switchWorkspace')"
        >
          切换项目
        </button>
        <button
          class="files-toggle-button"
          type="button"
          :disabled="!sessionId || !workspace"
          @click="workspace && emit('toggleFiles', workspace)"
        >
          文件
        </button>
        <span v-if="displayModel" class="model-chip">
          {{ displayModel.provider }} / {{ displayModel.modelId }}
        </span>
        <span v-if="contextUsage" class="context-chip">
          {{ Math.round(contextUsage.percent) }}%
        </span>
      </div>
    </header>

    <div v-if="detail && sessionId" class="branch-strip">
      <BranchNavigator
        :tree="detail.tree"
        :leaf-id="detail.leafId"
        :sessions="sessions"
        :current-session-id="sessionId"
        :busy="branchBusy || stream.running"
        @navigate="navigateBranch"
        @fork="forkBranch"
        @merge="mergeFrom"
      />
      <span v-if="branchError" class="branch-error" role="alert">{{ branchError }}</span>
    </div>

    <div v-if="loading" class="center-state">
      <span class="loading-ring" aria-hidden="true" />
      正在恢复会话…
    </div>

    <div v-else-if="!sessionId && !newSessionCwd" class="welcome-state">
      <div class="welcome-kicker">LOCAL · PRIVATE · STREAMING</div>
      <h2>把思路交给 <span>pi</span>，<br />把代码留在本地。</h2>
      <p>从左侧新建会话，或继续一段已有对话。</p>
      <button class="welcome-action" type="button" @click="emit('openSidebar')">打开会话列表</button>
    </div>

    <template v-else>
      <div class="message-scroller">
        <div v-if="empty" class="empty-conversation">
          <div class="empty-symbol" aria-hidden="true">π</div>
          <div class="welcome-kicker">READY IN {{ workspace }}</div>
          <h2>今天想一起完成什么？</h2>
          <p>描述目标、指出文件，或者直接粘贴报错。pi 会在当前工作区内读取与修改代码。</p>
        </div>

        <div v-else class="message-list">
          <MessageView
            v-for="item in visibleMessages"
            :key="item.entryId"
            :message="item.message"
            :tool-results="toolResults"
          />
          <MessageView
            v-if="stream.streamingMessage"
            :message="stream.streamingMessage"
            :tool-results="toolResults"
            streaming
          />
          <div v-else-if="stream.running" class="agent-status" role="status">
            <span class="status-pulse" aria-hidden="true" />
            {{ statusLabel }}
          </div>
          <div ref="messagesEnd" />
        </div>
      </div>

      <div class="composer-dock">
        <div v-if="error || stream.error || compactionError" class="chat-error" role="alert">
          {{ error || stream.error || compactionError }}
        </div>
        <AgentControls
          :catalog="catalog"
          :model="displayModel"
          :thinking-level="thinkingLevel"
          :active-tools="activeTools"
          :compacting="compacting"
          :running="stream.running"
          :retry-info="retryInfo"
          :context-usage="contextUsage"
          @model-change="changeModel"
          @thinking-change="changeThinkingLevel"
          @tools-change="changeTools"
          @compact="compact"
        />
        <ChatInput
          :running="stream.running"
          @send="send"
          @steer="steer"
          @follow-up="followUp"
          @abort="abort"
        />
        <div class="local-note">内容保存在本机 Session v3 文件中</div>
      </div>
    </template>
  </section>
</template>
