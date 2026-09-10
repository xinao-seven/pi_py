<!-- 任务面板：当前会话的任务与步骤控制（M2）。状态由服务端按步骤聚合，这里只发命令。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { TaskRecord, TaskRecoveryItem, TaskStep, TaskStepStatus } from '@/types';

const props = defineProps<{
  task: TaskRecord | null;
  sessionId: string | null;
  /** 待恢复清单（M3）：面板只展示与当前任务/会话相关的那几条。 */
  recovery?: TaskRecoveryItem[];
  /** 正在写入（父组件串行化写入，避免 ifRevision 竞争）。 */
  busy?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{
  create: [payload: { title: string; goal: string }];
  'add-step': [payload: { title: string }];
  'set-step-status': [payload: { step: TaskStep; status: TaskStepStatus; reason?: string }];
  'remove-step': [payload: { step: TaskStep; force: boolean }];
  cancel: [];
  refresh: [];
  /** M3：续跑（continue）或重试当前步骤（retry_step）；服务端可能回 409 要确认。 */
  resume: [payload: { mode: 'continue' | 'retry_step' }];
}>();

const collapsed = ref(false);
const draftOpen = ref(false);
const draftTitle = ref('');
const draftGoal = ref('');
const stepDraft = ref('');
const blockingStepId = ref<string | null>(null);
const blockReason = ref('');

const STATUS_LABELS: Record<TaskRecord['status'], string> = {
  pending: '待开始',
  in_progress: '进行中',
  blocked: '已阻塞',
  completed: '已完成',
  cancelled: '已取消',
};

const STEP_LABELS: Record<TaskStepStatus, string> = {
  pending: '待开始',
  in_progress: '进行中',
  completed: '已完成',
  blocked: '阻塞',
  skipped: '跳过',
};

const steps = computed(() => props.task?.steps ?? []);
const doneCount = computed(
  () =>
    steps.value.filter((step) => step.status === 'completed' || step.status === 'skipped').length,
);
const currentStepId = computed(
  () =>
    steps.value.find((step) => step.status === 'in_progress')?.id ??
    steps.value.find((step) => step.status === 'pending')?.id ??
    null,
);
const locked = computed(
  () => props.task?.status === 'cancelled' || props.task?.status === 'completed',
);
/** 与当前任务相关的恢复条目（同任务，或同会话且任务未绑定）。 */
const recoveryItem = computed<TaskRecoveryItem | null>(() => {
  const current = props.task;
  const items = props.recovery ?? [];
  if (current) return items.find((item) => item.taskId === current.id) ?? null;
  return (
    items.find((item) => item.sessionId === undefined || item.sessionId === props.sessionId) ?? null
  );
});
/** 需要展示「继续/重试」入口：有中断项，或任务被阻塞（产物待确认等）。 */
const showRecovery = computed(
  () => recoveryItem.value !== null || props.task?.status === 'blocked',
);

// 任务被替换（切换会话或切换任务）时收起临时输入，避免误提交到别的任务上。
watch(
  () => props.task?.id,
  () => {
    draftOpen.value = false;
    blockingStepId.value = null;
    blockReason.value = '';
    stepDraft.value = '';
  },
);

function submitDraft(): void {
  const title = draftTitle.value.trim();
  const goal = draftGoal.value.trim();
  if (!title || !goal) return;
  emit('create', { title, goal });
  draftTitle.value = '';
  draftGoal.value = '';
  draftOpen.value = false;
}

function submitStep(): void {
  const title = stepDraft.value.trim();
  if (!title) return;
  emit('add-step', { title });
  stepDraft.value = '';
}

function startBlocking(step: TaskStep): void {
  blockingStepId.value = step.id;
  blockReason.value = step.blockedReason ?? '';
}

function confirmBlock(step: TaskStep): void {
  const reason = blockReason.value.trim();
  if (!reason) return;
  emit('set-step-status', { step, status: 'blocked', reason });
  blockingStepId.value = null;
  blockReason.value = '';
}

function removeStep(step: TaskStep): void {
  // 已完成步骤的删除在服务端要求 force：这里明确确认一次，而不是静默加 force。
  const force =
    step.status === 'completed' && window.confirm(`步骤「${step.title}」已完成，确认删除？`);
  if (step.status === 'completed' && !force) return;
  emit('remove-step', { step, force });
}

function stepTitle(step: TaskStep): string {
  return `${String(step.position + 1).padStart(2, '0')} ${step.title}`;
}
</script>

<template>
  <section class="task-panel" :class="{ 'task-panel--collapsed': collapsed }">
    <header class="task-panel-head">
      <button
        class="task-panel-toggle"
        type="button"
        :aria-expanded="!collapsed"
        @click="collapsed = !collapsed"
      >
        <span class="task-badge" :class="`task-badge--${task?.status ?? 'none'}`">
          {{ task ? STATUS_LABELS[task.status] : '任务' }}
        </span>
        <strong v-if="task" class="task-title">{{ task.title }}</strong>
        <span v-else class="task-title">未创建任务</span>
        <span v-if="task && steps.length" class="task-count">
          {{ doneCount }}/{{ steps.length }} 完成
        </span>
        <span class="task-arrow" aria-hidden="true">{{ collapsed ? '▸' : '▾' }}</span>
      </button>
      <div class="task-panel-tools">
        <button type="button" :disabled="busy" title="重新加载" @click="emit('refresh')">⟳</button>
        <button
          v-if="!task && sessionId"
          type="button"
          :disabled="busy"
          @click="draftOpen = !draftOpen"
        >
          新建任务
        </button>
        <button
          v-if="task && !locked && showRecovery"
          type="button"
          class="task-resume"
          :disabled="busy"
          @click="emit('resume', { mode: 'continue' })"
        >
          继续执行
        </button>
        <button
          v-if="task && !locked"
          type="button"
          class="task-cancel"
          :disabled="busy"
          @click="emit('cancel')"
        >
          取消任务
        </button>
      </div>
    </header>

    <div v-if="!collapsed" class="task-panel-body">
      <p v-if="error" class="task-error" role="alert">{{ error }}</p>

      <section v-if="showRecovery" class="task-recovery">
        <header>
          <span aria-hidden="true">⚠</span>
          <strong>{{ recoveryItem ? '上次运行被中断' : '任务被阻塞' }}</strong>
          <span v-if="recoveryItem?.step" class="task-recovery-step">
            当前步骤：[{{ recoveryItem.step.id }}] {{ recoveryItem.step.title }}
          </span>
        </header>
        <p v-if="recoveryItem">{{ recoveryItem.reason }}</p>
        <p v-else-if="task?.blockedReason">{{ task.blockedReason }}</p>
        <p v-if="recoveryItem?.artifact" class="task-recovery-artifact">
          待验证产物：{{ recoveryItem.artifact.path }}（{{
            recoveryItem.artifact.exists ? '已存在' : '未找到'
          }}）
        </p>
        <div class="task-recovery-actions">
          <button type="button" :disabled="busy" @click="emit('resume', { mode: 'continue' })">
            继续执行
          </button>
          <button type="button" :disabled="busy" @click="emit('resume', { mode: 'retry_step' })">
            重试当前步骤
          </button>
          <span v-if="recoveryItem?.requiresConfirmation" class="task-recovery-hint">
            需要你确认副作用风险后再继续
          </span>
        </div>
      </section>

      <form v-if="!task && draftOpen" class="task-draft" @submit.prevent="submitDraft">
        <input v-model="draftTitle" placeholder="任务标题（如：重构 Plan 模式）" maxlength="200" />
        <input v-model="draftGoal" placeholder="目标（完成后应达到什么状态）" maxlength="2000" />
        <button type="submit" :disabled="busy || !draftTitle.trim() || !draftGoal.trim()">
          创建
        </button>
      </form>

      <template v-if="task">
        <p class="task-goal">{{ task.goal }}</p>
        <p v-if="task.blockedReason" class="task-blocked">阻塞原因：{{ task.blockedReason }}</p>
        <p v-if="task.conclusion" class="task-conclusion">结论：{{ task.conclusion }}</p>

        <ol v-if="steps.length" class="task-steps">
          <li
            v-for="step in steps"
            :key="step.id"
            :class="{
              'task-step--completed': step.status === 'completed',
              'task-step--blocked': step.status === 'blocked',
              'task-step--current': step.id === currentStepId,
            }"
          >
            <span class="task-step-number">{{ String(step.position + 1).padStart(2, '0') }}</span>
            <div class="task-step-copy">
              <strong>{{ stepTitle(step) }}</strong>
              <small v-if="step.details">{{ step.details }}</small>
              <small v-if="step.blockedReason" class="task-step-reason">
                阻塞：{{ step.blockedReason }}
              </small>
              <small v-if="step.evidence?.summary" class="task-step-evidence">
                证据：{{ step.evidence.summary }}
              </small>
              <small v-if="step.verification?.kind === 'command'" class="task-step-verify">
                验证：{{ step.verification.command }}
              </small>
            </div>
            <span class="task-step-status" :class="`task-step-status--${step.status}`">
              {{ STEP_LABELS[step.status] }}
            </span>
            <div class="task-step-actions">
              <template v-if="!locked">
                <!-- 已完成的步骤只剩「重开」与「删除」：不再提供阻塞/完成按钮，避免误伤 -->
                <button
                  v-if="step.status === 'completed'"
                  type="button"
                  :disabled="busy"
                  @click="emit('set-step-status', { step, status: 'pending' })"
                >
                  重开
                </button>
                <button
                  v-else-if="step.status === 'blocked'"
                  type="button"
                  :disabled="busy"
                  @click="emit('set-step-status', { step, status: 'pending' })"
                >
                  解除
                </button>
                <template v-else>
                  <button
                    v-if="step.status !== 'in_progress'"
                    type="button"
                    :disabled="busy"
                    @click="emit('set-step-status', { step, status: 'in_progress' })"
                  >
                    开始
                  </button>
                  <button
                    type="button"
                    :disabled="busy"
                    @click="emit('set-step-status', { step, status: 'completed' })"
                  >
                    完成
                  </button>
                  <button type="button" :disabled="busy" @click="startBlocking(step)">阻塞</button>
                </template>
                <button type="button" :disabled="busy" @click="removeStep(step)">删除</button>
              </template>
            </div>

            <form
              v-if="blockingStepId === step.id"
              class="task-block-form"
              @submit.prevent="confirmBlock(step)"
            >
              <input
                v-model="blockReason"
                placeholder="阻塞原因（必填）"
                maxlength="1000"
                autofocus
              />
              <button type="submit" :disabled="busy || !blockReason.trim()">确认</button>
              <button type="button" @click="blockingStepId = null">取消</button>
            </form>
          </li>
        </ol>
        <p v-else class="task-empty">还没有步骤。可以先由 Agent 拆解，或在这里手工添加。</p>

        <form v-if="!locked" class="task-add-step" @submit.prevent="submitStep">
          <input v-model="stepDraft" placeholder="添加步骤…" maxlength="500" />
          <button type="submit" :disabled="busy || !stepDraft.trim()">添加</button>
        </form>
      </template>
      <p v-else-if="sessionId" class="task-empty">
        任务把「目标 + 步骤 + 证据」固化下来，供执行、中断恢复与 Plan 复用。
      </p>
    </div>
  </section>
