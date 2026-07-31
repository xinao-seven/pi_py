<script setup lang="ts">
import { ref } from "vue";

import { listFiles } from "@/lib/api";
import type { FileTreeItem } from "@/types";

defineOptions({ name: "FileTreeNode" });

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
  if (!props.item.isDir) {
    emit("open", props.item.path);
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
    error.value = cause instanceof Error ? cause.message : "目录读取失败";
  } finally {
    loading.value = false;
  }
}

function joinPath(parent: string, name: string): string {
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
        {{ item.isDir ? (expanded ? "▾" : "▸") : "·" }}
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
