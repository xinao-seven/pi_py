<script setup lang="ts">
import { computed } from "vue";

import { messageText } from "@/lib/agent-events";
import type { AgentMessage, ContentBlock } from "@/types";

const props = defineProps<{
  call: ContentBlock;
  result?: AgentMessage;
  streaming?: boolean;
}>();

const argumentsText = computed(() => JSON.stringify(props.call.arguments ?? {}, null, 2));
const resultText = computed(() => (props.result ? messageText(props.result) : ""));
const status = computed(() => {
  if (props.result?.isError) return "失败";
  if (props.result) return "完成";
  return props.streaming ? "运行中" : "等待结果";
});
</script>

<template>
  <details class="tool-call" :class="{ 'tool-call--error': result?.isError }">
    <summary>
      <span class="tool-glyph" aria-hidden="true">›_</span>
      <span class="tool-name">{{ call.name || "tool" }}</span>
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
