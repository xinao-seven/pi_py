<!-- 输入区：文本 + 最多 4 张图片（选择/粘贴/拖放），运行中可插入指令/排队跟进/停止。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';

import type { AttachedImage } from '@/types';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const props = defineProps<{
  running: boolean;
  disabled?: boolean;
  planActive?: boolean;
}>();

const emit = defineEmits<{
  send: [message: string, images?: AttachedImage[]];
  steer: [message: string, images?: AttachedImage[]];
  followUp: [message: string, images?: AttachedImage[]];
  abort: [];
}>();

const message = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const images = ref<AttachedImage[]>([]);
const imageError = ref<string | null>(null);
const dragging = ref(false);
const canSend = computed(
  // 有文本或图片且未禁用时才允许发送
  () => (message.value.trim().length > 0 || images.value.length > 0) && !props.disabled,
);

function submit(mode: 'send' | 'steer' | 'followUp' = props.running ? 'followUp' : 'send'): void {
  // 提交：运行中默认排队跟进；steer 立即插入；发送后清空输入与图片
  if (!canSend.value) return;
  const value = message.value.trim();
  const attached = images.value.length ? [...images.value] : undefined;
  message.value = '';
  clearImages();
  resize();
  if (mode === 'steer') {
    if (attached) emit('steer', value, attached);
    else emit('steer', value);
  } else if (mode === 'followUp') {
    if (attached) emit('followUp', value, attached);
    else emit('followUp', value);
  } else if (attached) emit('send', value, attached);
  else emit('send', value);
}

function onKeydown(event: KeyboardEvent): void {
  // Enter 发送、Shift+Enter 换行（组合输入法期间不触发）
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}

function resize(): void {
  void nextTick(() => {
    if (!textarea.value) return;
    textarea.value.style.height = '0px';
    textarea.value.style.height = `${Math.min(textarea.value.scrollHeight, 180)}px`;
  });
}

async function addFiles(files: File[]): Promise<void> {
  // 添加图片：过滤类型、限制数量与单张 5 MB，转 base64 并生成预览
  imageError.value = null;
  const available = MAX_IMAGES - images.value.length;
  const selected = files.filter((file) => file.type.startsWith('image/')).slice(0, available);
  if (selected.length < files.filter((file) => file.type.startsWith('image/')).length) {
    imageError.value = `最多添加 ${MAX_IMAGES} 张图片`;
  }
  for (const file of selected) {
    if (file.size > MAX_IMAGE_BYTES) {
      imageError.value = `${file.name} 超过 5 MB`;
      continue;
    }
    const dataUrl = await readDataUrl(file);
    images.value.push({
      data: dataUrl.slice(dataUrl.indexOf(',') + 1),
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
  input.value = '';
}

function onPaste(event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.type.startsWith('image/'))
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
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'));
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
        <button type="button" :aria-label="`移除 ${image.name}`" @click="removeImage(index)">
          ×
        </button>
      </div>
    </div>
    <div v-if="imageError" class="image-error" role="alert">{{ imageError }}</div>
    <textarea
      ref="textarea"
      v-model="message"
      class="composer-input"
      rows="1"
      :disabled="disabled"
      :placeholder="
        running
          ? '输入修正指令或排队消息…'
          : planActive
            ? '描述需求，Agent 将先生成 Plan…'
            : '给 pi 发消息'
      "
      aria-label="消息"
      @input="resize"
      @keydown="onKeydown"
      @paste="onPaste"
    />
    <div class="composer-actions">
      <div class="composer-tools">
        <button
          type="button"
          class="attach-button"
          aria-label="添加图片"
          @click="fileInput?.click()"
        >
          ＋ 图片
        </button>
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
        <button class="abort-button" type="button" aria-label="停止生成" @click="emit('abort')">
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

<style scoped>
/* 输入区：composer、图片附件、拖拽遮罩与发送/中止按钮 */
.composer {
  position: relative;
  padding: 8px 10px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--panel);
  box-shadow: none;
  transition: border-color 150ms ease;
}

.composer:focus-within {
  border-color: var(--line-strong);
}

.composer--dragging {
  border-color: var(--accent);
}

.composer-input {
  display: block;
  width: 100%;
  min-height: 26px;
  max-height: 180px;
  padding: 1px 2px;
  resize: none;
  border: 0;
  outline: 0;
  color: var(--text);
  background: transparent;
  font-size: 14px;
  line-height: 1.55;
}

textarea.composer-input:focus-visible {
  outline: 0;
  box-shadow: none;
}

.composer-input::placeholder {
  color: #737985;
}

:root[data-theme='light'] .composer-input::placeholder {
  color: #65715f;
}

.composer-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 6px;
}

.composer-hint {
  margin-right: auto;
  color: var(--faint);
  font-size: 10px;
}

.composer-tools {
  display: flex;
  align-items: center;
  gap: 9px;
}

.attach-button {
  padding: 4px 7px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  background: transparent;
  font-size: 10px;
  cursor: pointer;
}

.image-attachments {
  display: flex;
  gap: 8px;
  padding: 10px 12px 0;
  overflow-x: auto;
}

.image-attachment {
  position: relative;
  flex: 0 0 auto;
}

.image-attachment img {
  width: 62px;
  height: 62px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  object-fit: cover;
}

.image-attachment button {
  position: absolute;
  top: -5px;
  right: -5px;
  display: grid;
  width: 19px;
  height: 19px;
  padding: 0;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: #252932;
  cursor: pointer;
}

.image-error {
  padding: 7px 12px 0;
  color: var(--danger);
  font-size: 10px;
}

.drop-overlay {
  position: absolute;
  inset: 6px;
  z-index: 5;
  display: grid;
  place-items: center;
  border: 1px dashed var(--accent);
  border-radius: 6px;
  color: var(--accent);
  background: rgba(12, 14, 18, 0.92);
  font-size: 12px;
  font-weight: 700;
  pointer-events: none;
}

:root[data-theme='light'] .drop-overlay {
  background: rgba(255, 255, 255, 0.94);
}

.queue-button {
  flex: 0 0 auto;
  min-height: 30px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: #9da3ae;
  background: var(--panel);
  font-size: 10px;
  cursor: pointer;
}

:root[data-theme='light'] .queue-button {
  color: var(--muted);
  background: transparent;
}

.queue-button:disabled {
  opacity: 0.38;
  cursor: default;
}

.send-button,
.abort-button {
  min-height: 30px;
  padding: 0 12px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.send-button {
  border: 0;
  color: var(--accent-ink);
  background: var(--accent);
}

.send-button:disabled {
  opacity: 0.32;
  cursor: default;
}

.abort-button {
  border: 1px solid rgba(255, 129, 120, 0.25);
  color: #ffc0ba;
  background: rgba(255, 129, 120, 0.08);
}

:root[data-theme='light'] .abort-button {
  border-color: #db9892;
  color: #8f2522;
  background: #fff0ee;
}

@media (max-width: 760px) {
  .composer-hint {
    display: none;
  }
}
</style>