</template>

<style scoped>
/* 任务面板：与 PlanProgress 同处输入框上方，折叠态只留一行摘要 */
.task-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--panel-raised);
  font-size: 10px;
}

.task-panel-head {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}

.task-panel-toggle {
  display: flex;
  flex: 1 1 auto;
  gap: 8px;
  align-items: center;
  min-width: 0;
  border: 0;
  color: var(--text);
  background: transparent;
  font-size: 10px;
  text-align: left;
  cursor: pointer;
}

.task-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-count {
  flex: 0 0 auto;
  color: var(--faint);
}

.task-arrow {
  flex: 0 0 auto;
  color: var(--faint);
}

.task-badge {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: 999px;
  color: var(--muted);
  background: var(--panel-soft);
  font-size: 9px;
}

.task-badge--in_progress {
  color: var(--accent-ink);
  background: var(--accent);
}

.task-badge--completed {
  color: var(--accent);
  background: rgba(231, 255, 111, 0.12);
}

.task-badge--blocked {
  color: #d8b25f;
  background: rgba(216, 178, 95, 0.14);
}

.task-badge--cancelled {
  color: var(--danger);
  background: rgba(255, 129, 120, 0.12);
}

.task-panel-tools {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
}

.task-panel-tools button,
.task-panel-body button {
  padding: 3px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--muted);
  background: var(--input-bg);
  font-size: 9px;
  cursor: pointer;
}

