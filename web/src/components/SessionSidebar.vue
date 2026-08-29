<!-- 会话侧栏：按工作区文件夹折叠分组，Fork 在组内缩进，通用会话固定置底。 -->
<script setup lang="ts">
import { computed, ref } from 'vue';

import type { SessionInfo } from '@/types';

const props = withDefaults(
  defineProps<{
    sessions: SessionInfo[];
    loading: boolean;
    selectedSessionId: string | null;
    newSessionActive: boolean;
    agentRunning: boolean;
  }>(),
  {},
);

interface SessionListItem {
  session: SessionInfo;
  depth: number;
}

interface SessionGroup {
  key: string;
  label: string;
  path: string;
  sessions: SessionListItem[];
}

const GENERIC_HOME = 'c:/users/xinao';
const collapsedGroups = ref(new Set<string>());

const groupedSessions = computed<SessionGroup[]>(() => {
  // 先按工作区归类，再在每个项目内部恢复 Fork 树，避免跨项目缩进混杂。
  const groups = new Map<string, { label: string; path: string; source: SessionInfo[] }>();
  for (const session of props.sessions) {
    const group = groupFor(session.cwd);
    const current = groups.get(group.key) ?? { label: group.label, path: group.path, source: [] };
    current.source.push(session);
    groups.set(group.key, current);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      label: group.label,
      path: group.path,
      sessions: treeSessions(group.source),
    }))
    .sort((left, right) => {
      if (left.key === 'generic') return 1;
      if (right.key === 'generic') return -1;
      return left.label.localeCompare(right.label, 'zh-CN');
    });
});

function treeSessions(sessions: SessionInfo[]): SessionListItem[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const children = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    if (!session.parentSessionId || !byId.has(session.parentSessionId)) continue;
    const group = children.get(session.parentSessionId) ?? [];
    group.push(session);
    children.set(session.parentSessionId, group);
  }
  const result: SessionListItem[] = [];
  const visited = new Set<string>();
  function append(session: SessionInfo, depth: number): void {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    result.push({ session, depth });
    for (const child of children.get(session.id) ?? []) append(child, depth + 1);
  }
  for (const session of sessions) {
    if (!session.parentSessionId || !byId.has(session.parentSessionId)) append(session, 0);
  }
  for (const session of sessions) append(session, 0);
  return result;
}

const emit = defineEmits<{
  newSession: [];
  selectSession: [sessionId: string];
  openSettings: [];
  collapseSidebar: [];
}>();

