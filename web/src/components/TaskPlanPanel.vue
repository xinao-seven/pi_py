<!-- 计划/任务面板：右上角按钮点开的悬浮面板（不可拖动）的内容体。 -->
<script setup lang="ts">
// 中文说明：M4 起「计划」就是 origin='plan' 的任务，两者是同一份真相源的不同视角。
// 合并前的 PlanProgress 与 TaskPanel 会被同一条任务渲染两遍（模型提交计划后任务列表里
// 也出现它），既占地方又让人分不清该点哪个按钮。
// 合并规则只有一条：计划活跃时以计划视角展示它自己的那条任务，任务区只在会话里还存在
// 「不是这条计划」的任务时才出现 —— 因此永远不会有第二份重复列表。
// 写入仍然全部走父组件（ChatWindow）的乐观并发包装，这里只发事件。
import { computed, ref } from 'vue';

import TaskStepList from '@/components/TaskStepList.vue';
import type {
  PlanStatus,
  PlanStepView,
  PlanView,
  TaskRecord,
  TaskRecoveryItem,
  TaskStep,
  TaskStepStatus,
} from '@/types';

const props = withDefaults(
  defineProps<{
    plan: PlanView | null;
    task: TaskRecord | null;
    sessionId: string | null;
    /** 待恢复清单（M3）：只展示与当前任务/会话相关的那几条。 */
    recovery?: TaskRecoveryItem[];
    /** 正在写入（父组件串行化写入，避免 ifRevision 竞争）。 */
    busy?: boolean;
    error?: string | null;
  }>(),
  { recovery: () => [], busy: false, error: null },
);

const emit = defineEmits<{
  close: [];
  refresh: [];
  /** 计划命令（M4）：执行/暂停/继续/放弃/细化。 */
  planExecute: [];
  planPause: [];
  planResume: [];
  planAbandon: [];
  planRefine: [message: string];
  /** 计划步骤编辑：复用任务接口（改名/跳过/恢复/删除）。 */
  stepPatch: [payload: { stepId: string; patch: { title?: string; status?: TaskStepStatus } }];
  stepRemove: [payload: { stepId: string }];
  /** 任务命令（M2/M3）。 */
  create: [payload: { title: string; goal: string }];
  addStep: [payload: { title: string }];
  setStepStatus: [payload: { step: TaskStep; status: TaskStepStatus; reason?: string }];
  removeStep: [payload: { step: TaskStep; force: boolean }];
  cancelTask: [];
  resumeTask: [payload: { mode: 'continue' | 'retry_step' }];
}>();

const refineText = ref('');
const draftOpen = ref(false);
const draftTitle = ref('');
const draftGoal = ref('');
const stepDraft = ref('');

const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  drafting: '规划中',
  proposed: '待确认',
  executing: '执行中',
  paused: '已暂停',
  completed: '已完成',
  abandoned: '已放弃',
};
const TASK_STATUS_LABEL: Record<TaskRecord['status'], string> = {
  pending: '待开始',
  in_progress: '进行中',
  blocked: '已阻塞',
  completed: '已完成',
  cancelled: '已取消',
};

/** 计划是否活跃：planId 为空串表示这个会话当前没有计划。 */
const planActive = computed(() => Boolean(props.plan?.planId));
const planSteps = computed<PlanStepView[]>(() =>
  planActive.value ? (props.plan?.steps ?? []) : [],
);
const taskSection = computed<TaskRecord | null>(() => {
  const task = props.task;
  if (!task) return null;
  // 计划活跃时，它自己的那条任务不重复展示（计划区就是它的视图）。
  if (planActive.value && task.id === props.plan?.taskId) return null;
  return task;
});
const taskSteps = computed<TaskStep[]>(() => taskSection.value?.steps ?? []);
const primarySteps = computed<(PlanStepView | TaskStep)[]>(() =>
  planActive.value ? planSteps.value : taskSteps.value,
);

