<!-- 文件面板外壳：文件树 + 已打开标签 + 预览区。 -->
<script setup lang="ts">
import FileExplorer from '@/components/FileExplorer.vue';
import FileViewer from '@/components/FileViewer.vue';
import TabBar from '@/components/TabBar.vue';
import type { FileTab } from '@/types';

defineProps<{
  root: string;
  tabs: FileTab[];
  activePath: string | null;
}>();

const emit = defineEmits<{
  open: [path: string];
  select: [path: string];
  close: [path: string];
  closePanel: [];
}>();
</script>

<template>
  <div class="file-workspace-panel">
    <header class="file-panel-header">
      <div>
        <strong>文件</strong>
        <span :title="root">{{ root }}</span>
      </div>
      <button type="button" aria-label="关闭文件面板" @click="emit('closePanel')">×</button>
    </header>
    <FileExplorer :root="root" @open="emit('open', $event)" />
    <div class="file-preview-column">
      <TabBar
        :tabs="tabs"
        :active-path="activePath"
        @select="emit('select', $event)"
        @close="emit('close', $event)"
      />
      <FileViewer :root="root" :path="activePath" />
    </div>
  </div>
</template>

<style scoped>
/* 文件工作区面板：头部 + 资源管理器/预览两列布局 */
.file-workspace-panel {
  display: grid;
  grid-template-columns: minmax(150px, 190px) minmax(0, 1fr);
  grid-template-rows: 48px minmax(0, 1fr);
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.file-panel-header {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px 0 15px;
  border-bottom: 1px solid var(--line);
}

.file-panel-header > div {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 10px;
}

.file-panel-header strong {
  font-size: 12px;
}

.file-panel-header span {
  overflow: hidden;
  color: var(--faint);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-panel-header button {
  border: 0;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
}

.file-preview-column {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}

@media (max-width: 760px) {
  .file-workspace-panel {
    grid-template-columns: minmax(125px, 38vw) minmax(0, 1fr);
  }
}
</style>
