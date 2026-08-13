<!-- 会话侧栏：按项目路径分区显示会话，Fork 在各项目内缩进。 -->
<script setup lang="ts">
import { computed } from "vue";

import type { SessionInfo } from "@/types";

const props = defineProps<{
  sessions: SessionInfo[];
  loading: boolean;
  selectedSessionId: string | null;
  newSessionActive: boolean;
  skillsAvailable: boolean;
  theme: "dark" | "light";
  soundEnabled: boolean;
  agentRunning: boolean;
}>();

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

const GENERIC_HOME = "c:/users/xinao";

const groupedSessions = computed<SessionGroup[]>(() => {
  // 先按工作区归类，再在每个项目内部恢复 Fork 树，避免跨项目缩进混杂。
  const groups = new Map<string, { label: string; path: string; source: SessionInfo[] }>();
  for (const session of props.sessions) {
    const group = groupFor(session.cwd);
    const current = groups.get(group.key) ?? { label: group.label, path: group.path, source: [] };
    current.source.push(session);
    groups.set(group.key, current);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    label: group.label,
    path: group.path,
    sessions: treeSessions(group.source),
  }));
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
  openModels: [];
  openSkills: [];
  toggleTheme: [];
  toggleSound: [];
  collapseSidebar: [];
}>();

function sessionTitle(session: SessionInfo): string {
  // 会话标题：优先自定义名称，其次首条消息，最后兜底文案
  return session.name?.trim() || session.firstMessage?.trim() || "未命名会话";
}

function groupFor(cwd: string): { key: string; label: string; path: string } {
  const normalized = normalizePath(cwd);
  if (normalized === GENERIC_HOME || normalized.startsWith(`${GENERIC_HOME}/`)) {
    return { key: "generic", label: "通用项目", path: "C:\\Users\\xinao" };
  }
  return { key: normalized || cwd, label: folderName(cwd), path: cwd };
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/c\//i, "c:/").replace(/\/+$/, "").toLowerCase();
}

function folderName(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "").split("/").at(-1) || path;
}

function relativeDate(value: string): string {
  // 时间显示：今天显示时刻，否则显示月/日
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
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

    <button class="new-session-button" type="button" :disabled="agentRunning" @click="emit('newSession')">
      <span aria-hidden="true">＋</span>
      新建会话
    </button>

    <div class="session-section-heading">
      <span>项目会话</span>
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

      <section v-for="group in groupedSessions" :key="group.key" class="session-project-group">
        <header class="session-project-heading" :title="group.path">
          <span class="session-project-name">{{ group.label }}</span>
          <span class="session-project-count">{{ group.sessions.length }}</span>
          <code>{{ group.path }}</code>
        </header>
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
          :style="{ marginLeft: `${Math.min(item.depth, 3) * 12}px`, width: `calc(100% - ${Math.min(item.depth, 3) * 12}px)` }"
          @click="emit('selectSession', item.session.id)"
        >
          <span class="session-title">
            <span v-if="item.depth" class="session-fork-mark" aria-label="Fork Session">↳</span>
            {{ sessionTitle(item.session) }}
            <span v-if="item.session.orphaned" class="orphan-badge">不完整</span>
          </span>
          <span class="session-meta">
            <span class="session-cwd">{{ item.session.cwd }}</span>
            <time :datetime="item.session.modified">{{ relativeDate(item.session.modified) }}</time>
          </span>
        </button>
      </section>
    </div>

    <div class="sidebar-footer">
      <div class="sidebar-config-actions">
        <button type="button" @click="emit('openModels')">模型</button>
        <button type="button" :disabled="!skillsAvailable" @click="emit('openSkills')">Skills</button>
        <button type="button" :aria-label="theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'" @click="emit('toggleTheme')">
          {{ theme === "dark" ? "浅色" : "深色" }}
        </button>
        <button type="button" :aria-pressed="soundEnabled" @click="emit('toggleSound')">
          {{ soundEnabled ? "声音开" : "声音关" }}
        </button>
      </div>
      <div class="sidebar-service"><span class="status-dot" aria-hidden="true" />本地 FastAPI 服务</div>
    </div>
  </div>
</template>
