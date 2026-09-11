<!-- 聊天主窗口：消息流、Agent 控制条、输入框，以及分支导航/合并等会话操作。 -->
<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual';
import { computed, nextTick, ref, toRef, watch } from 'vue';

import AgentControls from '@/components/AgentControls.vue';
import BranchNavigator from '@/components/BranchNavigator.vue';
import ChatInput from '@/components/ChatInput.vue';
import MessageView from '@/components/MessageView.vue';
import PlanProgress from '@/components/PlanProgress.vue';
import TaskPanel from '@/components/TaskPanel.vue';
import QuestionDialog from '@/components/QuestionDialog.vue';
import ToolApprovalDialog from '@/components/ToolApprovalDialog.vue';
import { useAgentSession } from '@/composables/useAgentSession';
import {
  addTaskStep,
  ApiError,
  cancelTask,
  createTask,
  deleteTaskStep,
  forkSession,
  mergeSession,
  resumeTask,
  sendPlanCommand,
  updateTaskStep,
} from '@/lib/api';
import { useAppStore } from '@/stores/app';
import type { AgentMessage, QuestionAnswer, SessionInfo, TaskStep, TaskStepStatus } from '@/types';

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
const messageScroller = ref<HTMLElement | null>(null);
const followBottom = ref(true); // 是否跟随滚动到最新消息
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
  task,
  recovery,
  refreshPlan,
  refreshTask,
  refreshRecovery,
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
// 分支树节点数：树已是扁平数组，直接取长度（不再递归统计）
const branchNodeCount = computed(() => detail.value?.tree.length ?? 0);
// 上下文占用徽标：percent 可能是 null（刚压缩完、占用未知），此时不显示。
const contextPercentLabel = computed(() =>
  contextUsage.value?.percent === null || contextUsage.value?.percent === undefined
    ? null
    : `${Math.round(contextUsage.value.percent)}%`,
);
const toolResults = computed(() =>
  // toolCallId -> toolResult 消息 的映射，供工具调用块展示结果
  Object.fromEntries(
    messages.value
      .filter((message) => message.role === 'toolResult' && message.toolCallId)
      .map((message) => [message.toolCallId as string, message]),
  ),
);

// 不定高虚拟列表：只渲染可视区内的消息行，用 measureElement 按真实高度测量，
// 长会话下避免全量渲染上千条 Markdown/代码块导致卡顿。流式消息在列表外单独渲染。
// 整个 options 包成 computed：TanStack 的 Vue 适配器按对象级响应式跟踪。
const virtualizer = useVirtualizer(
  computed(() => ({
    count: visibleMessages.value.length,
    getScrollElement: () => messageScroller.value,
    getItemKey: (index: number) => visibleMessages.value[index]?.entryId ?? `msg-${index}`,
    estimateSize: (index: number) => {
      // 未测量前的粗估高度（measureElement 测量后会按真实高度替换）
      const message = visibleMessages.value[index]?.message;
      return message?.role === 'user' ? 64 : 260;
    },
    overscan: 8,
  })),
);

function rowMessage(row: { index: number }): AgentMessage {
  // 只在虚拟行渲染时调用（模板里已有 v-if 守卫），索引一定有效
  return visibleMessages.value[row.index]!.message;
}

function measureRow(el: unknown): void {
  // Vue 的 ref 回调签名与 TanStack 的 measureElement 不一致，包一层做类型适配
  virtualizer.value.measureElement(el as HTMLElement | null);
}

