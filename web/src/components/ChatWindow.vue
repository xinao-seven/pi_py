<!-- 聊天主窗口：消息流、Agent 控制条、输入框，以及分支导航/合并等会话操作。 -->
<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from 'vue';

import AgentControls from '@/components/AgentControls.vue';
import BranchNavigator from '@/components/BranchNavigator.vue';
import ChatInput from '@/components/ChatInput.vue';
import MessageView from '@/components/MessageView.vue';
import PlanProgress from '@/components/PlanProgress.vue';
import ToolApprovalDialog from '@/components/ToolApprovalDialog.vue';
import { useAgentSession } from '@/composables/useAgentSession';
import { forkSession, mergeSession, sendPlanCommand } from '@/lib/api';
import { useAppStore } from '@/stores/app';
import type { SessionInfo, SessionTreeNode } from '@/types';

const props = defineProps<{
  sessionId: string | null;
  newSessionCwd: string | null;
  sessions: SessionInfo[];
  modelsRevision: number;
  sidebarCollapsed: boolean;
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
const planBusy = ref(false);
const branchExpanded = ref(false);
const store = useAppStore();
const {
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
} = useAgentSession({
  sessionId: toRef(props, 'sessionId'),
  newSessionCwd: toRef(props, 'newSessionCwd'),
  onSessionCreated: (sessionId) => emit('sessionCreated', sessionId),
  onAgentEnd: () => emit('agentEnd'),
  modelsRevision: toRef(props, 'modelsRevision'),
});

const visibleMessages = computed(() =>
  // 只展示 user/assistant 消息；toolResult 按 toolCallId 供工具块查询
  messages.value
    .map((message, index) => ({ message, entryId: entryIds.value[index] ?? String(index) }))
    .filter(({ message }) => message.role === 'user' || message.role === 'assistant'),
);
const empty = computed(
  // 是否为空会话（无消息且不在运行）
  () => visibleMessages.value.length === 0 && !stream.streamingMessage && !stream.running,
);
const title = computed(() => {
  // 窗口标题：新会话 / 会话名称 / 首条消息 / 兜底
  if (isNew.value) return '新会话';
  return detail.value?.info.name || detail.value?.info.firstMessage || 'pi 会话';
});
const workspace = computed(() => detail.value?.info.cwd ?? props.newSessionCwd ?? '');
const planActive = computed(
  () => plan.value?.mode === 'planning' || plan.value?.mode === 'executing',
);
const branchNodeCount = computed(() => countTreeNodes(detail.value?.tree ?? []));
const toolResults = computed(() =>
  // toolCallId -> toolResult 消息 的映射，供工具调用块展示结果
  Object.fromEntries(
    messages.value
      .filter((message) => message.role === 'toolResult' && message.toolCallId)
      .map((message) => [message.toolCallId as string, message]),
  ),
);

function countTreeNodes(nodes: SessionTreeNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countTreeNodes(node.children), 0);
}

async function navigateBranch(entryId: string): Promise<void> {
  // 切换会话树分支
  store.setBranchBusy(true);
  store.setBranchError(null);
  try {
    await navigateTree(entryId);
  } catch (cause) {
    store.setBranchError(cause instanceof Error ? cause.message : '无法切换分支');
  } finally {
    store.setBranchBusy(false);
  }
}

async function forkBranch(entryId: string): Promise<void> {
  // 从指定节点 Fork 出独立会话
  if (!props.sessionId) return;
  store.setBranchBusy(true);
  store.setBranchError(null);
  try {
    const forked = await forkSession(props.sessionId, entryId);
    emit('sessionForked', forked.sessionId);
  } catch (cause) {
    store.setBranchError(cause instanceof Error ? cause.message : '无法创建 Fork');
  } finally {
    store.setBranchBusy(false);
  }
}

async function mergeFrom(sourceSessionId: string): Promise<void> {
  // 把来源会话合并进当前会话并刷新
  if (!props.sessionId) return;
  store.setBranchBusy(true);
  store.setBranchError(null);
  try {
    await mergeSession(props.sessionId, sourceSessionId);
    await reloadSession();
    emit('agentEnd');
  } catch (cause) {
    store.setBranchError(cause instanceof Error ? cause.message : '无法合并 Session');
  } finally {
    store.setBranchBusy(false);
  }
}

