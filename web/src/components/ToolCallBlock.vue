<!-- 工具调用块：展示参数与对应结果，按结果状态显示 运行中/完成/失败。 -->
<script setup lang="ts">
import { computed } from 'vue';

import { messageText } from '@/lib/agent-events';
import type { AgentMessage, ContentBlock } from '@/types';

const props = defineProps<{
  call: ContentBlock;
  result?: AgentMessage;
  streaming?: boolean;
}>();

const argumentsText = computed(() => JSON.stringify(props.call.arguments ?? {}, null, 2));
const resultText = computed(() => (props.result ? messageText(props.result) : ''));
const status = computed(() => {
  // 状态文案：失败优先，其次完成/运行中/等待
  if (props.result?.isError) return '失败';
  if (props.result) return '完成';
  return props.streaming ? '运行中' : '等待结果';
});
</script>

<template>
  <details
    class="tool-call"
    :class="{
      'tool-call--error': result?.isError,
      'tool-call--success': !!result && !result.isError,
    }"
  >
    <summary>
      <span class="tool-glyph" aria-hidden="true">›_</span>
      <span class="tool-name">{{ call.name || 'tool' }}</span>
      <span class="tool-status">{{ status }}</span>
    </summary>
    <div class="tool-section">
      <div class="tool-label">参数</div>
      <pre>{{ argumentsText }}</pre>
    </div>
    <div v-if="result" class="tool-section">
      <div class="tool-label">结果</div>
      <pre>{{ resultText }}</pre>
    </div>
  </details>
</template>

<style scoped>
/* 工具调用块：按结果状态着色的可折叠卡片 */
.tool-call {
  margin: 0 0 13px;
  overflow: hidden;
  border: 0;
  border-left: 3px solid #8a63d2;
  border-radius: 0;
  background: transparent;
}

.tool-call--success {
  border-left-color: #2d9d68;
}

.tool-call--error {
  border-left-color: #d05252;
}

.tool-call summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0 5px 12px;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
  list-style: none;
}

.tool-call summary::-webkit-details-marker {
  display: none;
}

.tool-glyph {
  color: var(--accent);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-weight: 700;
}

.tool-name {
  color: var(--text);
  font-family: 'Cascadia Code', Consolas, monospace;
}

.tool-status {
  margin-left: auto;
  color: var(--faint);
}

.tool-call--error .tool-status {
  color: var(--danger);
}

.tool-call--success .tool-status {
  color: #168453;
}

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
