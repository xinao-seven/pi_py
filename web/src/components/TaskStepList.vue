<!-- 步骤列表：计划视角与任务视角共用一套行渲染，避免两处措辞/样式漂移。 -->
<script setup lang="ts">
// 中文说明：合并面板后，计划与任务的步骤行只差「操作按钮走哪条事件通道」和「序号怎么取」。
// 把行渲染收在这里，上层两个区块就只剩各自的目标/操作区，不会复制一份 60 行的列表。
import { computed, ref } from 'vue';

import type { PlanStepView, TaskStep, TaskStepStatus } from '@/types';

const props = withDefaults(
  defineProps<{
    steps: (PlanStepView | TaskStep)[];
    /** plan：计划视角（改名/跳过/恢复/删除）；task：任务视角（开始/完成/阻塞/解除/重开/删除）。 */
    mode: 'plan' | 'task';
    currentStepId?: string | null;
    /** 是否允许写操作（计划终态 / 任务终态为 false）。 */
    editable?: boolean;
    busy?: boolean;
  }>(),
  { currentStepId: null, editable: true, busy: false },
);

const emit = defineEmits<{
  /** 计划步骤编辑（改名/跳过/恢复）。 */
  patch: [payload: { stepId: string; patch: { title?: string; status?: TaskStepStatus } }];
  removePlanStep: [payload: { stepId: string }];
  /** 任务步骤状态写入。 */
  setStatus: [payload: { step: TaskStep; status: TaskStepStatus; reason?: string }];
  removeTaskStep: [payload: { step: TaskStep; force: boolean }];
}>();

const STEP_LABEL: Record<TaskStepStatus, string> = {
  pending: '待开始',
  in_progress: '进行中',
  completed: '已完成',
  blocked: '已阻塞',
  skipped: '已跳过',
};

const editingId = ref<string | null>(null);
const editingTitle = ref('');
const blockingStepId = ref<string | null>(null);
const blockReason = ref('');

const planMode = computed(() => props.mode === 'plan');

/** 步骤副标题：证据 / 验证声明 / 阻塞原因 / 下一步（两套视角的原始规则完全一致）。 */
function stepNote(step: PlanStepView | TaskStep): string {
  if (step.status === 'blocked' && step.blockedReason) return `已阻塞：${step.blockedReason}`;
  if (step.evidence?.summary) return `证据：${step.evidence.summary}`;
  if (step.evidence?.commands?.length) {
    const command = step.evidence.commands[0];
    return `证据：${command.command}（退出码 ${command.exitCode ?? '未知'}）`;
  }
  if (step.verification?.kind === 'file') return `需产物：${step.verification.path ?? '未声明'}`;
  if (step.verification?.kind === 'command') {
    return `需命令：${step.verification.command ?? '未声明'}（退出码 ${
      step.verification.expectExitCode ?? 0
    }）`;
  }
  if (step.verification?.kind === 'manual') return '完成时需人工确认说明';
  if (step.status === 'in_progress') return '进行中';
  if (step.id === props.currentStepId) return '下一步';
  return STEP_LABEL[step.status];
}

function stepNumber(step: PlanStepView | TaskStep, index: number): string {
  if (planMode.value) return String(step.id).replace(/^s/, '').padStart(2, '0');
  return String((step as TaskStep).position + 1 || index + 1).padStart(2, '0');
}

function startEdit(step: PlanStepView | TaskStep): void {
  if (!planMode.value || !props.editable) return;
  editingId.value = step.id;
  editingTitle.value = step.title;
}

function commitEdit(step: PlanStepView | TaskStep): void {
  const title = editingTitle.value.trim();
  editingId.value = null;
  if (!title || title === step.title) return;
  emit('patch', { stepId: step.id, patch: { title } });
}

function skipStep(step: PlanStepView | TaskStep): void {
  emit('patch', { stepId: step.id, patch: { status: 'skipped' } });
}

function reopenStep(step: PlanStepView | TaskStep): void {
  emit('patch', { stepId: step.id, patch: { status: 'pending' } });
}

function removePlanStep(step: PlanStepView | TaskStep): void {
  if (
    step.status === 'completed' &&
    !window.confirm('这一步已完成，删除会丢失它的证据，确定吗？')
  ) {
    return;
  }
  emit('removePlanStep', { stepId: step.id });
}

function setStatus(step: PlanStepView | TaskStep, status: TaskStepStatus, reason?: string): void {
  emit('setStatus', { step: step as TaskStep, status, ...(reason ? { reason } : {}) });
}

function startBlocking(step: PlanStepView | TaskStep): void {
  blockingStepId.value = step.id;
  blockReason.value = step.blockedReason ?? '';
}

function confirmBlock(step: PlanStepView | TaskStep): void {
  const reason = blockReason.value.trim();
  if (!reason) return;
  setStatus(step, 'blocked', reason);
  blockingStepId.value = null;
  blockReason.value = '';
}

function removeTaskStep(step: PlanStepView | TaskStep): void {
  // 已完成步骤的删除在服务端要求 force：这里明确确认一次，而不是静默加 force。
  const force =
    step.status === 'completed' && window.confirm(`步骤「${step.title}」已完成，确认删除？`);
  if (step.status === 'completed' && !force) return;
  emit('removeTaskStep', { step: step as TaskStep, force });
}
</script>

