<!-- 文件树（根目录层）：懒加载根目录列表，点击目录递归展开。 -->
<script setup lang="ts">
import { ref, watch } from 'vue';

import FileTreeNode from '@/components/FileTreeNode.vue';
import { listFiles } from '@/lib/api';
import type { FileTreeItem } from '@/types';

const props = defineProps<{ root: string }>();

const emit = defineEmits<{
  open: [path: string];
}>();

const entries = ref<FileTreeItem[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

async function loadRoot(): Promise<void> {
  // 加载工作区根目录
  if (!props.root) return;
  loading.value = true;
  error.value = null;
  try {
    const result = await listFiles(props.root);
    entries.value = result.entries.map((entry) => ({ ...entry, path: entry.name }));
  } catch (cause) {
    entries.value = [];
    error.value = cause instanceof Error ? cause.message : '工作区读取失败';
  } finally {
    loading.value = false;
  }
}

watch(() => props.root, loadRoot, { immediate: true });
</script>

<template>
  <section class="file-explorer" aria-label="工作区文件">
    <div class="file-explorer-heading">
      <span>工作区</span>
      <button type="button" :disabled="loading" aria-label="刷新文件树" @click="loadRoot">↻</button>
    </div>
    <div v-if="loading" class="file-panel-state">正在读取文件…</div>
    <div v-else-if="error" class="file-panel-state file-panel-state--error" role="alert">
      {{ error }}
    </div>
    <div v-else-if="entries.length === 0" class="file-panel-state">工作区为空</div>
    <ul v-else class="file-tree-root">
      <FileTreeNode
        v-for="entry in entries"
        :key="entry.path"
        :root="root"
        :item="entry"
        :depth="0"
        @open="emit('open', $event)"
      />
    </ul>
  </section>
</template>

<style scoped>
/* 文件树容器与标题栏 */
.file-explorer {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  border-right: 1px solid var(--line);
}

.file-explorer-heading {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 37px;
  padding: 0 9px 0 12px;
  border-bottom: 1px solid var(--line);
  color: var(--faint);
  background: #111318;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.file-explorer-heading button {
  border: 0;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
}

:root[data-theme='light'] .file-explorer-heading {
  background: #ffffff;
}

.file-panel-state {
  padding: 12px;
  color: var(--faint);
  font-size: 10px;
}

.file-panel-state--error {
  color: var(--danger);
}
</style>
