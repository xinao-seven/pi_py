<!-- 分支导航条：选择会话树节点定位/Fork，或从其他会话合并有界摘要。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { AgentMessage, SessionInfo, SessionTreeNode } from '@/types';

interface TreeOption {
  id: string;
  depth: number;
  label: string;
  canFork: boolean;
}

const props = defineProps<{
  tree: SessionTreeNode[];
  leafId: string | null;
  sessions: SessionInfo[];
  currentSessionId: string;
  busy?: boolean;
}>();

const emit = defineEmits<{
  navigate: [entryId: string];
  fork: [entryId: string];
  merge: [sourceSessionId: string];
}>();

const selectedEntryId = ref(props.leafId ?? '');
const mergeSourceId = ref('');

const options = computed(() => flattenTree(props.tree));
// 拍平的树选项（带深度缩进）
const selectedOption = computed(() =>
  options.value.find((option) => option.id === selectedEntryId.value),
);
const mergeSources = computed(() =>
  props.sessions.filter((session) => session.id !== props.currentSessionId),
);

watch(
  () => props.leafId,
  (leafId) => {
    selectedEntryId.value = leafId ?? '';
  },
);

function navigate(): void {
  if (selectedEntryId.value && selectedEntryId.value !== props.leafId) {
    emit('navigate', selectedEntryId.value);
  }
}

function fork(): void {
  if (selectedEntryId.value && selectedOption.value?.canFork) {
    emit('fork', selectedEntryId.value);
  }
}

function merge(): void {
  if (!mergeSourceId.value) return;
  emit('merge', mergeSourceId.value);
  mergeSourceId.value = '';
}

function flattenTree(nodes: SessionTreeNode[], depth = 0): TreeOption[] {
  // 递归把会话树拍平成下拉选项；assistant 消息节点才允许 Fork
  return nodes.flatMap((node) => {
    const message = node.entry.message;
    const option: TreeOption = {
      id: node.entry.id,
      depth,
      label: node.label || describeEntry(node.entry.type, message),
      canFork: node.entry.type === 'message' && message?.role === 'assistant',
    };
    return [option, ...flattenTree(node.children, depth + 1)];
  });
}

function describeEntry(type: string, message?: AgentMessage): string {
  // 节点标签：消息显示“你/pi: 摘要”，其他类型显示类型名
  if (type !== 'message' || !message) return type.replaceAll('_', ' ');
  const text = messageText(message).replace(/\s+/g, ' ').trim();
  const prefix =
    message.role === 'user' ? '你' : message.role === 'assistant' ? 'pi' : message.role;
  return `${prefix}: ${text || '（空消息）'}`.slice(0, 72);
}

function messageText(message: AgentMessage): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? [])
    .map((block) => block.text ?? block.thinking ?? '')
    .filter(Boolean)
    .join(' ');
}
</script>

<template>
  <div class="branch-navigator" aria-label="会话分支操作">
    <label class="branch-field">
      <span>分支</span>
      <select v-model="selectedEntryId" :disabled="busy || options.length === 0">
        <option v-for="option in options" :key="option.id" :value="option.id">
          {{ `${'· '.repeat(option.depth)}${option.label}` }}
        </option>
      </select>
    </label>
    <button
      type="button"
      class="branch-action"
      :disabled="busy || !selectedEntryId || selectedEntryId === leafId"
      @click="navigate"
    >
      定位
    </button>
    <button
      type="button"
      class="branch-action"
      :disabled="busy || !selectedOption?.canFork"
      title="从选中的 assistant 回复创建独立 Session"
      @click="fork"
    >
      Fork
    </button>
    <details class="merge-menu">
      <summary>合并</summary>
      <div class="merge-popover">
        <label>
          来源 Session
          <select v-model="mergeSourceId" :disabled="busy || mergeSources.length === 0">
            <option value="">请选择</option>
            <option v-for="session in mergeSources" :key="session.id" :value="session.id">
              {{ session.name || session.firstMessage }}
            </option>
          </select>
        </label>
        <button type="button" :disabled="busy || !mergeSourceId" @click="merge">追加摘要</button>
      </div>
    </details>
  </div>
</template>

<style scoped>
/* 分支导航：分支切换下拉与合并弹层 */
.branch-navigator {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.branch-field {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: var(--faint);
  font-size: 10px;
}

.branch-field select {
  width: min(36vw, 340px);
  min-height: 30px;
  padding: 0 28px 0 9px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  background: var(--panel);
}

:root[data-theme='light'] .branch-field select {
  color: var(--text);
  background: #fbfcf8;
}

.branch-action {
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  background: var(--panel);
  font-size: 10px;
  cursor: pointer;
}

.branch-action:disabled {
  opacity: 0.4;
  cursor: default;
}

:root[data-theme='light'] .branch-action,
:root[data-theme='light'] .merge-menu summary,
:root[data-theme='light'] .merge-popover button {
  color: var(--muted);
  background: #f8f9f5;
}

:root[data-theme='light'] .branch-action:hover,
:root[data-theme='light'] .merge-menu summary:hover {
  background: #edf1e5;
}

.merge-menu {
  position: relative;
}

.merge-menu summary {
  display: grid;
  place-items: center;
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  background: var(--panel);
  font-size: 10px;
  cursor: pointer;
  list-style: none;
}

.merge-menu summary::-webkit-details-marker {
  display: none;
}

.merge-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 40;
  display: grid;
  gap: 9px;
  width: 260px;
  padding: 12px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--panel);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.38);
}

:root[data-theme='light'] .merge-popover {
  background: #ffffff;
}

.merge-popover label {
  display: grid;
  gap: 6px;
  color: var(--faint);
  font-size: 10px;
}

.merge-popover select {
  width: 100%;
  min-height: 30px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  background: var(--panel);
}

:root[data-theme='light'] .merge-popover select {
  color: var(--text);
  background: #fbfcf8;
}

.merge-popover button {
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  background: var(--panel);
  font-size: 10px;
  cursor: pointer;
}

.merge-popover button:disabled {
  opacity: 0.4;
  cursor: default;
}

:root[data-theme='light'] .merge-popover button {
  color: var(--muted);
  background: #f8f9f5;
}

@media (max-width: 760px) {
  .branch-navigator {
    flex-wrap: wrap;
  }

  .branch-field {
    flex: 1 1 100%;
  }

  .branch-field > span {
    display: none;
  }

  .branch-field select {
    width: 100%;
  }
}
</style>
