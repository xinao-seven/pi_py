<!-- 文件树节点：目录点击展开/收起（懒加载子项），文件点击触发打开。 -->
<script setup lang="ts">
import { ref } from 'vue';

import { listFiles } from '@/lib/api';
import type { FileTreeItem } from '@/types';

defineOptions({ name: 'FileTreeNode' });

const props = defineProps<{
  root: string;
  item: FileTreeItem;
  depth: number;
}>();

const emit = defineEmits<{
  open: [path: string];
}>();

const expanded = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const children = ref<FileTreeItem[]>([]);

async function activate(): Promise<void> {
  // 文件：发出 open；目录：切换展开并首次展开时懒加载子目录
  if (!props.item.isDir) {
    emit('open', props.item.path);
    return;
  }
  expanded.value = !expanded.value;
  if (!expanded.value || children.value.length > 0) return;
  loading.value = true;
  error.value = null;
  try {
    const result = await listFiles(props.root, props.item.path);
    children.value = result.entries.map((entry) => ({
      ...entry,
      path: joinPath(props.item.path, entry.name),
    }));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '目录读取失败';
  } finally {
    loading.value = false;
  }
}

function joinPath(parent: string, name: string): string {
  // 拼接相对路径（统一用 /）
  return parent ? `${parent}/${name}` : name;
}
</script>

<template>
  <li class="file-tree-item">
    <button
      type="button"
      class="file-tree-row"
      :style="{ paddingLeft: `${10 + depth * 15}px` }"
      :aria-expanded="item.isDir ? expanded : undefined"
      @click="activate"
    >
      <span class="file-tree-icon" aria-hidden="true">
        {{ item.isDir ? (expanded ? '▾' : '▸') : '·' }}
      </span>
      <span class="file-tree-name">{{ item.name }}</span>
    </button>
    <div v-if="loading" class="file-tree-note" :style="{ paddingLeft: `${26 + depth * 15}px` }">
      加载中…
    </div>
    <div v-else-if="error" class="file-tree-note file-tree-note--error" :title="error">
      无法展开
    </div>
    <ul v-if="expanded && children.length" class="file-tree-children">
      <FileTreeNode
        v-for="child in children"
        :key="child.path"
        :root="root"
        :item="child"
        :depth="depth + 1"
        @open="emit('open', $event)"
      />
    </ul>
  </li>
</template>

<style scoped>
/* 文件树节点：行、图标、名称与错误提示 */
.file-tree-root,
.file-tree-children {
  margin: 0;
  padding: 0;
  list-style: none;
}

.file-tree-row {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: 29px;
  padding-right: 8px;
  border: 0;
  color: #c8cbd3;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.file-tree-row:hover {
  background: rgba(255, 255, 255, 0.04);
}

:root[data-theme='light'] .file-tree-row {
  color: var(--text);
}

:root[data-theme='light'] .file-tree-row:hover {
  background: #edf2df;
}

.file-tree-icon {
  flex: 0 0 12px;
  color: var(--faint);
  font-size: 9px;
}

.file-tree-name {
  overflow: hidden;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-tree-note {
  padding: 12px;
  color: var(--faint);
  font-size: 10px;
}

.file-tree-note--error {
  color: var(--danger);
}
</style>
