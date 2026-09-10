<script setup lang="ts">
// 计划面板（M4）：展示并操作「作为任务存在的计划」。
//
// 中文说明：M4 起计划就是 origin='plan' 的任务（PlanView 是它的只读投影），因此这里
// 展示的东西和任务面板同源：步骤状态、验证声明（verification）与完成证据（evidence）。
// 模型不再写任何标记（Plan:/[DONE:n]）——步骤推进由 complete_step 工具完成，
// 面板上的改名/跳过/恢复/删除走任务接口（PATCH/DELETE /api/tasks/:id/steps/...），
// 由 ChatWindow 统一处理乐观并发与冲突重试。
import { computed, ref } from 'vue';

import type { PlanStatus, PlanStepView, PlanView, TaskStepStatus } from '@/types';

const props = defineProps<{
  plan: PlanView | null;
  sessionId: string | null;
  busy: boolean;
}>();

const emit = defineEmits<{
  execute: [];
  pause: [];
  resume: [];
  abandon: [];
  refine: [message: string];
  /** 步骤改名/跳过/恢复：复用任务面板的写入通道。 */
  stepPatch: [payload: { stepId: string; patch: { title?: string; status?: TaskStepStatus } }];
  stepRemove: [payload: { stepId: string }];
}>();

const refineText = ref('');
const collapsed = ref(false);
const editingId = ref<string | null>(null);
const editingTitle = ref('');

const STATUS_LABEL: Record<PlanStatus, string> = {
  drafting: '规划中',
  proposed: '待确认',
  executing: '执行中',
  paused: '已暂停',
  completed: '已完成',
  abandoned: '已放弃',
};
const STEP_LABEL: Record<TaskStepStatus, string> = {
  pending: '待开始',
  in_progress: '进行中',
  completed: '已完成',
  blocked: '已阻塞',
  skipped: '已跳过',
};

const visible = computed(() => Boolean(props.plan && props.plan.planId));
const statusLabel = computed(() => (props.plan ? STATUS_LABEL[props.plan.status] : ''));
const doneCount = computed(
  () =>
    props.plan?.steps.filter((step) => step.status === 'completed' || step.status === 'skipped')
      .length ?? 0,
);
const total = computed(() => props.plan?.steps.length ?? 0);
const currentStep = computed(
  () =>
    props.plan?.steps.find((step) => step.status === 'in_progress') ??
    props.plan?.steps.find((step) => step.status === 'pending'),
);
const canExecute = computed(() => props.plan?.status === 'proposed');
const canPause = computed(() => props.plan?.status === 'executing');
const canResume = computed(() => props.plan?.status === 'paused');
const terminal = computed(
  () => props.plan?.status === 'completed' || props.plan?.status === 'abandoned',
);
/** 终态之外都可以改步骤（执行中改「还没做」的步骤是 M4 的明确需求）。 */
const editable = computed(() => Boolean(props.plan) && !terminal.value);

function stepNote(step: PlanStepView): string {
  if (step.status === 'blocked' && step.blockedReason) return `已阻塞：${step.blockedReason}`;
  if (step.evidence?.summary) return `证据：${step.evidence.summary}`;
  if (step.evidence?.commands?.length) {
    const command = step.evidence.commands[0];
    return `证据：${command.command}（退出码 ${command.exitCode ?? '未知'}）`;
  }
  if (step.verification?.kind === 'file') return `需产物：${step.verification.path ?? '未声明'}`;
  if (step.verification?.kind === 'command') {
    return `需命令：${step.verification.command ?? '未声明'}（退出码 ${step.verification.expectExitCode ?? 0}）`;
  }
  if (step.verification?.kind === 'manual') return '完成时需人工确认说明';
  if (step.status === 'in_progress') return '进行中';
  if (step === currentStep.value) return '下一步';
  return STEP_LABEL[step.status];
}

function startEdit(step: PlanStepView): void {
  if (!editable.value) return;
  editingId.value = step.id;
  editingTitle.value = step.title;
}