.task-panel-tools button:disabled,
.task-panel-body button:disabled {
  opacity: 0.55;
  cursor: default;
}

.task-cancel {
  color: var(--danger);
}

.task-resume {
  color: var(--accent);
}

/* 中断恢复提示块（M3）：只提示与入口，真正的判定在服务端 */
.task-recovery {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 8px;
  border: 1px solid rgba(216, 178, 95, 0.35);
  border-radius: 8px;
  background: rgba(216, 178, 95, 0.08);
}

.task-recovery header {
  display: flex;
  gap: 6px;
  align-items: center;
  color: #d8b25f;
}

.task-recovery-step {
  color: var(--muted);
  font-family: 'Cascadia Code', Consolas, monospace;
}

.task-recovery p {
  margin: 0;
  color: var(--muted);
  line-height: 1.6;
}

.task-recovery-artifact {
  font-family: 'Cascadia Code', Consolas, monospace;
}

.task-recovery-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.task-recovery-hint {
  color: #d8b25f;
}

.task-panel-body {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.task-goal,
.task-blocked,
.task-conclusion,
.task-empty {
  margin: 0;
  color: var(--muted);
  line-height: 1.6;
}

.task-blocked {
  color: #d8b25f;
}

.task-error {
  margin: 0;
  color: var(--danger);
}

.task-draft {
  display: grid;
  gap: 6px;
}

.task-draft input,
.task-add-step input,
.task-block-form input {
  padding: 5px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text);
  background: var(--input-bg);
  font-size: 10px;
}

