<!-- 单条消息渲染：用户文本/图片；助手思考块、Markdown、工具调用与错误信息。 -->
<script setup lang="ts">
import { computed } from 'vue';

import { messageText } from '@/lib/agent-events';
import MarkdownContent from '@/components/MarkdownContent.vue';
import ThinkingBlock from '@/components/ThinkingBlock.vue';
import ToolCallBlock from '@/components/ToolCallBlock.vue';
import type { AgentMessage, ContentBlock } from '@/types';

const props = defineProps<{
  message: AgentMessage;
  streaming?: boolean;
  toolResults?: Record<string, AgentMessage>;
}>();

const text = computed(() => messageText(props.message));
const isUser = computed(() => props.message.role === 'user');
const blocks = computed(() =>
  // 消息内容块列表
  Array.isArray(props.message.content) ? props.message.content : [],
);
const thinking = computed(() =>
  // 拼接全部思考块
  blocks.value
    .filter((block) => block.type === 'thinking')
    .map((block) => block.thinking ?? block.text ?? '')
    .join('\n'),
);
const toolCalls = computed(() =>
  // 提取工具调用块
  blocks.value.filter((block): block is ContentBlock => block.type === 'toolCall'),
);
const images = computed(() =>
  // 提取图片块（仅含 data 与 mimeType 的）
  blocks.value.filter(
    (block): block is ContentBlock & { data: string; mimeType: string } =>
      block.type === 'image' && !!block.data && !!block.mimeType,
  ),
);
</script>

<template>
  <article
    v-if="message.role === 'user' || message.role === 'assistant'"
    class="message-row"
    :class="{ 'message-row--user': isUser }"
    :aria-label="isUser ? '用户消息' : '助手消息'"
  >
    <div class="message-body" :class="{ 'message-body--user': isUser }">
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

<style scoped>
/* 单条消息：行布局、用户右对齐、图片、错误与流式光标 */
.message-row {
  margin: 0 0 34px;
  animation: message-enter 180ms ease-out;
}

.message-row--user {
  display: flex;
  justify-content: flex-end;
  width: 100%;
  margin-left: 0;
  padding-left: min(18%, 120px);
  border-left: 0;
  text-align: right;
}

.message-body {
  min-width: 0;
  max-width: 760px;
}

.message-body--user {
  max-width: 680px;
}

.message-body--user .message-text {
  color: var(--text);
}

.message-text {
  color: var(--muted);
  font-size: 14px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.message-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.message-images img {
  max-width: min(280px, 55vw);
  max-height: 260px;
  border: 1px solid var(--line);
  border-radius: 6px;
  object-fit: contain;
  background: rgba(0, 0, 0, 0.2);
}

.message-error {
  margin-top: 12px;
  padding: 7px 10px;
  border: 1px solid rgba(255, 129, 120, 0.2);
  border-radius: 4px;
  color: #ffc0ba;
  background: rgba(255, 99, 88, 0.09);
  font-size: 12px;
}

.stream-cursor {
  display: inline-block;
  width: 7px;
  height: 15px;
  margin-left: 3px;
  border-radius: 1px;
  vertical-align: -2px;
  background: var(--accent);
  animation: blink 0.9s steps(2, start) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

@keyframes message-enter {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 760px) {
  .message-row--user {
    padding-left: 10%;
  }
}
</style>
