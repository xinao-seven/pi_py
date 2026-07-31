<script setup lang="ts">
import { computed, nextTick, ref } from "vue";

const props = defineProps<{
  running: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  send: [message: string];
  steer: [message: string];
  followUp: [message: string];
  abort: [];
}>();

const message = ref("");
const textarea = ref<HTMLTextAreaElement | null>(null);
const canSend = computed(() => message.value.trim().length > 0 && !props.disabled);

function submit(mode: "send" | "steer" | "followUp" = props.running ? "followUp" : "send"): void {
  if (!canSend.value) return;
  const value = message.value.trim();
  message.value = "";
  resize();
  if (mode === "steer") emit("steer", value);
  else if (mode === "followUp") emit("followUp", value);
  else emit("send", value);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}

function resize(): void {
  void nextTick(() => {
    if (!textarea.value) return;
    textarea.value.style.height = "0px";
    textarea.value.style.height = `${Math.min(textarea.value.scrollHeight, 180)}px`;
  });
}
</script>

<template>
  <form class="composer" @submit.prevent="submit()">
    <textarea
      ref="textarea"
      v-model="message"
      class="composer-input"
      rows="1"
      :disabled="disabled"
      :placeholder="running ? '输入修正指令或排队消息…' : '给 pi 发消息'"
      aria-label="消息"
      @input="resize"
      @keydown="onKeydown"
    />
    <div class="composer-actions">
      <div class="composer-hint">Enter 发送 · Shift+Enter 换行</div>
      <template v-if="running">
        <button class="queue-button" type="button" :disabled="!canSend" @click="submit('steer')">
          插入指令
        </button>
        <button class="queue-button" type="button" :disabled="!canSend" @click="submit('followUp')">
          排队跟进
        </button>
        <button
          class="abort-button"
          type="button"
          aria-label="停止生成"
          @click="emit('abort')"
        >
          <span aria-hidden="true">■</span>
          停止
        </button>
      </template>
      <button v-else class="send-button" type="submit" :disabled="!canSend">
        发送
        <span aria-hidden="true">↗</span>
      </button>
    </div>
  </form>
</template>
