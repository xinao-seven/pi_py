<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";

import AppShell from "@/components/AppShell.vue";
import ChatWindow from "@/components/ChatWindow.vue";
import FileWorkspacePanel from "@/components/FileWorkspacePanel.vue";
import ModelsConfig from "@/components/ModelsConfig.vue";
import SkillsConfig from "@/components/SkillsConfig.vue";
import WorkspaceSwitcher from "@/components/WorkspaceSwitcher.vue";
import SessionSidebar from "@/components/SessionSidebar.vue";
import { listSessions } from "@/lib/api";
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
  modelsConfigOpen,
  skillsConfigOpen,
  theme,
  soundEnabled,
} = storeToRefs(store);
const sessions = ref<SessionInfo[]>([]);
const sessionsLoading = ref(true);
const appError = ref<string | null>(null);
const modelsRevision = ref(0);
const workspaceSwitcherOpen = ref(false);
const agentRunning = ref(false);
const selectedWorkspace = computed(
  () =>
    sessions.value.find((session) => session.id === selectedSessionId.value)?.cwd
    ?? newSessionCwd.value
    ?? null,
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

function startNewSession(): void {
  if (agentRunning.value) return;
  workspaceSwitcherOpen.value = true;
}

function openWorkspaceSwitcher(): void {
  if (!agentRunning.value) workspaceSwitcherOpen.value = true;
}

function switchWorkspace(cwd: string): void {
  store.startSession(cwd);
  workspaceSwitcherOpen.value = false;
  appError.value = null;
}

function sessionCreated(sessionId: string): void {
  store.selectSession(sessionId);
  void refreshSessions();
}

function sessionForked(sessionId: string): void {
  store.selectSession(sessionId);
  void refreshSessions();
}

let audioContext: AudioContext | null = null;

function toggleSound(): void {
  store.toggleSound();
  if (soundEnabled.value) playCompletionTone(0.035);
}

function handleAgentEnd(): void {
  void refreshSessions();
  if (soundEnabled.value) playCompletionTone(0.08);
}

function playCompletionTone(volume: number): void {
  try {
    audioContext ??= new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.setValueAtTime(660, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(880, audioContext.currentTime + 0.12);
    gain.gain.setValueAtTime(volume, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.18);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.18);
  } catch {
    // Sound is optional; unsupported or blocked audio must not affect the Agent.
  }
}

watch(selectedWorkspace, (root) => store.setFileWorkspace(root));

onMounted(() => {
  store.initializePreferences();
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
        :skills-available="!!selectedWorkspace"
        :theme="theme"
        :sound-enabled="soundEnabled"
        :agent-running="agentRunning"
        @new-session="startNewSession"
        @select-session="store.selectSession"
        @open-models="modelsConfigOpen = true"
        @open-skills="skillsConfigOpen = true"
        @toggle-theme="store.toggleTheme"
        @toggle-sound="toggleSound"
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
      :models-revision="modelsRevision"
      @session-created="sessionCreated"
      @session-forked="sessionForked"
      @agent-end="handleAgentEnd"
      @open-sidebar="sidebarOpen = true"
      @toggle-files="store.toggleFilePanel"
      @switch-workspace="openWorkspaceSwitcher"
      @running-change="agentRunning = $event"
    />
  </AppShell>

  <ModelsConfig
    v-if="modelsConfigOpen"
    @close="modelsConfigOpen = false"
    @saved="modelsRevision += 1"
  />
  <SkillsConfig
    v-if="skillsConfigOpen && selectedWorkspace"
    :cwd="selectedWorkspace"
    @close="skillsConfigOpen = false"
  />
  <WorkspaceSwitcher
    v-if="workspaceSwitcherOpen"
    :current-cwd="selectedWorkspace"
    @close="workspaceSwitcherOpen = false"
    @selected="switchWorkspace"
  />
</template>