async function actPlan(
  action: 'enable' | 'disable' | 'execute' | 'refine',
  message?: string,
): Promise<void> {
  // 发送 Plan 命令并乐观更新面板状态；随后 SSE plan_updated 会校正权威状态。
  if (!props.sessionId) return;
  planBusy.value = true;
  error.value = null;
  try {
    await sendPlanCommand(props.sessionId, action, message);
    const current = plan.value;
    if (action === 'enable') {
      plan.value = {
        sessionId: props.sessionId,
        mode: 'planning',
        todos: current?.todos ?? [],
        awaitingConfirmation: false,
      };
    } else if (action === 'disable') {
      plan.value = {
        sessionId: props.sessionId,
        mode: 'normal',
        todos: [],
        awaitingConfirmation: false,
      };
    } else if (action === 'execute') {
      plan.value = {
        sessionId: props.sessionId,
        mode: 'executing',
        todos: current?.todos ?? [],
        awaitingConfirmation: false,
      };
    } else if (action === 'refine') {
      plan.value = {
        sessionId: props.sessionId,
        mode: 'planning',
        todos: current?.todos ?? [],
        awaitingConfirmation: false,
      };
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Plan 操作失败';
  } finally {
    planBusy.value = false;
  }
}

async function togglePlan(): Promise<void> {
  // 新会话尚未有 Session JSONL，必须先发送首条普通消息创建会话。
  if (!props.sessionId) {
    error.value = '请先发送首条消息创建会话，再开启 Plan 模式。';
    return;
  }
  if (planActive.value) {
    // 激活后开关即退出键；执行中退出会中断计划，先确认避免误退。
    if (plan.value?.mode === 'executing') {
      const ok = window.confirm('执行中退出会中断当前计划，确定退出 Plan 模式吗？');
      if (!ok) return;
    }
    await actPlan('disable');
    return;
  }
  await actPlan('enable');
}

watch(
  () => [messages.value.length, stream.streamingMessage] as const,
  async () => {
    await nextTick();
    messagesEnd.value?.scrollIntoView({ behavior: 'smooth' });
  },
  { deep: true },
);

watch(
  () => stream.running,
  (running) => emit('runningChange', running),
  { immediate: true },
);

watch(
  () => detail.value,
  (value) => store.setBranchState(value?.tree ?? [], value?.leafId ?? null),
  { immediate: true },
);

defineExpose({ navigateBranch, forkBranch, mergeFrom });
</script>

<template>
  <section class="chat-window">
    <header class="chat-header">
      <button
        class="mobile-menu-button"
        :class="{ 'mobile-menu-button--visible': sidebarCollapsed }"
        type="button"
        aria-label="打开会话侧栏"
        @click="emit('openSidebar')"
      >
        ☰
      </button>
      <div class="chat-heading">
        <span class="chat-title" :title="title">{{ title }}</span>
        <span v-if="workspace" class="chat-title-dot" aria-hidden="true">·</span>
        <span v-if="workspace" class="workspace-path" :title="workspace">{{ workspace }}</span>
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
          {{ displayModel.provider }}/{{ displayModel.modelId }}
        </span>
        <span v-if="contextUsage" class="context-chip">
          {{ Math.round(contextUsage.percent) }}%
        </span>
      </div>
    </header>

    <section
      v-if="detail?.tree.length"
      class="branch-strip"
      :class="{ 'branch-strip--expanded': branchExpanded }"
    >
      <button
        class="branch-strip-toggle"
        type="button"
        :aria-expanded="branchExpanded"
        @click="branchExpanded = !branchExpanded"
      >
        <span class="branch-strip-icon" aria-hidden="true">⑂</span>
        <strong>会话分支</strong>
        <span>{{ branchNodeCount }} 个节点</span>
        <span class="branch-strip-chevron" aria-hidden="true">⌄</span>
      </button>
      <div v-show="branchExpanded" class="branch-strip-content">
        <BranchNavigator
          :tree="detail.tree"
          :leaf-id="detail.leafId"
          :sessions="sessions"
          :current-session-id="sessionId ?? ''"
          :busy="store.branchBusy || stream.running"
          @navigate="navigateBranch"
          @fork="forkBranch"
          @merge="mergeFrom"
        />
        <span v-if="store.branchError" class="branch-error" role="alert">
          {{ store.branchError }}
        </span>
      </div>
    </section>

    <div v-if="loading" class="center-state">
      <span class="loading-ring" aria-hidden="true" />
      正在恢复会话…
    </div>

    <div v-else-if="!sessionId && !newSessionCwd" class="welcome-state">
      <div class="welcome-kicker">LOCAL · PRIVATE · STREAMING</div>
      <h2>把思路交给 <span>pi</span>，<br />把代码留在本地。</h2>
      <p>从左侧新建会话，或继续一段已有对话。</p>
      <button class="welcome-action" type="button" @click="emit('openSidebar')">
        打开会话列表
      </button>
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
        <PlanProgress
          :plan="plan"
          :session-id="sessionId"
          :busy="planBusy"
          @disable="actPlan('disable')"
          @execute="actPlan('execute')"
          @refine="(message) => actPlan('refine', message)"
        />
        <AgentControls
          :catalog="catalog"
          :model="displayModel"
          :thinking-level="thinkingLevel"
          :active-tools="activeTools"
          :compacting="compacting"
          :running="stream.running"
          :retry-info="retryInfo"
          :context-usage="contextUsage"
          :plan-active="planActive"
          :plan-busy="planBusy"
          @model-change="changeModel"
          @thinking-change="changeThinkingLevel"
          @tools-change="changeTools"
          @compact="compact"
          @toggle-plan="togglePlan"
        />
        <ChatInput
          :running="stream.running"
          :disabled="planBusy"
          :plan-active="planActive"
          @send="send"
          @steer="steer"
          @follow-up="followUp"
          @abort="abort"
        />
      </div>
    </template>
    <ToolApprovalDialog
      v-if="stream.pendingToolCall"
      :pending="stream.pendingToolCall"
      @approve="approveToolCall"
    />
  </section>
</template>
