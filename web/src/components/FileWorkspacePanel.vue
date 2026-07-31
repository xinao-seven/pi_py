<script setup lang="ts">
import FileExplorer from "@/components/FileExplorer.vue";
import FileViewer from "@/components/FileViewer.vue";
import TabBar from "@/components/TabBar.vue";
import type { FileTab } from "@/types";

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