function onScroll(): void {
  // 距底部 <120px 视为"跟随底部"：新消息/流式内容时自动滚动到最新。
  const el = messageScroller.value;
  if (!el) return;
  followBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
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

/** 任务面板正在写入（串行化，避免 ifRevision 竞争）。 */
const questionBusy = ref(false);
/** 待回答的提问（来自 SSE question_pending 或刷新后的状态快照）。 */
const pendingQuestion = computed(() => stream.pendingQuestion);

async function submitQuestionAnswers(answers: QuestionAnswer[]): Promise<void> {
  const pending = stream.pendingQuestion;
  if (!pending) return;
  questionBusy.value = true;
  try {
    await answerQuestion({ questionId: pending.questionId, answers });
  } finally {
    questionBusy.value = false;
  }
}

async function cancelQuestion(): Promise<void> {
  const pending = stream.pendingQuestion;
  if (!pending) return;
  questionBusy.value = true;
  try {
    await answerQuestion({ questionId: pending.questionId, cancelled: true });
  } finally {
    questionBusy.value = false;
  }
}

const taskBusy = ref(false);
const taskError = ref<string | null>(null);

/**
 * 统一的任务写入包装：成功后用服务端返回的权威记录刷新面板。
 *
 * 中文说明：执行器（续跑/在飞动作）也会写任务并升高 revision，所以用户点击时
 * 手里的版本可能刚刚落后。这里对 409 task_conflict 自动刷新一次再重试——
 * 否则用户会遇到「我什么都没改却被拒绝」的困惑。重试只做一次，避免反复抢。
 */
async function actTask(build: () => Promise<void>): Promise<void> {
  taskBusy.value = true;
  taskError.value = null;
  try {
    try {
      await build();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'task_conflict') {
        await refreshTask();
        await build();
      } else {
        throw cause;
      }
    }
    await refreshTask();
  } catch (cause) {
    taskError.value = cause instanceof Error ? cause.message : '任务操作失败';
  } finally {
    taskBusy.value = false;
  }
}

function createSessionTask(payload: { title: string; goal: string }): void {
  if (!props.sessionId) return;
  const cwd = workspace.value || undefined;
  void actTask(async () => {
    await createTask({ ...payload, sessionId: props.sessionId!, ...(cwd ? { cwd } : {}) });
  });
}

function addSessionStep(payload: { title: string }): void {
  void actTask(async () => {
    const current = task.value;
    if (!current) return;
    await addTaskStep(current.id, { title: payload.title, ifRevision: current.revision });
  });
}

function setSessionStepStatus(payload: {
  step: TaskStep;
  status: TaskStepStatus;
  reason?: string;
}): void {
  void actTask(async () => {
    const current = task.value;
    if (!current) return;
    await updateTaskStep(current.id, payload.step.id, {
      status: payload.status,
      ...(payload.reason ? { blockedReason: payload.reason } : {}),
      ifRevision: current.revision,
    });
  });
}

function removeSessionStep(payload: { step: TaskStep; force: boolean }): void {
  void actTask(async () => {
    const current = task.value;
    if (!current) return;
    await deleteTaskStep(current.id, payload.step.id, {
      ifRevision: current.revision,
      ...(payload.force ? { force: true } : {}),
    });
  });
}

function cancelSessionTask(): void {
  void actTask(async () => {
    const current = task.value;
    if (!current) return;
    await cancelTask(current.id, { ifRevision: current.revision });
  });
}

/**
 * 续跑/重试任务（M3）。
 *
 * 中文说明：服务端可能因为「未决副作用」拒绝（409 task_needs_confirmation /
 * task_artifact_unverified）。前者由用户显式确认后重试；后者表示产物状态未知，
 * 服务端已把任务标为 blocked，这里只提示（不再自动重放写操作）。
 */
function resumeSessionTask(payload: { mode: 'continue' | 'retry_step' }): void {
  const current = task.value;
  if (!current) return;
  void actTask(async () => {
    const target = task.value;
    if (!target) return;
    try {
      await resumeTask(target.id, { mode: payload.mode });
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'task_needs_confirmation') {
        const confirmed = window.confirm(
          `${cause.message}

确认已了解风险并继续？（不会自动重放写操作）`,
        );
        if (!confirmed) return;
        await resumeTask(target.id, { mode: payload.mode, confirmSideEffect: true });
      } else {
        throw cause;
      }
    }
  });
  void refreshRecovery();
}

/**
 * 计划命令（M4）：start / execute / pause / resume / refine / abandon。
 *
 * 中文说明：响应体已经带上最新的 PlanView，所以先用它刷新面板（即时反馈），
 * SSE `plan_updated` 到达后仍会校正（执行器/工具也会改计划，SSE 才是权威）。
 */