function toggleGroup(key: string): void {
  const next = new Set(collapsedGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedGroups.value = next;
}

function groupExpanded(key: string): boolean {
  return !collapsedGroups.value.has(key);
}

function sessionTitle(session: SessionInfo): string {
  // 会话标题：优先自定义名称，其次首条消息，最后兜底文案
  return session.name?.trim() || session.firstMessage?.trim() || '未命名会话';
}

function groupFor(cwd: string): { key: string; label: string; path: string } {
  const normalized = normalizePath(cwd);
  if (normalized === GENERIC_HOME || normalized.startsWith(`${GENERIC_HOME}/`)) {
    return { key: 'generic', label: '通用会话', path: 'C:\\Users\\xinao' };
  }
  return { key: normalized || cwd, label: folderName(cwd), path: cwd };
}

function normalizePath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .replace(/^\/c\//i, 'c:/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function folderName(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').split('/').at(-1) || path;
}

function relativeDate(value: string): string {
  // 时间显示：今天显示时刻，否则显示月/日
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
</script>

<template>
  <div class="sidebar-content">
    <div class="brand-row">
      <div class="brand-mark" aria-hidden="true">π</div>
      <div>
        <div class="brand-name">pi.py</div>
        <div class="brand-caption">coding agent</div>
      </div>
      <button
        class="sidebar-collapse-button"
        type="button"
        aria-label="收起会话侧栏"
        title="收起侧栏"
        @click="emit('collapseSidebar')"
      >
        «
      </button>
    </div>

    <button
      class="new-session-button"
      type="button"
      :disabled="agentRunning"
      @click="emit('newSession')"
    >
      <span aria-hidden="true">＋</span>
      新建会话
    </button>

    <div class="session-section-heading">
      <span>会话记录</span>
      <span v-if="sessions.length" class="session-count">{{ sessions.length }}</span>
    </div>

    <div class="session-list" aria-live="polite">
      <div v-if="loading" class="sidebar-note">正在读取会话…</div>
      <div v-else-if="sessions.length === 0" class="sidebar-note">
        还没有历史会话，从上方开始一次新对话。
      </div>

      <button
        v-if="newSessionActive"
        type="button"
        class="session-item session-item--active"
        @click="emit('newSession')"
      >
        <span class="session-title">新会话</span>
        <span class="session-meta">等待第一条消息</span>
      </button>

      <section
        v-for="group in groupedSessions"
        :key="group.key"
        class="session-project-group"
        :class="{ 'session-project-group--generic': group.key === 'generic' }"
      >
        <button
          class="session-project-heading"
          type="button"
          :title="group.path"
          :aria-expanded="groupExpanded(group.key)"
          @click="toggleGroup(group.key)"
        >
          <span class="session-project-chevron" aria-hidden="true">›</span>
          <span class="session-project-icon" aria-hidden="true">□</span>
          <span class="session-project-name">{{ group.label }}</span>
          <span class="session-project-count">{{ group.sessions.length }}</span>
        </button>
        <div v-show="groupExpanded(group.key)" class="session-project-body">
          <button
            v-for="item in group.sessions"
            :key="item.session.id"
            type="button"
            class="session-item"
            :class="{
              'session-item--active': selectedSessionId === item.session.id,
              'session-item--fork': item.depth > 0,
              'session-item--orphan': item.session.orphaned,
            }"
            :disabled="item.session.orphaned || agentRunning"
            :title="item.session.orphanReason"
            :style="{
              marginLeft: `${Math.min(item.depth, 3) * 12}px`,
              width: `calc(100% - ${Math.min(item.depth, 3) * 12}px)`,
            }"
            @click="emit('selectSession', item.session.id)"
          >
            <span class="session-title">
              <span v-if="item.depth" class="session-fork-mark" aria-label="Fork Session">└</span>
              {{ sessionTitle(item.session) }}
              <span v-if="item.session.orphaned" class="orphan-badge">不完整</span>
            </span>
            <span class="session-meta">
              <span class="session-cwd">{{ item.session.cwd }}</span>
              <time :datetime="item.session.modified">{{
                relativeDate(item.session.modified)
              }}</time>
            </span>
          </button>
        </div>
      </section>
    </div>

    <div class="sidebar-footer">
      <div class="sidebar-service">
        <span class="status-dot" aria-hidden="true" />本地 FastAPI 服务
      </div>
      <button class="sidebar-settings-button" type="button" @click="emit('openSettings')">
        <span aria-hidden="true">⚙</span>
        设置
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 会话侧栏：品牌区、会话分组列表、底部设置入口（含 2026 白灰重设计的最终值） */
.sidebar-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  padding: 12px 10px 10px;
}

.brand-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 3px 10px;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text);
  background: var(--panel);
  font-family: Georgia, serif;
  font-weight: 700;
  font-size: 18px;
}

.brand-name {
  font-weight: 720;
  letter-spacing: -0.02em;
}

.brand-caption {
  display: none;
}

.sidebar-collapse-button {
  display: grid;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  margin-left: auto;
  padding: 0;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--faint);
  background: transparent;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.sidebar-collapse-button:hover {
  color: var(--text);
  background: var(--panel-soft);
}

:root[data-theme='light'] .sidebar-collapse-button:hover,
:root[data-theme='light'] .session-item:hover,
:root[data-theme='light'] .sidebar-config-actions button:hover {
  background: #edf1e5;
}

.new-session-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  min-height: 38px;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  color: var(--text);
  background: var(--panel);
  font-size: 13px;
  font-weight: 620;
  cursor: pointer;
  transition: 150ms ease;
}

