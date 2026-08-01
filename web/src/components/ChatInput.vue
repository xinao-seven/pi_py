<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";

import type { AttachedImage } from "@/types";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const props = defineProps<{
  running: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  send: [message: string, images?: AttachedImage[]];
  steer: [message: string, images?: AttachedImage[]];
  followUp: [message: string, images?: AttachedImage[]];
  abort: [];
}>();

const message = ref("");
const textarea = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const images = ref<AttachedImage[]>([]);
const imageError = ref<string | null>(null);
const dragging = ref(false);
const canSend = computed(
  () => (message.value.trim().length > 0 || images.value.length > 0) && !props.disabled,
);

function submit(mode: "send" | "steer" | "followUp" = props.running ? "followUp" : "send"): void {
  if (!canSend.value) return;
  const value = message.value.trim();
  const attached = images.value.length ? [...images.value] : undefined;
  message.value = "";
  clearImages();
  resize();
  if (mode === "steer") {
    if (attached) emit("steer", value, attached);
    else emit("steer", value);
  } else if (mode === "followUp") {
    if (attached) emit("followUp", value, attached);
    else emit("followUp", value);
  } else if (attached) emit("send", value, attached);
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

async function addFiles(files: File[]): Promise<void> {
  imageError.value = null;
  const available = MAX_IMAGES - images.value.length;
  const selected = files.filter((file) => file.type.startsWith("image/")).slice(0, available);
  if (selected.length < files.filter((file) => file.type.startsWith("image/")).length) {
    imageError.value = `最多添加 ${MAX_IMAGES} 张图片`;
  }
  for (const file of selected) {
    if (file.size > MAX_IMAGE_BYTES) {
      imageError.value = `${file.name} 超过 5 MB`;
      continue;
    }
    const dataUrl = await readDataUrl(file);
    images.value.push({
      data: dataUrl.slice(dataUrl.indexOf(",") + 1),
      mimeType: file.type,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
    });
  }
}

function removeImage(index: number): void {
  const [removed] = images.value.splice(index, 1);
  if (removed) URL.revokeObjectURL(removed.previewUrl);
}

function clearImages(): void {
  for (const image of images.value) URL.revokeObjectURL(image.previewUrl);
  images.value = [];
}

function onFiles(event: Event): void {
  const input = event.target as HTMLInputElement;
  void addFiles(Array.from(input.files ?? []));
  input.value = "";
}

function onPaste(event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (!files.length) return;
  event.preventDefault();
  void addFiles(files);
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) void addFiles(files);
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

onBeforeUnmount(clearImages);
</script>

<template>
  <form
    class="composer"
    :class="{ 'composer--dragging': dragging }"
    @submit.prevent="submit()"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave.self="dragging = false"
    @drop.prevent="onDrop"
  >
    <div v-if="dragging" class="drop-overlay" aria-hidden="true">松开以添加图片</div>
    <div v-if="images.length" class="image-attachments" aria-label="待发送图片">
      <div v-for="(image, index) in images" :key="image.previewUrl" class="image-attachment">
        <img :src="image.previewUrl" :alt="image.name" />
        <button type="button" :aria-label="`移除 ${image.name}`" @click="removeImage(index)">×</button>
      </div>
    </div>
    <div v-if="imageError" class="image-error" role="alert">{{ imageError }}</div>
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
      @paste="onPaste"
    />
    <div class="composer-actions">
      <div class="composer-tools">
        <button type="button" class="attach-button" aria-label="添加图片" @click="fileInput?.click()">＋ 图片</button>
        <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onFiles" />
        <span class="composer-hint">Enter 发送 · Shift+Enter 换行</span>
      </div>
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
