<!-- 已打开文件的标签栏：切换与关闭。 -->
<script setup lang="ts">
import type { FileTab } from "@/types";

defineProps<{
  tabs: FileTab[];
  activePath: string | null;
}>();

const emit = defineEmits<{
  select: [path: string];
  close: [path: string];
}>();
</script>

<template>
  <div class="file-tab-bar" role="tablist" aria-label="已打开文件">
    <div
      v-for="tab in tabs"
      :key="tab.path"
      class="file-tab"
      :class="{ 'file-tab--active': tab.path === activePath }"
      role="tab"
      :aria-selected="tab.path === activePath"
    >
      <button type="button" class="file-tab-select" :title="tab.path" @click="emit('select', tab.path)">
        {{ tab.name }}
      </button>
      <button type="button" class="file-tab-close" :aria-label="`关闭 ${tab.name}`" @click="emit('close', tab.path)">
        ×
      </button>
    </div>
  </div>
</template>
