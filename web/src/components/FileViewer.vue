<!-- Rendered source HTML is sanitized with DOMPurify before it reaches v-html. -->
<script setup lang="ts">
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { computed, ref, watch } from "vue";

import { fileMediaUrl, readFile } from "@/lib/api";
import type { FileReadResponse } from "@/types";

const props = defineProps<{
  root: string;
  path: string | null;
}>();

const content = ref<FileReadResponse | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const kind = computed<"image" | "audio" | "text">(() => {
  const extension = props.path?.split(".").at(-1)?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(extension)) {
    return "image";
  }
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac"].includes(extension)) return "audio";
  return "text";
});
const mediaUrl = computed(() =>
  props.path && kind.value !== "text" ? fileMediaUrl(props.root, props.path) : "",
);
const highlighted = computed(() => {
  if (!content.value) return "";
  const language = content.value.language;
  const html = hljs.getLanguage(language)
    ? hljs.highlight(content.value.content, { language }).value
    : hljs.highlightAuto(content.value.content).value;
  return DOMPurify.sanitize(html);
});

async function load(): Promise<void> {
  content.value = null;
  error.value = null;
  if (!props.path || kind.value !== "text") return;
  loading.value = true;
  try {
    content.value = await readFile(props.root, props.path);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "文件读取失败";
  } finally {
    loading.value = false;
  }
}

watch(() => [props.root, props.path, kind.value] as const, load, { immediate: true });
</script>

<template>
  <section class="file-viewer" aria-live="polite">
    <div v-if="!path" class="file-viewer-empty">
      <span aria-hidden="true">⌘</span>
      从文件树中选择一个文件
    </div>
    <div v-else-if="loading" class="file-panel-state">正在读取 {{ path }}…</div>
    <div v-else-if="error" class="file-panel-state file-panel-state--error" role="alert">
      {{ error }}
    </div>
    <div v-else-if="kind === 'image'" class="media-preview">
      <img :src="mediaUrl" :alt="path" />
    </div>
    <div v-else-if="kind === 'audio'" class="media-preview media-preview--audio">
      <audio :src="mediaUrl" controls preload="metadata" />
      <span>{{ path }}</span>
    </div>
    <pre v-else-if="content" class="source-preview">
      <!-- eslint-disable-next-line vue/no-v-html -->
      <code :class="`language-${content.language}`" v-html="highlighted" />
    </pre>
  </section>
</template>
