<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";

import AppShell from "@/components/AppShell.vue";
import ChatWindow from "@/components/ChatWindow.vue";
import FileWorkspacePanel from "@/components/FileWorkspacePanel.vue";
import SessionSidebar from "@/components/SessionSidebar.vue";
import { createDefaultWorkspace, listSessions } from "@/lib/api";
import { useAppStore } from "@/stores/app";
import type { SessionInfo } from "@/types";

const store = useAppStore();
const {
  selectedSessionId,
  newSessionCwd,
  sidebarOpen,
  filePanelOpen,
  fileTabs,
  activeFilePath,
} = storeToRefs(store);
const sessions = ref<SessionInfo[]>([]);
const sessionsLoading = ref(true);
const appError = ref<string | null>(null);
const selectedWorkspace = computed(
  () => sessions.value.find((session) => session.id === selectedSessionId.value)?.cwd ?? null,
);

async function refreshSessions(): Promise<void> {
  try {
    sessions.value = await listSessions();
    appError.value = null;
  } catch (cause) {
    appError.value = cause instanceof Error ? cause.message : "无法加载会话";
  } finally {
    sessionsLoading.value = false;
  }
}

async function startNewSession(): Promise<void> {
  try {
    const cwd = await createDefaultWorkspace();
    store.startSession(cwd);
    appError.value = null;
  } catch (cause) {
    appError.value = cause instanceof Error ? cause.message : "无法创建工作区";
  }
}

function sessionCreated(sessionId: string): void {
  store.selectSession(sessionId);
  void refreshSessions();
}

function sessionForked(sessionId: string): void {
  store.selectSession(sessionId);
  void refreshSessions();
}

watch(selectedWorkspace, (root) => store.setFileWorkspace(root));

onMounted(() => {
  void refreshSessions();
});
</script>

<template>
  <AppShell v-model:sidebar-open="sidebarOpen" :file-panel-open="filePanelOpen && !!selectedWorkspace">
    <template #sidebar>
      <SessionSidebar
        :sessions="sessions"
        :loading="sessionsLoading"
        :selected-session-id="selectedSessionId"
        :new-session-active="newSessionCwd !== null"
        @new-session="startNewSession"
        @select-session="store.selectSession"
      />
    </template>

    <template #files>
      <FileWorkspacePanel
        v-if="selectedWorkspace"
        :root="selectedWorkspace"
        :tabs="fileTabs"
        :active-path="activeFilePath"
        @open="store.openFile"
        @select="activeFilePath = $event"
        @close="store.closeFile"
        @close-panel="filePanelOpen = false"
      />
    </template>

    <div v-if="appError" class="app-alert" role="alert">
      {{ appError }}
      <button type="button" aria-label="关闭错误提示" @click="appError = null">×</button>
    </div>

    <ChatWindow
      :session-id="selectedSessionId"
      :new-session-cwd="newSessionCwd"
      :sessions="sessions"
      @session-created="sessionCreated"
      @session-forked="sessionForked"
      @agent-end="refreshSessions"
      @open-sidebar="sidebarOpen = true"
      @toggle-files="store.toggleFilePanel"
    />
  </AppShell>
</template>
