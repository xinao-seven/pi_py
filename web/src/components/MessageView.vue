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
const images = computed(() =>
  blocks.value.filter(
    (block): block is ContentBlock & { data: string; mimeType: string } =>
      block.type === "image" && !!block.data && !!block.mimeType,
  ),
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
      <div v-if="images.length" class="message-images">
        <img
          v-for="(image, index) in images"
          :key="`${image.mimeType}:${index}`"
          :src="`data:${image.mimeType};base64,${image.data}`"
          :alt="`消息图片 ${index + 1}`"
        />
      </div>
      <template v-if="!isUser">
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
