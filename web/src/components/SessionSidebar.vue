<script setup lang="ts">
import { computed } from "vue";

import type { SessionInfo } from "@/types";

const props = defineProps<{
  sessions: SessionInfo[];
  loading: boolean;
  selectedSessionId: string | null;
  newSessionActive: boolean;
  skillsAvailable: boolean;
}>();

interface SessionListItem {
  session: SessionInfo;
  depth: number;
}

const visibleSessions = computed<SessionListItem[]>(() => {
  const byId = new Map(props.sessions.map((session) => [session.id, session]));
  const children = new Map<string, SessionInfo[]>();
  for (const session of props.sessions) {
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
  for (const session of props.sessions) {
    if (!session.parentSessionId || !byId.has(session.parentSessionId)) append(session, 0);
  }
  for (const session of props.sessions) append(session, 0);
  return result;
});

const emit = defineEmits<{
  newSession: [];
  selectSession: [sessionId: string];
  openModels: [];
  openSkills: [];
}>();

function sessionTitle(session: SessionInfo): string {
  return session.name?.trim() || session.firstMessage?.trim() || "未命名会话";
}

function relativeDate(value: string): string {
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
    </div>

    <button class="new-session-button" type="button" @click="emit('newSession')">
      <span aria-hidden="true">＋</span>
      新建会话
    </button>

    <div class="session-section-heading">
      <span>最近会话</span>
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

      <button
        v-for="item in visibleSessions"
        :key="item.session.id"
        type="button"
        class="session-item"
        :class="{
          'session-item--active': selectedSessionId === item.session.id,
          'session-item--fork': item.depth > 0,
          'session-item--orphan': item.session.orphaned,
        }"
        :disabled="item.session.orphaned"
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
    </div>

    <div class="sidebar-footer">
      <div class="sidebar-config-actions">
        <button type="button" @click="emit('openModels')">模型</button>
        <button type="button" :disabled="!skillsAvailable" @click="emit('openSkills')">Skills</button>
      </div>
      <div class="sidebar-service"><span class="status-dot" aria-hidden="true" />本地 FastAPI 服务</div>
    </div>
  </div>
</template>