async function actPlan(
  action: 'start' | 'execute' | 'pause' | 'resume' | 'refine' | 'abandon',
  message?: string,
): Promise<void> {
  if (!props.sessionId) return;
  planBusy.value = true;
  error.value = null;
  try {
    const result = await sendPlanCommand(props.sessionId, action, message);
    if (result.plan) plan.value = result.plan;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Plan 操作失败';
  } finally {
    planBusy.value = false;
  }
}

/**
 * 计划步骤编辑（改名/跳过/恢复/删除）。
 * 中文说明：计划就是任务，所以直接走任务接口——复用 actTask 的乐观并发处理
 * （409 冲突自动刷新后重试一次）。
 */
function patchPlanStep(payload: {
  stepId: string;
  patch: { title?: string; status?: TaskStepStatus };
}): void {
  void actTask(async () => {
    const current = plan.value;
    if (!current) return;
    await updateTaskStep(current.taskId, payload.stepId, {
      ...payload.patch,
      ifRevision: current.revision,
    });
    await refreshPlan();
  });
}

function removePlanStep(payload: { stepId: string }): void {
  const current = plan.value;
  if (!current) return;
  const step = current.steps.find((item) => item.id === payload.stepId);
  if (
    step?.status === 'completed' &&
    !window.confirm('这一步已完成，删除会丢失它的证据，确定吗？')
  ) {
    return;
  }
  void actTask(async () => {
    const latest = plan.value;
    if (!latest) return;
    await deleteTaskStep(latest.taskId, payload.stepId, {
      ifRevision: latest.revision,
      ...(step?.status === 'completed' ? { force: true } : {}),
    });
    await refreshPlan();
  });
}

watch(
  () => [messages.value.length, stream.streamingMessage] as const,
  async () => {
    await nextTick();
    // 跟随底部时才自动滚动：流式输出用 auto（避免逐 chunk 平滑滚动卡顿），
    // 新消息用 smooth；用户上滑阅读历史时不被强制拉回底部。
    if (!followBottom.value) return;
    messagesEnd.value?.scrollIntoView({
      behavior: stream.streamingMessage ? 'auto' : 'smooth',
    });
  },
  // 不用 deep：源里已经是「数组长度 + message 对象引用」，每条 SSE 事件都换成新对象；
  // deep 只会在每个 token 上深度遍历整条消息，纯浪费（合并渲染后每帧最多触发一次）。
);

watch(
  () => props.sessionId,
  () => {
    followBottom.value = true;
  },
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
        <span v-if="contextPercentLabel" class="context-chip">
          {{ contextPercentLabel }}
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
      <div ref="messageScroller" class="message-scroller" @scroll.passive="onScroll">
        <div v-if="empty" class="empty-conversation">
          <div class="empty-symbol" aria-hidden="true">π</div>
          <div class="welcome-kicker">READY IN {{ workspace }}</div>
          <h2>今天想一起完成什么？</h2>
          <p>描述目标、指出文件，或者直接粘贴报错。pi 会在当前工作区内读取与修改代码。</p>
        </div>

        <div v-else class="message-list">
          <div class="virtual-list" :style="{ height: `${virtualizer.getTotalSize()}px` }">
            <div
              v-for="row in virtualizer.getVirtualItems()"
              :key="String(row.key)"
              :ref="measureRow"
              :data-index="row.index"
              class="virtual-row"
              :style="{ transform: `translateY(${row.start}px)` }"
            >
              <MessageView
                v-if="rowMessage(row)"
                :message="rowMessage(row)"
                :tool-results="toolResults"
              />
            </div>
          </div>
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
          @execute="actPlan('execute')"
          @pause="actPlan('pause')"
          @resume="actPlan('resume')"
          @abandon="actPlan('abandon')"
          @refine="(message) => actPlan('refine', message)"
          @step-patch="patchPlanStep"
          @step-remove="removePlanStep"
        />
        <TaskPanel
          v-if="sessionId || task || recovery.length"
          :task="task"
          :session-id="sessionId"
          :recovery="recovery"
          :busy="taskBusy"
          :error="taskError"
          @create="createSessionTask"
          @add-step="addSessionStep"
          @set-step-status="setSessionStepStatus"
          @remove-step="removeSessionStep"
          @cancel="cancelSessionTask"
          @resume="resumeSessionTask"
          @refresh="refreshTask"
        />
        <AgentControls
          :catalog="catalog"
          :model="displayModel"
          :thinking-level="thinkingLevel"
          :active-tools="activeTools"
          :presets="presets"
          :selected-preset="selectedPreset"
          :is-new="isNew"
          :compacting="compacting"
          :running="stream.running"
          :retry-info="retryInfo"
          :context-usage="contextUsage"
          @model-change="changeModel"
          @thinking-change="changeThinkingLevel"
          @tools-change="changeTools"
          @preset-change="applyPreset"
          @compact="compact"
        />
        <ChatInput
          :running="stream.running"
          :disabled="planBusy"
          :plan-available="Boolean(sessionId) || Boolean(newSessionCwd)"
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
    <QuestionDialog
      v-if="pendingQuestion"
      :pending="pendingQuestion"
      :busy="questionBusy"
      @submit="submitQuestionAnswers"
      @cancel="cancelQuestion"
    />
  </section>
</template>

<style scoped>
/* 聊天主区：头部、分支条、消息滚动区、欢迎/空态与状态指示 */
.chat-window {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.chat-header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}

.chat-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}

