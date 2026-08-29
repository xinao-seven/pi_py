<!-- 思考过程折叠块：流式时默认展开并显示 LIVE 标记。 -->
<script setup lang="ts">
defineProps<{ content: string; streaming?: boolean }>();
</script>

<template>
  <details class="thinking-block" :open="streaming">
    <summary>
      <span class="thinking-orbit" aria-hidden="true" />
      思考过程
      <span v-if="streaming" class="thinking-live">LIVE</span>
    </summary>
    <div class="thinking-content">{{ content }}</div>
  </details>
</template>

<style scoped>
/* 思考块：可折叠摘要、轨道指示点与流式内容 */
.thinking-block {
  margin: 0 0 13px;
  overflow: hidden;
  border: 0;
  border-left: 3px solid #4b7bec;
  border-radius: 0;
  background: transparent;
}

.thinking-block summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0 5px 12px;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
  list-style: none;
}

.thinking-block summary::-webkit-details-marker {
  display: none;
}

.thinking-orbit {
  width: 9px;
  height: 9px;
  border: 1px solid #a8ba5d;
  border-radius: 50%;
  box-shadow: inset 0 0 0 2px #171a1f;
  background: var(--accent);
}

:root[data-theme='light'] .thinking-orbit {
  border-color: #809642;
  box-shadow: inset 0 0 0 2px #f7f8f1;
}

.thinking-live {
  margin-left: auto;
  color: var(--accent);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 8px;
  letter-spacing: 0.1em;
}

.thinking-content {
  padding: 4px 0 9px 12px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
}
</style>
