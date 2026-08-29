<!-- 已打开文件的标签栏：切换与关闭。 -->
<script setup lang="ts">
import type { FileTab } from '@/types';

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
      <button
        type="button"
        class="file-tab-select"
        :title="tab.path"
        @click="emit('select', tab.path)"
      >
        {{ tab.name }}
      </button>
      <button
        type="button"
        class="file-tab-close"
        :aria-label="`关闭 ${tab.name}`"
        @click="emit('close', tab.path)"
      >
        ×
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 已打开文件的标签栏 */
.file-tab-bar {
  display: flex;
  flex: 0 0 auto;
  min-height: 37px;
  overflow-x: auto;
  border-bottom: 1px solid var(--line);
  background: #111318;
  scrollbar-width: thin;
}

:root[data-theme='light'] .file-tab-bar {
  background: #ffffff;
}

.file-tab {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  border-right: 1px solid var(--line);
  border-bottom: 2px solid transparent;
}

.file-tab--active {
  border-bottom-color: var(--accent);
  background: #171a20;
}

:root[data-theme='light'] .file-tab--active {
  background: #ffffff;
}

.file-tab-select,
.file-tab-close {
  border: 0;
  background: transparent;
  cursor: pointer;
}

.file-tab-select {
  max-width: 150px;
  padding: 9px 5px 8px 10px;
  overflow: hidden;
  color: var(--muted);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-tab-close {
  padding: 8px 8px 8px 3px;
  color: var(--faint);
}
</style>