.chat-title {
  max-width: 340px;
  overflow: hidden;
  color: var(--text);
  font-size: 13px;
  font-weight: 650;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-title-dot {
  flex: 0 0 auto;
  color: var(--faint);
}

.workspace-path {
  max-width: min(420px, 40vw);
  overflow: hidden;
  color: var(--faint);
  font-family: 'Cascadia Code', 'SFMono-Regular', Consolas, monospace;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-left: auto;
}

.files-toggle-button,
.workspace-switch-button {
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  background: var(--panel);
  font-size: 10px;
  cursor: pointer;
}

.files-toggle-button:disabled,
.workspace-switch-button:disabled {
  opacity: 0.4;
  cursor: default;
}

:root[data-theme='light'] .files-toggle-button,
:root[data-theme='light'] .workspace-switch-button {
  color: var(--muted);
  background: #f8f9f5;
}

:root[data-theme='light'] .files-toggle-button:hover,
:root[data-theme='light'] .workspace-switch-button:hover {
  background: #edf1e5;
}

.model-chip,
.context-chip {
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--muted);
  background: rgba(255, 255, 255, 0.025);
  font-size: 10px;
}

.context-chip {
  color: #dce9a5;
}

:root[data-theme='light'] .model-chip,
:root[data-theme='light'] .context-chip {
  color: var(--muted);
  background: #f8f9f5;
}

:root[data-theme='light'] .context-chip {
  color: #405800;
}

.mobile-menu-button {
  display: none;
  margin-right: 8px;
  padding: 4px 7px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: transparent;
}

/* 桌面端侧栏折叠后，让头部显示 ☰ 以便再次展开 */
.mobile-menu-button--visible {
  display: block;
}

.branch-strip {
  position: relative;
  z-index: 12;
  display: block;
  min-height: 34px;
  padding: 0;
  border-bottom: 1px solid var(--line);
  background: var(--panel-raised);
}

.branch-strip-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 33px;
  padding: 0 15px;
  border: 0;
  color: var(--muted);
  background: transparent;
  text-align: left;
  font-size: 10px;
  cursor: pointer;
}

.branch-strip-toggle strong {
  color: var(--text);
  font-size: 11px;
}

.branch-strip-icon {
  color: var(--faint);
  font-size: 15px;
}

.branch-strip-chevron {
  margin-left: auto;
  font-size: 15px;
  transition: transform 140ms ease;
}

.branch-strip--expanded .branch-strip-chevron {
  transform: rotate(180deg);
}

.branch-strip-content {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 39px;
  padding: 0 15px 7px 37px;
}

.branch-strip-content .branch-navigator {
  flex: 1;
}