.new-session-button:hover {
  border-color: var(--line-strong);
  background: var(--panel-soft);
}

.new-session-button:disabled {
  opacity: 0.45;
  cursor: default;
}

.session-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 7px 7px;
  color: var(--faint);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.session-count {
  display: grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  border: 0;
  border-radius: 5px;
  color: var(--faint);
  background: transparent;
  font-size: 10px;
}

.session-project-count {
  display: grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  border: 0;
  border-radius: 5px;
  color: var(--faint);
  background: transparent;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.session-list {
  flex: 1;
  min-height: 0;
  padding-right: 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: #363a43 transparent;
}

.session-list::-webkit-scrollbar {
  width: 8px;
}

.session-list::-webkit-scrollbar-track {
  background: transparent;
}

.session-list::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 99px;
  background: #3b404a;
  background-clip: content-box;
}

.session-list::-webkit-scrollbar-thumb:hover {
  background-color: #626a77;
}

.session-project-group {
  margin-bottom: 3px;
}

.session-project-group--generic {
  margin-top: 12px;
  padding-top: 9px;
  border-top: 1px solid var(--line);
}

.session-project-heading {
  display: grid;
  grid-template-columns: 14px 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: 31px;
  padding: 0 7px;
  border: 0;
  border-radius: 5px;
  color: var(--muted);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.session-project-heading:hover {
  background: var(--panel-soft);
}

.session-project-chevron {
  display: inline-block;
  color: var(--faint);
  font-size: 16px;
  line-height: 1;
  transition: transform 140ms ease;
}

.session-project-heading[aria-expanded='true'] .session-project-chevron {
  transform: rotate(90deg);
}

.session-project-icon {
  color: var(--faint);
  font-size: 13px;
}

.session-project-name {
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-project-body {
  margin-left: 14px;
  padding-left: 9px;
  border-left: 1px solid var(--line);
}

.session-item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  min-height: 35px;
  margin-bottom: 2px;
  padding: 7px 8px;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: 140ms ease;
}

.session-item:hover {
  background: var(--panel-soft);
}

.session-item--active {
  border-color: transparent;
  background: var(--panel-soft);
}

.session-item--fork {
  border-left-color: rgba(231, 255, 111, 0.12);
}

.session-item--orphan {
  opacity: 0.58;
  cursor: not-allowed;
}

.orphan-badge {
  margin-left: 5px;
  padding: 2px 5px;
  border: 1px solid rgba(255, 129, 120, 0.25);
  border-radius: 8px;
  color: var(--danger);
  font-size: 8px;
  font-weight: 650;
}

.session-fork-mark {
  margin-right: 4px;
  color: var(--faint);
}

.session-title {
  overflow: hidden;
  color: var(--text);
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-meta {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  color: var(--faint);
  font-size: 9px;
}

.session-cwd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-note {
  padding: 16px 10px;
  color: var(--faint);
  font-size: 12px;
  line-height: 1.6;
}

.sidebar-footer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 0 0;
  border-top: 1px solid var(--line);
  color: var(--faint);
  font-size: 10px;
  letter-spacing: 0.04em;
}

.sidebar-config-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.sidebar-config-actions button {
  min-height: 31px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--muted);
  background: rgba(255, 255, 255, 0.025);
  cursor: pointer;
}

.sidebar-config-actions button:disabled {
  opacity: 0.38;
  cursor: default;
}

.sidebar-service {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  color: var(--faint);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #888888;
}

:root[data-theme='light'] .status-dot {
  background: #198754;
  box-shadow: 0 0 8px rgba(25, 135, 84, 0.35);
}

.sidebar-settings-button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 37px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  color: var(--text);
  background: var(--panel);
  font-size: 12px;
  cursor: pointer;
}

.sidebar-settings-button:hover {
  background: var(--panel-soft);
}

:root[data-theme='light'] .sidebar-config-actions button {
  color: var(--muted);
  background: #f8f9f5;
}

@media (max-width: 760px) {
  .sidebar-collapse-button {
    display: none;
  }
}
</style>