<template>
  <ol class="work-steps">
    <li
      v-for="(step, index) in steps"
      :key="step.id"
      :class="{
        'work-step--completed': step.status === 'completed' || step.status === 'skipped',
        'work-step--blocked': step.status === 'blocked',
        'work-step--current': step.status === 'in_progress' || step.id === currentStepId,
      }"
    >
      <span class="work-step-number">{{ stepNumber(step, index) }}</span>
      <div class="work-step-copy">
        <input
          v-if="editingId === step.id"
          v-model="editingTitle"
          class="work-step-input"
          :disabled="busy"
          @keydown.enter="commitEdit(step)"
          @keydown.esc="editingId = null"
          @blur="commitEdit(step)"
        />
        <strong v-else :title="step.title" @dblclick="startEdit(step)">{{ step.title }}</strong>
        <small v-if="step.details" class="work-step-detail">{{ step.details }}</small>
        <small class="work-step-note">{{ stepNote(step) }}</small>
      </div>

      <div v-if="planMode && editable" class="work-step-actions plan-step-actions">
        <button type="button" :disabled="busy" title="重命名" @click="startEdit(step)">改名</button>
        <button
          v-if="step.status !== 'skipped'"
          type="button"
          :disabled="busy"
          title="跳过这一步"
          @click="skipStep(step)"
        >
          跳过
        </button>
        <button
          v-else
          type="button"
          :disabled="busy"
          title="恢复为待开始"
          @click="reopenStep(step)"
        >
          恢复
        </button>
        <button type="button" :disabled="busy" title="删除这一步" @click="removePlanStep(step)">
          删除
        </button>
      </div>

      <div v-else-if="!planMode" class="work-step-actions task-step-actions">
        <template v-if="editable">
          <!-- 已完成的步骤只剩「重开」与「删除」：不再提供阻塞/完成按钮，避免误伤 -->
          <button
            v-if="step.status === 'completed'"
            type="button"
            :disabled="busy"
            @click="setStatus(step, 'pending')"
          >
            重开
          </button>
          <button
            v-else-if="step.status === 'blocked'"
            type="button"
            :disabled="busy"
            @click="setStatus(step, 'pending')"
          >
            解除
          </button>
          <template v-else>
            <button
              v-if="step.status !== 'in_progress'"
              type="button"
              :disabled="busy"
              @click="setStatus(step, 'in_progress')"
            >
              开始
            </button>
            <button type="button" :disabled="busy" @click="setStatus(step, 'completed')">
              完成
            </button>
            <button type="button" :disabled="busy" @click="startBlocking(step)">阻塞</button>
          </template>
          <button type="button" :disabled="busy" @click="removeTaskStep(step)">删除</button>
        </template>
      </div>

      <form
        v-if="!planMode && blockingStepId === step.id"
        class="work-block-form"
        @submit.prevent="confirmBlock(step)"
      >
        <input v-model="blockReason" placeholder="阻塞原因（必填）" maxlength="1000" autofocus />
        <button type="submit" :disabled="busy || !blockReason.trim()">确认</button>
        <button type="button" @click="blockingStepId = null">取消</button>
      </form>
    </li>
  </ol>
</template>

<style scoped>
/* 步骤列表：左边一条状态色条 + 序号 + 标题/副标题 + 悬浮出现的操作按钮 */
.work-steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.work-steps li {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
  padding: 5px 7px;
  border-left: 2px solid var(--line-strong);
  border-radius: 6px;
  background: var(--panel-soft);
}

.work-step--current {
  border-left-color: var(--accent);
}

.work-step--completed {
  border-left-color: rgba(231, 255, 111, 0.45);
}

.work-step--blocked {
  border-left-color: #d8b25f;
}

.work-step-number {
  color: var(--faint);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

.work-step-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.work-step-copy strong {
  overflow: hidden;
  color: var(--text);
  font-size: 11px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
}

.work-step--completed .work-step-copy strong {
  color: var(--faint);
  text-decoration: line-through;
}

.work-step--current .work-step-copy strong {
  color: var(--accent);
}

.work-step--blocked .work-step-note {
  color: #d8b25f;
}

.work-step-copy small {
  color: var(--faint);
  line-height: 1.5;
}

.work-step-actions {
  display: flex;
  gap: 4px;
}

/* 计划步骤的编辑按钮平时隐形，hover / 键盘聚焦才出现，避免面板里全是按钮 */
.work-step-actions.plan-step-actions {
  opacity: 0;
  transition: opacity 0.12s ease;
}

.work-steps li:hover .work-step-actions.plan-step-actions,
.work-steps li:focus-within .work-step-actions.plan-step-actions {
  opacity: 1;
}

.work-step-actions button {
  padding: 3px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--muted);
  background: var(--input-bg);
  font-size: 9px;
  cursor: pointer;
}

.work-step-actions button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}

.work-step-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}

.work-step-input {
  width: 100%;
  padding: 2px 5px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: var(--input-bg);
  color: var(--text);
  font-family: inherit;
  font-size: 11px;
}

.work-block-form {
  grid-column: 2 / -1;
  display: flex;
  gap: 5px;
}

.work-block-form input {
  flex: 1 1 auto;
  padding: 5px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text);
  background: var(--input-bg);
  font-size: 10px;
}

.work-block-form button {
  padding: 3px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--muted);
  background: var(--input-bg);
  font-size: 9px;
  cursor: pointer;
}

.work-block-form button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
