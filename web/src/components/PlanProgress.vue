<script setup lang="ts">
// 内联 Plan 进度面板：激活时固定在输入框上方，实时显示规划/确认/执行进度。
import { computed, ref } from 'vue';

import type { PlanSnapshot } from '@/types';

const props = defineProps<{
  plan: PlanSnapshot | null;
  sessionId: string | null;
  busy: boolean;
}>();

const emit = defineEmits<{
  disable: [];
  execute: [];
  refine: [message: string];
}>();

const refineText = ref('');
const collapsed = ref(false);

const modeLabel = computed(() => {
  if (props.plan?.mode === 'executing') return '执行中';
  if (props.plan?.awaitingConfirmation) return '等待确认';
  return '规划中';
});
const doneCount = computed(() => props.plan?.todos.filter((todo) => todo.completed).length ?? 0);
const currentStep = computed(() => props.plan?.todos.find((todo) => !todo.completed)?.step ?? null);

function stepStatus(step: number): string {
  const todo = props.plan?.todos.find((item) => item.step === step);
  if (!todo) return '';
  if (todo.completed) return '已由 Agent 标记完成';
  if (props.plan?.mode === 'executing' && step === currentStep.value) return '当前步骤';
  return '待执行';
}

function submitRefine(): void {
  const message = refineText.value.trim();
  if (!message) return;
  emit('refine', message);
  refineText.value = '';
}
</script>

<template>
  <section
    v-if="plan && plan.mode !== 'normal'"
    class="plan-progress"
    :class="{ 'plan-progress--collapsed': collapsed }"
  >
    <button
      class="plan-progress-head"
      type="button"
      :aria-expanded="!collapsed"
      @click="collapsed = !collapsed"
    >
      <span class="plan-progress-badge">{{ modeLabel }}</span>
      <span v-if="plan.todos.length" class="plan-progress-count"
        >{{ doneCount }}/{{ plan.todos.length }} 完成</span
      >
      <span class="plan-progress-arrow" aria-hidden="true">{{ collapsed ? '▸' : '▾' }}</span>
    </button>

    <div v-if="!collapsed" class="plan-progress-body">
      <ol v-if="plan.todos.length" class="plan-steps">
        <li
          v-for="todo in plan.todos"
          :key="todo.step"
          :class="{
            'plan-step--completed': todo.completed,
            'plan-step--current': plan.mode === 'executing' && todo.step === currentStep,
          }"
        >
          <span class="plan-step-number">{{ String(todo.step).padStart(2, '0') }}</span>
          <div class="plan-step-copy">
            <strong>{{ todo.text }}</strong>
            <small>{{ stepStatus(todo.step) }}</small>
          </div>
        </li>
      </ol>

      <p v-if="plan.mode === 'executing'" class="plan-progress-note">
        按顺序执行中；每完成并验证一步，Agent 会写出 [DONE:n] 自动更新进度。
      </p>

      <p v-if="plan.mode === 'planning'" class="plan-empty">
        {{
          plan.awaitingConfirmation
            ? 'Agent 已生成计划，等待你确认后开始执行。'
            : 'Agent 正在讨论并生成结构化 Plan…'
        }}
      </p>

      <div v-if="plan.awaitingConfirmation && plan.todos.length" class="plan-confirm">
        <textarea
          v-model="refineText"
          rows="2"
          placeholder="需要调整时说明你的要求"
          :disabled="busy"
        />
        <div class="plan-confirm-actions">
          <button class="primary-action" :disabled="busy" @click="emit('execute')">
            确认并执行
          </button>
          <button :disabled="busy || !refineText.trim()" @click="submitRefine">继续细化</button>
          <button :disabled="busy" @click="emit('disable')">放弃此计划</button>
        </div>
      </div>

      <div
        v-if="plan.mode === 'executing' || (plan.mode === 'planning' && !plan.awaitingConfirmation)"
        class="plan-progress-actions"
      >
        <button type="button" :disabled="busy" @click="emit('disable')">退出 Plan 模式</button>
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
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 34px;
  padding: 0 12px;
  border: 0;
  color: var(--text);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.plan-progress-badge {
  color: var(--accent);
  font-size: 9px;
  font-weight: 750;
  letter-spacing: 0.12em;
}

.plan-progress-count {
  margin-left: auto;
  color: var(--faint);
  font-size: 10px;
}

.plan-progress-arrow {
  color: var(--faint);
  font-size: 10px;
}

.plan-progress-body {
  padding: 0 12px 12px;
}

.plan-progress-note {
  margin: 8px 2px 0;
  color: var(--faint);
  font-size: 10px;
  line-height: 1.5;
}

.plan-progress-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}

.plan-progress-actions > button {
  min-height: 27px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--muted);
  background: transparent;
  font-size: 10px;
  cursor: pointer;
}

.plan-progress-actions > button:hover {
  border-color: rgba(231, 255, 111, 0.46);
  color: var(--accent);
}

/* Plan 空态提示与确认区 */
.plan-empty {
  margin: 0 2px;
  padding: 8px 0 2px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.55;
}

.plan-confirm {
  display: grid;
  gap: 9px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.plan-confirm textarea {
  width: 100%;
  min-height: 54px;
  resize: vertical;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  color: var(--text);
  background: rgba(255, 255, 255, 0.025);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
}

.plan-confirm-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}

.plan-confirm-actions button {
  min-height: 29px;
  padding: 0 11px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--muted);
  background: transparent;
  font-size: 10px;
  cursor: pointer;
}

.plan-confirm-actions button:hover {
  border-color: rgba(231, 255, 111, 0.46);
  color: var(--accent);
}

.plan-confirm-actions .primary-action {
  border-color: rgba(231, 255, 111, 0.36);
  color: var(--accent-ink);
  background: var(--accent);
}

.plan-confirm-actions .primary-action:hover {
  color: var(--accent-ink);
  background: color-mix(in srgb, var(--accent) 88%, white);
}

.plan-confirm-actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.plan-steps {
  display: grid;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.plan-steps li {
  display: grid;
  grid-template-columns: 33px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 60px;
  padding: 10px 11px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.018);
}

.plan-step--completed {
  opacity: 0.58;
}

/* 内联面板里的步骤行：更紧凑，列宽收敛为 编号 + 内容 两列 */
.plan-progress .plan-steps li {
  grid-template-columns: 28px minmax(0, 1fr);
  min-height: 42px;
  gap: 9px;
  padding: 7px 9px;
  border-radius: 9px;
}

.plan-progress .plan-step--current {
  border-color: rgba(231, 255, 111, 0.38);
  background: rgba(231, 255, 111, 0.05);
}

.plan-step-number {
  color: var(--faint);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 10px;
}

.plan-step-copy {
  min-width: 0;
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