function commitEdit(step: PlanStepView): void {
  const title = editingTitle.value.trim();
  editingId.value = null;
  if (!title || title === step.title) return;
  emit('stepPatch', { stepId: step.id, patch: { title } });
}

function skipStep(step: PlanStepView): void {
  emit('stepPatch', { stepId: step.id, patch: { status: 'skipped' } });
}

function reopenStep(step: PlanStepView): void {
  emit('stepPatch', { stepId: step.id, patch: { status: 'pending' } });
}

function submitRefine(): void {
  const message = refineText.value.trim();
  if (!message) return;
  emit('refine', message);
  refineText.value = '';
}
</script>

<template>
  <section v-if="visible" class="plan-progress" :class="{ 'plan-progress--collapsed': collapsed }">
    <button
      class="plan-progress-head"
      type="button"
      :aria-expanded="!collapsed"
      @click="collapsed = !collapsed"
    >
      <span class="plan-progress-badge">{{ statusLabel }}</span>
      <span v-if="total" class="plan-progress-count">{{ doneCount }}/{{ total }} 完成</span>
      <span class="plan-progress-title">{{ plan?.title }}</span>
      <span class="plan-progress-arrow" aria-hidden="true">{{ collapsed ? '▸' : '▾' }}</span>
    </button>

    <div v-if="!collapsed" class="plan-progress-body">
      <ol v-if="total" class="plan-steps">
        <li
          v-for="step in plan?.steps ?? []"
          :key="step.id"
          :class="{
            'plan-step--completed': step.status === 'completed' || step.status === 'skipped',
            'plan-step--blocked': step.status === 'blocked',
            'plan-step--current': step.status === 'in_progress' || step === currentStep,
          }"
        >
          <span class="plan-step-number">
            {{ String(step.id).replace(/^s/, '').padStart(2, '0') }}
          </span>
          <div class="plan-step-copy">
            <input
              v-if="editingId === step.id"
              v-model="editingTitle"
              class="plan-step-input"
              :disabled="busy"
              @keydown.enter="commitEdit(step)"
              @keydown.esc="editingId = null"
              @blur="commitEdit(step)"
            />
            <strong v-else @dblclick="startEdit(step)">{{ step.title }}</strong>
            <small>{{ stepNote(step) }}</small>
          </div>
          <span v-if="editable" class="plan-step-actions">
            <button type="button" :disabled="busy" title="重命名" @click="startEdit(step)">
              改名
            </button>
            <button
              v-if="step.status !== 'skipped'"
              type="button"
              :disabled="busy"
              title="跳过这一步"
              @click="skipStep(step)"
            >
              跳过
            </button>
            <button v-else type="button" :disabled="busy" title="恢复为待开始" @click="reopenStep(step)">
              恢复
            </button>
            <button
              type="button"
              :disabled="busy"
              title="删除这一步"
              @click="emit('stepRemove', { stepId: step.id })"
            >
              删除
            </button>
          </span>
        </li>
      </ol>

      <p v-if="plan?.status === 'drafting'" class="plan-empty">
        Agent 正在调研并撰写计划；它提交计划后会显示在这里（不需要它写任何特殊标记）。
      </p>
      <p v-else-if="plan?.status === 'proposed'" class="plan-empty">
        计划已提交，等待你确认后开始执行（确认前 Agent 不会改动工作区）。
      </p>
      <p v-else-if="plan?.status === 'executing'" class="plan-progress-note">
        执行中：Agent 每完成一步会通过 complete_step 汇报并附上证据，服务端按步骤声明的
        verification 校验后才算完成。
      </p>
      <p v-else-if="plan?.status === 'paused'" class="plan-empty">
        计划已暂停{{
          plan.steps.some((step) => step.status === 'blocked') ? '（有步骤被阻塞）' : ''
        }}；处理完可以点「继续执行」。
      </p>

      <div v-if="canExecute && total" class="plan-confirm">
        <textarea
          v-model="refineText"
          rows="2"
          placeholder="需要调整时说明你的要求（Agent 会用 update_plan 修订）"
          :disabled="busy"
        />
        <div class="plan-confirm-actions">
          <button class="primary-action" :disabled="busy" @click="emit('execute')">
            确认并执行
          </button>
          <button :disabled="busy || !refineText.trim()" @click="submitRefine">继续细化</button>
          <button :disabled="busy" @click="emit('abandon')">放弃此计划</button>
        </div>
      </div>

      <div v-if="!canExecute && !terminal" class="plan-progress-actions">
        <button v-if="canPause" type="button" :disabled="busy" @click="emit('pause')">暂停</button>
        <button v-if="canResume" type="button" :disabled="busy" @click="emit('resume')">
          继续执行
        </button>
        <button
          v-if="!terminal"
          type="button"
          :disabled="busy || !refineText.trim()"
          @click="submitRefine"
        >
          按我的要求调整
        </button>
        <button v-if="!terminal" type="button" :disabled="busy" @click="emit('abandon')">
          放弃计划
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Plan 进度内联面板：固定在输入框上方，实时展示规划/执行进度与确认区 */
.plan-progress {
  margin: 0 0 7px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: linear-gradient(135deg, rgba(231, 255, 111, 0.035), transparent 35%), var(--panel);
}

