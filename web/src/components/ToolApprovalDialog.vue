<!-- 危险命令确认弹窗：模型请求执行危险命令时弹出，由用户允许/拒绝。 -->
<script setup lang="ts">
import { computed } from "vue";

import type { PendingToolCall } from "@/types";

const props = defineProps<{
  pending: PendingToolCall;
  busy?: boolean;
}>();

const emit = defineEmits<{
  approve: [approved: boolean];
}>();

const commandText = computed(() =>
  // 展示触发确认的命令（优先 bash 的 command 参数）
  typeof props.pending.args.command === "string"
    ? props.pending.args.command
    : JSON.stringify(props.pending.args, null, 2),
);

function choose(approved: boolean): void {
  if (props.busy) return;
  emit("approve", approved);
}
</script>

<template>
  <div class="modal-backdrop" @keydown.esc="choose(false)">
    <section
      class="config-dialog approval-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="approval-title"
      aria-describedby="approval-reason"
    >
      <header class="config-header">
        <div>
          <div class="welcome-kicker">DANGEROUS COMMAND</div>
          <h2 id="approval-title">确认执行危险命令</h2>
        </div>
      </header>

      <div class="config-body">
        <p id="approval-reason" class="approval-reason">
          {{ pending.reason }}
        </p>
        <div class="approval-meta">
          <span class="approval-chip">工具：{{ pending.toolName }}</span>
          <span v-if="pending.rule" class="approval-chip">规则：{{ pending.rule }}</span>
        </div>
        <div class="tool-section">
          <div class="tool-label">命令内容</div>
          <pre>{{ commandText }}</pre>
        </div>
        <p class="approval-hint">不确认时命令不会执行；60 秒内未操作将自动拒绝。</p>
      </div>

      <footer class="config-footer approval-footer">
        <button type="button" class="danger-action" :disabled="busy" @click="choose(false)">
          拒绝执行
        </button>
        <button type="button" class="primary-action" :disabled="busy" @click="choose(true)">
          允许执行
        </button>
      </footer>
    </section>
  </div>
</template>