const statusLabel = computed(() => {
  if (planActive.value && props.plan) return PLAN_STATUS_LABEL[props.plan.status];
  const task = taskSection.value ?? props.task;
  return task ? TASK_STATUS_LABEL[task.status] : '未创建任务';
});
const badgeKind = computed(() => {
  if (planActive.value && props.plan) return `plan-${props.plan.status}`;
  const task = taskSection.value ?? props.task;
  return task ? `task-${task.status}` : 'none';
});
const title = computed(
  () => props.plan?.title ?? taskSection.value?.title ?? props.task?.title ?? '计划与任务',
);
const doneCount = computed(
  () =>
    primarySteps.value.filter((step) => step.status === 'completed' || step.status === 'skipped')
      .length,
);
/** 当前步骤（进行中优先，其次下一个待开始）：用来标「下一步」。 */
function currentStepIdOf(steps: (PlanStepView | TaskStep)[]): string | null {
  return (
    steps.find((step) => step.status === 'in_progress')?.id ??
    steps.find((step) => step.status === 'pending')?.id ??
    null
  );
}

const canExecute = computed(() => props.plan?.status === 'proposed' && planSteps.value.length > 0);
const canPause = computed(() => props.plan?.status === 'executing');
const canResume = computed(() => props.plan?.status === 'paused');
const planTerminal = computed(
  () => props.plan?.status === 'completed' || props.plan?.status === 'abandoned',
);
/** 终态之外都可以改步骤（执行中改「还没做」的步骤是 M4 的明确需求）。 */
const planEditable = computed(() => planActive.value && !planTerminal.value);
const planNote = computed(() => {
  const plan = props.plan;
  if (!plan) return '';
  switch (plan.status) {
    case 'drafting':
      return 'Agent 正在调研并撰写计划；它提交计划后会显示在这里（不需要它写任何特殊标记）。';
    case 'proposed':
      return '计划已提交，等待你确认后开始执行（确认前 Agent 不会改动工作区）。';
    case 'executing':
      return '执行中：Agent 每完成一步会通过 complete_step 汇报并附上证据，服务端按步骤声明的 verification 校验后才算完成。';
    case 'paused':
      return plan.steps.some((step) => step.status === 'blocked')
        ? '计划已暂停（有步骤被阻塞）；处理完可以点「继续执行」。'
        : '计划已暂停；处理完可以点「继续执行」。';
    default:
      return '';
  }
});

const taskLocked = computed(
  () => taskSection.value?.status === 'cancelled' || taskSection.value?.status === 'completed',
);
/** 面板头部徽标对应的任务（计划活跃时是计划自己的任务，用来判断恢复入口）。 */
const activeTask = computed(() => taskSection.value ?? props.task);
/** 与当前任务相关的恢复条目（同任务，或同会话且任务未绑定）。 */
const recoveryItem = computed<TaskRecoveryItem | null>(() => {
  const items = props.recovery;
  if (activeTask.value) return items.find((item) => item.taskId === activeTask.value?.id) ?? null;
  return (
    items.find((item) => item.sessionId === undefined || item.sessionId === props.sessionId) ?? null
  );
});
/** 需要展示「继续/重试」入口：有中断项，或任务被阻塞（产物待确认等）。 */
const showRecovery = computed(
  () => recoveryItem.value !== null || activeTask.value?.status === 'blocked',
);
const emptyState = computed(() => !planActive.value && !props.task && Boolean(props.sessionId));

function submitRefine(): void {
  const message = refineText.value.trim();
  if (!message) return;
  emit('planRefine', message);
  refineText.value = '';
}

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
  emit('addStep', { title });
  stepDraft.value = '';
}
</script>