.plan-progress-head {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.plan-progress-badge {
  padding: 1px 6px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  color: var(--accent);
  font-size: 10px;
}

.plan-progress-title {
  flex: 1;
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-progress-count {
  color: var(--faint);
  font-size: 10px;
}

.plan-progress-arrow {
  color: var(--faint);
  font-size: 10px;
}

.plan-progress-body {
  padding: 0 9px 9px;
}

.plan-progress-note {
  margin: 6px 0 0;
  color: var(--faint);
  font-size: 10px;
}

.plan-progress-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}

.plan-progress-actions > button {
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 11px;
}

.plan-progress-actions > button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}

.plan-empty {
  margin: 6px 0 0;
  color: var(--faint);
  font-size: 11px;
}

.plan-confirm {
  display: flex;
  gap: 6px;
  align-items: flex-end;
  margin-top: 7px;
}

.plan-confirm textarea {
  flex: 1;
  padding: 5px 7px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg);
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

.plan-confirm-actions button {
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 11px;
}

.plan-confirm-actions button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}

.plan-confirm-actions .primary-action {
  border-color: var(--accent);
  color: var(--accent);
}

.plan-confirm-actions .primary-action:hover:not(:disabled) {
  background: rgba(231, 255, 111, 0.08);
}

.plan-confirm-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.plan-steps {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}

.plan-steps li {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  padding: 4px 0;
  border-top: 1px solid var(--line-soft, rgba(255, 255, 255, 0.04));
}

.plan-steps li:first-child {
  border-top: 0;
}

.plan-step-number {
  min-width: 18px;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
}

.plan-step-copy {
  flex: 1;
  min-width: 0;
}

.plan-step-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.plan-steps li:hover .plan-step-actions {
  opacity: 1;
}

.plan-step-actions button {
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
  font-size: 10px;
}

.plan-step-actions button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}

.plan-step-input {
  width: 100%;
  padding: 2px 5px;
  border: 1px solid var(--accent);
  border-radius: 3px;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
}

.plan-step--completed .plan-step-copy strong {
  color: var(--faint);
  text-decoration: line-through;
}

.plan-step--blocked .plan-step-copy small {
  color: var(--danger, #ff8080);
}

.plan-step--current .plan-step-copy strong {
  color: var(--accent);
}

.plan-step-copy strong,
.plan-step-copy small {
  display: block;
}

.plan-step-copy strong {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-step-copy small {
  margin-top: 4px;
  color: var(--faint);
  font-size: 10px;
}
</style>
