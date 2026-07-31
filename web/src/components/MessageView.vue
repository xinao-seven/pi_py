<script setup lang="ts">
import { computed } from "vue";

import { messageText } from "@/lib/agent-events";
import MarkdownContent from "@/components/MarkdownContent.vue";
import ThinkingBlock from "@/components/ThinkingBlock.vue";
import ToolCallBlock from "@/components/ToolCallBlock.vue";
import type { AgentMessage, ContentBlock } from "@/types";

const props = defineProps<{
  message: AgentMessage;
  streaming?: boolean;
  toolResults?: Record<string, AgentMessage>;
}>();

const text = computed(() => messageText(props.message));
const isUser = computed(() => props.message.role === "user");
const blocks = computed(() =>
  Array.isArray(props.message.content) ? props.message.content : [],
);
const thinking = computed(() =>
  blocks.value
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking ?? block.text ?? "")
    .join("\n"),
);
const toolCalls = computed(() =>
  blocks.value.filter((block): block is ContentBlock => block.type === "toolCall"),
);
</script>

<template>
  <article
    v-if="message.role === 'user' || message.role === 'assistant'"
    class="message-row"
    :class="{ 'message-row--user': isUser }"
  >
    <div v-if="!isUser" class="assistant-avatar" aria-hidden="true">π</div>
    <div class="message-body" :class="{ 'message-body--user': isUser }">
      <div v-if="!isUser" class="message-author">pi</div>
      <div v-if="isUser" class="message-text">{{ text }}</div>
      <template v-else>
        <ThinkingBlock v-if="thinking" :content="thinking" :streaming="streaming" />
        <MarkdownContent v-if="text" :content="text" />
        <ToolCallBlock
          v-for="call in toolCalls"
          :key="call.id"
          :call="call"
          :result="call.id ? toolResults?.[call.id] : undefined"
          :streaming="streaming"
        />
      </template>
      <span v-if="streaming" class="stream-cursor" aria-label="正在生成" />
      <div v-if="message.errorMessage" class="message-error" role="alert">
        {{ message.errorMessage }}
      </div>
    </div>
  </article>
</template>