<template>
  <section class="work-panel" role="dialog" aria-label="计划与任务">
    <header class="work-panel-head">
      <span class="work-badge" :class="`work-badge--${badgeKind}`">{{ statusLabel }}</span>
      <strong class="work-title" :title="title">{{ title }}</strong>
      <span v-if="primarySteps.length" class="work-count">
        {{ doneCount }}/{{ primarySteps.length }} 完成
      </span>
      <div class="work-panel-tools">
        <button
          v-if="emptyState && !draftOpen"
          type="button"
          :disabled="busy"
          @click="draftOpen = true"
        >
          新建任务
        </button>
        <button type="button" :disabled="busy" title="重新加载" @click="emit('refresh')">⟳</button>
        <button type="button" title="收起面板" @click="emit('close')">✕</button>
      </div>
    </header>

    <div class="work-panel-body">
      <p v-if="error" class="work-error" role="alert">{{ error }}</p>

      <!-- M3 中断恢复：只提示与入口，真正的判定在服务端 -->
      <section v-if="showRecovery" class="work-recovery">
        <header>
          <span aria-hidden="true">⚠</span>
          <strong>{{ recoveryItem ? '上次运行被中断' : '任务被阻塞' }}</strong>
          <span v-if="recoveryItem?.step" class="work-recovery-step">
            当前步骤：[{{ recoveryItem.step.id }}] {{ recoveryItem.step.title }}
          </span>
        </header>
        <p v-if="recoveryItem">{{ recoveryItem.reason }}</p>
        <p v-else-if="activeTask?.blockedReason">{{ activeTask?.blockedReason }}</p>
        <p v-if="recoveryItem?.artifact" class="work-recovery-artifact">
          待验证产物：{{ recoveryItem.artifact.path }}（{{
            recoveryItem.artifact.exists ? '已存在' : '未找到'
          }}）
        </p>
        <div class="work-recovery-actions">
          <button type="button" :disabled="busy" @click="emit('resumeTask', { mode: 'continue' })">
            继续执行
          </button>
          <button
            type="button"
            :disabled="busy"
            @click="emit('resumeTask', { mode: 'retry_step' })"
          >
            重试当前步骤
          </button>
          <span v-if="recoveryItem?.requiresConfirmation" class="work-recovery-hint">
            需要你确认副作用风险后再继续
          </span>
        </div>
      </section>

      <!-- 计划区：计划活跃时它就是这条任务的视图，步骤只在这里渲染一次 -->
      <section v-if="planActive" class="work-section plan-section">
        <p class="plan-goal">{{ plan?.goal }}</p>
        <p v-if="planNote" class="plan-note">{{ planNote }}</p>

        <TaskStepList
          v-if="planSteps.length"
          :steps="planSteps"
          mode="plan"
          :current-step-id="currentStepIdOf(planSteps)"
          :editable="planEditable"
          :busy="busy"
          @patch="emit('stepPatch', $event)"
          @remove-plan-step="emit('stepRemove', $event)"
        />

        <div v-if="canExecute" class="plan-confirm">
          <textarea
            v-model="refineText"
            rows="2"
            placeholder="需要调整时说明你的要求（Agent 会用 update_plan 修订）"
            :disabled="busy"
          />
          <div class="plan-confirm-actions">
            <button class="primary-action" :disabled="busy" @click="emit('planExecute')">
              确认并执行
            </button>
            <button :disabled="busy || !refineText.trim()" @click="submitRefine">继续细化</button>
            <button :disabled="busy" @click="emit('planAbandon')">放弃此计划</button>
          </div>
        </div>

        <div v-else-if="!planTerminal" class="plan-actions">
          <input
            v-model="refineText"
            placeholder="按我的要求调整（Agent 会用 update_plan 修订）"
            :disabled="busy"
          />
          <button v-if="canPause" type="button" :disabled="busy" @click="emit('planPause')">
            暂停
          </button>
          <button v-if="canResume" type="button" :disabled="busy" @click="emit('planResume')">
            继续执行
          </button>
          <button type="button" :disabled="busy || !refineText.trim()" @click="submitRefine">
            提交要求
          </button>
          <button type="button" :disabled="busy" @click="emit('planAbandon')">放弃计划</button>
        </div>
      </section>

      <!-- 任务区：只在「不是当前计划」时出现，避免同一条任务被渲染两遍 -->
      <section v-if="taskSection" class="work-section task-section">
        <header v-if="planActive" class="work-section-head">
          <h4>会话任务</h4>
          <strong class="work-section-title" :title="taskSection.title">
            {{ taskSection.title }}
          </strong>
          <span class="work-badge" :class="`work-badge--task-${taskSection.status}`">
            {{ TASK_STATUS_LABEL[taskSection.status] }}
          </span>
        </header>
        <p class="task-goal">{{ taskSection.goal }}</p>
        <p v-if="taskSection.blockedReason" class="task-blocked">
          阻塞原因：{{ taskSection.blockedReason }}
        </p>
        <p v-if="taskSection.conclusion" class="task-conclusion">
          结论：{{ taskSection.conclusion }}
        </p>

        <TaskStepList
          v-if="taskSteps.length"
          :steps="taskSteps"
          mode="task"
          :current-step-id="currentStepIdOf(taskSteps)"
          :editable="!taskLocked"
          :busy="busy"
          @set-status="emit('setStepStatus', $event)"
          @remove-task-step="emit('removeStep', $event)"
        />
        <p v-else class="task-empty">还没有步骤。可以先由 Agent 拆解，或在这里手工添加。</p>

        <form v-if="!taskLocked" class="task-add-step" @submit.prevent="submitStep">
          <input v-model="stepDraft" placeholder="添加步骤…" maxlength="500" />
          <button type="submit" :disabled="busy || !stepDraft.trim()">添加</button>
        </form>
        <div v-if="!taskLocked" class="task-actions">
          <button type="button" class="task-cancel" :disabled="busy" @click="emit('cancelTask')">
            取消任务
          </button>
        </div>
      </section>

      <!-- 空态：没有计划也没有任务，给一个手工建任务的入口 -->
      <template v-if="emptyState">
        <form v-if="draftOpen" class="task-draft" @submit.prevent="submitDraft">
          <input
            v-model="draftTitle"
            placeholder="任务标题（如：重构 Plan 模式）"
            maxlength="200"
          />
          <input v-model="draftGoal" placeholder="目标（完成后应达到什么状态）" maxlength="2000" />
          <button type="submit" :disabled="busy || !draftTitle.trim() || !draftGoal.trim()">
            创建
          </button>
        </form>
        <p v-else class="task-empty">
          未创建任务 —— 任务把「目标 + 步骤 + 证据」固化下来，供执行、中断恢复与 Plan 复用。
        </p>
      </template>
    </div>
  </section>
