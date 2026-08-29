<!-- 项目切换弹窗：列出已登记/历史工作区，也可输入任意已有本地目录。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import {
  createDefaultWorkspace,
  getWorkspaceHome,
  listWorkspaces,
  pickWorkspaceDirectory,
  selectWorkspace,
} from '@/lib/api';

const props = defineProps<{ currentCwd: string | null }>();
const emit = defineEmits<{
  close: [];
  selected: [cwd: string];
}>();

const workspaces = ref<string[]>([]);
const workspaceHome = ref('');
const path = ref('');
const loading = ref(true);
const pending = ref(false);
const error = ref<string | null>(null);
const orderedWorkspaces = computed(() =>
  // 去重排序，当前工作区置顶
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
  // 选择/登记工作区并通知父组件
  if (!cwd.trim() || pending.value) return;
  pending.value = true;
  error.value = null;
  try {
    emit('selected', await selectWorkspace(cwd.trim()));
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    pending.value = false;
  }
}

async function createDefault(): Promise<void> {
  // 创建默认工作区
  if (pending.value) return;
  pending.value = true;
  error.value = null;
  try {
    emit('selected', await createDefaultWorkspace());
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    pending.value = false;
  }
}

async function pickDirectory(): Promise<void> {
  if (pending.value) return;
  pending.value = true;
  error.value = null;
  try {
    const cwd = await pickWorkspaceDirectory();
    if (cwd) emit('selected', cwd);
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    pending.value = false;
  }
}

function folderName(cwd: string): string {
  // 取路径最后一段作为展示名
  return cwd.replaceAll('\\', '/').replace(/\/$/, '').split('/').at(-1) || cwd;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : '无法切换项目目录';
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')" @keydown.esc="emit('close')">
    <section
      class="config-dialog workspace-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workspace-title"
    >
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
          <label for="workspace-path-input">项目目录</label>
          <div>
            <input
              id="workspace-path-input"
              v-model="path"
              autofocus
              autocomplete="off"
              :placeholder="
                workspaceHome ? `例如 ${workspaceHome}\\Projects\\my-app` : '输入项目绝对路径'
              "
            />
            <button type="submit" class="primary-action" :disabled="!path.trim() || pending">
              打开
            </button>
            <button
              type="button"
              class="workspace-picker-button"
              :disabled="pending"
              @click="pickDirectory"
            >
              选择文件夹…
            </button>
          </div>
          <small>点击“选择文件夹”打开系统目录选择器；也可直接输入任意已有本地目录。</small>
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

<style scoped>
/* 工作区切换：路径表单 + 已登记工作区列表；弹窗骨架在 globals.css 中共享 */
.workspace-dialog {
  width: min(720px, 100%);
}

.workspace-path-form {
  display: grid;
  gap: 7px;
  margin-bottom: 20px;
}

.workspace-path-form > label,
.workspace-list-heading {
  color: var(--faint);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.workspace-path-form > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
}

.workspace-path-form input {
  min-width: 0;
  min-height: 38px;
  padding: 0 11px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text);
  background: #0e1014;
}

:root[data-theme='light'] .workspace-path-form input {
  color: var(--text);
  background: #fbfcf8;
}

.workspace-path-form small {
  color: var(--faint);
  font-size: 9px;
}

.workspace-picker-button {
  min-height: 38px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  color: var(--muted);
  background: var(--panel-raised);
  font-size: 11px;
  cursor: pointer;
}

.workspace-picker-button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
  background: var(--panel-soft);
}

.workspace-picker-button:disabled {
  cursor: default;
  opacity: 0.55;
}

.workspace-list-heading {
  margin-bottom: 8px;
}

.workspace-list {
  display: grid;
  gap: 7px;
}

.workspace-option {
  display: grid;
  grid-template-columns: minmax(120px, 0.45fr) minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 46px;
  padding: 8px 11px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text);
  background: var(--panel-raised);
  text-align: left;
  cursor: pointer;
}

.workspace-option:hover,
.workspace-option--current {
  border-color: var(--line-strong);
  background: var(--panel-soft);
}

.workspace-option:disabled {
  opacity: 0.55;
  cursor: default;
}

.workspace-option > span {
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-option code {
  overflow: hidden;
  color: var(--muted);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-option small {
  color: var(--accent);
  font-size: 9px;
}

@media (max-width: 760px) {
  .workspace-path-form > div {
    grid-template-columns: 1fr;
  }

  .workspace-option {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .workspace-option code {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}
</style>