.task-draft button {
  justify-self: end;
}

.task-steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.task-steps li {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto auto;
  gap: 6px;
  align-items: center;
  padding: 5px 7px;
  border-left: 2px solid var(--line-strong);
  border-radius: 6px;
  background: var(--panel-soft);
}

.task-step--current {
  border-left-color: var(--accent);
}

.task-step--completed {
  border-left-color: rgba(231, 255, 111, 0.45);
}

.task-step--blocked {
  border-left-color: #d8b25f;
}

.task-step-number,
.task-step-status {
  color: var(--faint);
  font-family: 'Cascadia Code', Consolas, monospace;
}

.task-step-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.task-step-copy strong {
  overflow: hidden;
  color: var(--text);
  font-weight: 500;
  text-overflow: ellipsis;
}

.task-step-copy small {
  color: var(--faint);
  line-height: 1.5;
}

.task-step--completed .task-step-copy strong {
  color: var(--muted);
  text-decoration: line-through;
}

.task-step-reason {
  color: #d8b25f;
}

.task-step-actions {
  display: flex;
  gap: 4px;
}

.task-block-form {
  grid-column: 2 / -1;
  display: flex;
  gap: 5px;
}

.task-block-form input {
  flex: 1 1 auto;
}

.task-add-step {
  display: flex;
  gap: 6px;
}

.task-add-step input {
  flex: 1 1 auto;
}
</style>