.branch-error {
  overflow: hidden;
  color: var(--danger);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-scroller {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #353942 transparent;
}

.message-list {
  width: min(100%, 820px);
  margin: 0 auto;
  padding: 28px 22px 32px;
}

/* 不定高虚拟列表：虚拟行绝对定位，translateY 铺开；
   padding-bottom 代替 .message-row 的 margin 间距，让 measureElement
   测到的盒高天然包含行间距，避免相邻行贴在一起。 */
.virtual-list {
  position: relative;
}

.virtual-row {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  padding-bottom: 38px;
}

.virtual-row .message-row {
  margin-bottom: 0;
  animation: none; /* 虚拟化后行会滚动进出视口，关闭入场动画避免反复闪烁 */
}

.agent-status {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-left: 0;
  color: var(--muted);
  font-size: 12px;
}

.status-pulse,
.loading-ring {
  display: inline-block;
}

.status-pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.2s ease-in-out infinite;
}

.loading-ring {
  width: 15px;
  height: 15px;
  border: 2px solid #343943;
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

:root[data-theme='light'] .loading-ring {
  border-color: #cfd6c5;
  border-top-color: var(--accent);
}

.composer-dock {
  flex: 0 0 auto;
  width: min(100%, 820px);
  margin: 0 auto;
  padding: 0 16px 10px;
}

.chat-error {
  margin-bottom: 6px;
  padding: 8px 11px;
  border: 1px solid rgba(255, 129, 120, 0.2);
  border-radius: 6px;
  color: #ffc0ba;
  background: rgba(255, 99, 88, 0.09);
  font-size: 11px;
}

.welcome-state,
.empty-conversation,
.center-state {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
}

.welcome-state,
.empty-conversation {
  flex-direction: column;
  text-align: center;
}

.welcome-state {
  padding: 24px;
}

.welcome-state h2,
.empty-conversation h2 {
  margin: 16px 0 13px;
  color: #f0f1f3;
  font-size: clamp(29px, 4vw, 52px);
  font-weight: 650;
  letter-spacing: -0.055em;
  line-height: 1.08;
}

:root[data-theme='light'] .welcome-state h2,
:root[data-theme='light'] .empty-conversation h2 {
  color: var(--text);
}

.welcome-state h2 span {
  color: var(--faint);
  font-family: Georgia, serif;
  font-style: italic;
  font-weight: 600;
}

.welcome-state p,
.empty-conversation p {
  max-width: 500px;
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
}

.welcome-action {
  margin-top: 25px;
  padding: 9px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  color: var(--text);
  background: var(--panel);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: 150ms ease;
}

.welcome-action:hover {
  border-color: var(--line-strong);
  background: var(--panel-soft);
}

.empty-conversation {
  min-height: 100%;
  padding: 30px 20px 60px;
}

.empty-conversation h2 {
  font-size: clamp(26px, 3.2vw, 42px);
}

.empty-symbol {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  margin-bottom: 25px;
  border-radius: 17px;
  color: var(--accent-ink);
  background: var(--accent);
  font-family: Georgia, serif;
  font-weight: 700;
  font-size: 33px;
  box-shadow: 0 18px 50px rgba(201, 226, 83, 0.12);
}

.center-state {
  gap: 10px;
  color: var(--muted);
  font-size: 12px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes pulse {
  50% {
    opacity: 0.35;
    transform: scale(0.8);
  }
}

@media (max-width: 760px) {
  .mobile-menu-button {
    display: block;
  }

  .chat-header {
    min-height: 62px;
    padding: 0 14px;
  }

  .header-meta .model-chip,
  .header-meta .context-chip {
    display: none;
  }

  .branch-strip {
    align-items: flex-start;
    padding: 6px 12px;
    overflow-x: auto;
  }

  .branch-strip-content {
    align-items: stretch;
    padding: 0 11px 8px;
  }

  .branch-error {
    display: none;
  }

  .message-list {
    padding: 26px 17px 35px;
  }

  .composer-dock {
    padding: 0 12px 11px;
  }

  .welcome-state h2 {
    font-size: 35px;
  }
}
</style>