</template>

<style scoped>
/* 悬浮面板本体只负责内容与滚动，定位（右上角锚点）由父组件的 host 决定 */
.work-panel {
  display: flex;
  flex-direction: column;
  max-height: 100%;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--panel-raised);
  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.42);
  font-size: 10px;
}

:root[data-theme='light'] .work-panel {
  background: #ffffff;
  box-shadow: 0 18px 40px rgba(23, 32, 23, 0.16);
}

.work-panel-head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
}

.work-title {
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--text);
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.work-count {
  flex: 0 0 auto;
  color: var(--faint);
}

.work-badge {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: 999px;
  color: var(--muted);
  background: var(--panel-soft);
  font-size: 9px;
}

.work-badge--plan-proposed {
  border: 1px solid var(--accent);
  color: var(--accent);
}

.work-badge--plan-executing,
.work-badge--task-in_progress {
  color: var(--accent-ink);
  background: var(--accent);
}

.work-badge--plan-completed,
.work-badge--task-completed {
  color: var(--accent);
  background: rgba(231, 255, 111, 0.12);
}

.work-badge--plan-paused,
.work-badge--task-blocked {
  color: #d8b25f;
  background: rgba(216, 178, 95, 0.14);
}

.work-badge--plan-abandoned,
.work-badge--task-cancelled {
  color: var(--danger);
  background: rgba(255, 129, 120, 0.12);
}

