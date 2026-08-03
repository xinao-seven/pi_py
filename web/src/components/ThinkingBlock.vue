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
