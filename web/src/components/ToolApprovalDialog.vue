<!-- 命令确认弹窗：模型请求执行有副作用命令时弹出，由用户允许/拒绝。 -->
<script setup lang="ts">
import { computed } from 'vue';

import type { PendingToolCall } from '@/types';

const props = defineProps<{
  pending: PendingToolCall;
  busy?: boolean;
}>();

const emit = defineEmits<{
  approve: [approved: boolean];
}>();

const commandText = computed(() =>
  // 展示触发确认的命令（优先 bash 的 command 参数）
  typeof props.pending.args.command === 'string'
    ? props.pending.args.command
    : JSON.stringify(props.pending.args, null, 2),
);

function choose(approved: boolean): void {
  if (props.busy) return;
  emit('approve', approved);
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
          <div class="welcome-kicker">{{ pending.risk.toUpperCase() }} COMMAND</div>
          <h2 id="approval-title">确认执行需要授权的命令</h2>
        </div>
      </header>

      <div class="config-body">
        <p id="approval-reason" class="approval-reason">
          {{ pending.reason }}
        </p>
        <div class="approval-meta">
          <span class="approval-chip">工具：{{ pending.toolName }}</span>
          <span v-if="pending.rule" class="approval-chip">规则：{{ pending.rule }}</span>
          <span class="approval-chip">风险：{{ pending.risk }}</span>
          <span class="approval-chip">范围：{{ pending.category }}</span>
        </div>
        <div class="tool-section">
          <div class="tool-label">命令内容</div>
          <pre>{{ commandText }}</pre>
        </div>
        <p class="approval-hint">不确认时命令不会执行；30 秒内未操作将自动拒绝。</p>
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

<style scoped>
/* 审批弹窗私有部分；弹窗骨架（config-*）在 globals.css 中共享 */
.approval-dialog {
  width: min(560px, 100%);
  min-height: 0;
}

.approval-reason {
  margin: 0 0 10px;
  color: var(--danger);
  font-weight: 600;
  font-size: 13px;
}

.approval-meta {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.approval-chip {
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--faint);
  font-size: 10px;
}

.approval-hint {
  margin: 10px 0 0;
  color: var(--faint);
  font-size: 10px;
}

.approval-footer {
  gap: 8px;
}

.approval-footer .danger-action {
  border-color: rgba(255, 129, 120, 0.35);
  color: var(--danger);
}

/* 命令内容展示区（与 ToolCallBlock 的 tool-section 同款） */
.tool-section {
  padding: 4px 0 9px 12px;
}

.tool-label {
  margin: 2px 0 6px;
  color: var(--faint);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.tool-section pre {
  max-height: 260px;
  overflow-x: auto;
  margin: 0;
  padding: 10px 11px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: #aeb4be;
  background: #0d0f13;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
  scrollbar-width: thin;
}

:root[data-theme='light'] .tool-section pre {
  color: #213025;
  background: #f3f5ee;
}
</style>
