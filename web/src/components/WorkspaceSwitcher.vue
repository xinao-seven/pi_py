<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import {
  createDefaultWorkspace,
  getWorkspaceHome,
  listWorkspaces,
  selectWorkspace,
} from "@/lib/api";

const props = defineProps<{ currentCwd: string | null }>();
const emit = defineEmits<{
  close: [];
  selected: [cwd: string];
}>();

const workspaces = ref<string[]>([]);
const workspaceHome = ref("");
const path = ref("");
const loading = ref(true);
const pending = ref(false);
const error = ref<string | null>(null);
const orderedWorkspaces = computed(() =>
  [...new Set(workspaces.value)].sort((left, right) => {
    if (left === props.currentCwd) return -1;
    if (right === props.currentCwd) return 1;
    return left.localeCompare(right);
  }),
);

onMounted(load);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [home, roots] = await Promise.all([getWorkspaceHome(), listWorkspaces()]);
    workspaceHome.value = home;
    workspaces.value = roots;
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    loading.value = false;
  }
}

async function choose(cwd: string): Promise<void> {
  if (!cwd.trim() || pending.value) return;
  pending.value = true;
  error.value = null;
  try {
    emit("selected", await selectWorkspace(cwd.trim()));
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    pending.value = false;
  }
}

async function createDefault(): Promise<void> {
  if (pending.value) return;
  pending.value = true;
  error.value = null;
  try {
    emit("selected", await createDefaultWorkspace());
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    pending.value = false;
  }
}

function folderName(cwd: string): string {
  return cwd.replaceAll("\\", "/").replace(/\/$/, "").split("/").at(-1) || cwd;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "无法切换项目目录";
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')" @keydown.esc="emit('close')">
    <section class="config-dialog workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-title">
      <header class="config-header">
        <div>
          <div class="welcome-kicker">SAFE LOCAL WORKSPACES</div>
          <h2 id="workspace-title">切换项目目录</h2>
          <p>切换后会在目标项目中开始新会话，当前会话仍会保留。</p>
        </div>
        <button type="button" aria-label="关闭项目目录选择" @click="emit('close')">×</button>
      </header>

      <div v-if="loading" class="config-state">正在读取可用项目…</div>
      <div v-else class="config-body">
        <form class="workspace-path-form" @submit.prevent="choose(path)">
          <label for="workspace-path-input">项目绝对路径</label>
          <div>
            <input
              id="workspace-path-input"
              v-model="path"
              autofocus
              autocomplete="off"
              :placeholder="workspaceHome ? `${workspaceHome} 下的项目目录` : '输入项目绝对路径'"
            />
            <button type="submit" class="primary-action" :disabled="!path.trim() || pending">打开</button>
          </div>
          <small v-if="workspaceHome">安全范围：{{ workspaceHome }}</small>
        </form>

        <div class="workspace-list-heading">最近和已登记的项目</div>
        <div v-if="orderedWorkspaces.length === 0" class="config-empty">尚无可复用的项目目录</div>
        <div v-else class="workspace-list">
          <button
            v-for="cwd in orderedWorkspaces"
            :key="cwd"
            type="button"
            class="workspace-option"
            :class="{ 'workspace-option--current': cwd === currentCwd }"
            :disabled="pending"
            @click="choose(cwd)"
          >
            <span>{{ folderName(cwd) }}</span>
            <code :title="cwd">{{ cwd }}</code>
            <small v-if="cwd === currentCwd">当前项目</small>
          </button>
        </div>
      </div>

      <div v-if="error" class="config-error" role="alert">{{ error }}</div>
      <footer class="config-footer">
        <button type="button" :disabled="pending" @click="createDefault">新建默认工作区</button>
        <button type="button" @click="emit('close')">取消</button>
      </footer>
    </section>
  </div>
</template>
