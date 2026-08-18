<script setup lang="ts">
// 内联 Plan 进度面板：激活时固定在输入框上方，实时显示规划/确认/执行进度。
import { computed, ref } from "vue";

import type { PlanSnapshot } from "@/types";

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

const refineText = ref("");
const collapsed = ref(false);

const modeLabel = computed(() => {
  if (props.plan?.mode === "executing") return "执行中";
  if (props.plan?.awaitingConfirmation) return "等待确认";
  return "规划中";
});
const doneCount = computed(() => props.plan?.todos.filter((todo) => todo.completed).length ?? 0);
const currentStep = computed(() => props.plan?.todos.find((todo) => !todo.completed)?.step ?? null);

function stepStatus(step: number): string {
  const todo = props.plan?.todos.find((item) => item.step === step);
  if (!todo) return "";
  if (todo.completed) return "已由 Agent 标记完成";
  if (props.plan?.mode === "executing" && step === currentStep.value) return "当前步骤";
  return "待执行";
}

function submitRefine(): void {
  const message = refineText.value.trim();
  if (!message) return;
  emit("refine", message);
  refineText.value = "";
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
      <span v-if="plan.todos.length" class="plan-progress-count">{{ doneCount }}/{{ plan.todos.length }} 完成</span>
      <span class="plan-progress-arrow" aria-hidden="true">{{ collapsed ? "▸" : "▾" }}</span>
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
          <span class="plan-step-number">{{ String(todo.step).padStart(2, "0") }}</span>
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
            ? "Agent 已生成计划，等待你确认后开始执行。"
            : "Agent 正在讨论并生成结构化 Plan…"
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
          <button class="primary-action" :disabled="busy" @click="emit('execute')">确认并执行</button>
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