.work-panel-tools {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
}

.work-panel-tools button,
.work-panel-body button {
  padding: 3px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--muted);
  background: var(--input-bg);
  font-size: 9px;
  cursor: pointer;
}

.work-panel-tools button:hover:not(:disabled),
.work-panel-body button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}

.work-panel-tools button:disabled,
.work-panel-body button:disabled {
  opacity: 0.5;
  cursor: default;
}

.work-panel-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 10px 11px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.work-error {
  margin: 0;
  color: var(--danger);
}

.work-section {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.work-section-head {
  display: flex;
  gap: 6px;
  align-items: center;
}

.work-section-head h4 {
  margin: 0;
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
}

.work-section-title {
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--text);
  font-size: 10px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-goal,
.task-goal,
.task-blocked,
.task-conclusion,
.task-empty,
.plan-note {
  margin: 0;
  color: var(--muted);
  line-height: 1.6;
}

.plan-note {
  color: var(--faint);
}

.task-blocked {
  color: #d8b25f;
}

/* 计划确认区（待确认）：文本框 + 竖排按钮 */
.plan-confirm {
  display: flex;
  gap: 6px;
  align-items: flex-end;
  margin-top: 4px;
}

.plan-confirm textarea {
  flex: 1;
  padding: 5px 7px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--input-bg);
  color: var(--text);
  font-family: inherit;
  font-size: 11px;
  resize: vertical;
}

.plan-confirm-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.plan-confirm-actions .primary-action {
  border-color: var(--accent);
  color: var(--accent);
}

.plan-confirm-actions .primary-action:hover:not(:disabled) {
  background: rgba(231, 255, 111, 0.08);
}

/* 执行中/已暂停的调整入口 */
.plan-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-top: 4px;
}

.plan-actions input {
  flex: 1 1 150px;
  min-width: 110px;
  padding: 4px 7px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--input-bg);
  color: var(--text);
  font-family: inherit;
  font-size: 10px;
}

/* 中断恢复提示块（M3） */
.work-recovery {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 8px;
  border: 1px solid rgba(216, 178, 95, 0.35);
  border-radius: 8px;
  background: rgba(216, 178, 95, 0.08);
}

.work-recovery header {
  display: flex;
  gap: 6px;
  align-items: center;
  color: #d8b25f;
}

.work-recovery-step {
  color: var(--muted);
  font-family: 'Cascadia Code', Consolas, monospace;
}

.work-recovery p {
  margin: 0;
  color: var(--muted);
  line-height: 1.6;
}

.work-recovery-artifact {
  font-family: 'Cascadia Code', Consolas, monospace;
}

.work-recovery-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.work-recovery-hint {
  color: #d8b25f;
}

.task-add-step {
  display: flex;
  gap: 6px;
}

.task-add-step input {
  flex: 1 1 auto;
}

.task-draft {
  display: grid;
  gap: 6px;
}

.task-draft button {
  justify-self: end;
}

.task-actions {
  display: flex;
  justify-content: flex-end;
}

.task-cancel {
  color: var(--danger);
}

.work-panel-body input {
  padding: 5px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text);
  background: var(--input-bg);
  font-family: inherit;
  font-size: 10px;
}

@media (max-width: 760px) {
  /*
   * 面板窄屏下几乎占满屏宽：头部允许换行（而不是把标题/按钮挤扁），
   * 按钮统一 nowrap + 保持固有宽度，触摸目标抬到 26px 左右。
   */
  .work-panel-head {
    flex-wrap: wrap;
    gap: 6px;
    padding: 7px 9px;
  }

  .work-panel-tools button,
  .work-panel-body button {
    flex: 0 0 auto;
    padding: 5px 9px;
    white-space: nowrap;
  }

  .work-panel-body {
    gap: 7px;
    padding: 8px 9px 10px;
  }
}
</style>
