<!-- 根组件：组装三栏布局（侧栏/聊天/文件），管理会话列表、配置弹窗与主题声音。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';

import AppShell from '@/components/AppShell.vue';
import ChatWindow from '@/components/ChatWindow.vue';
import FileWorkspacePanel from '@/components/FileWorkspacePanel.vue';
import SettingsDialog from '@/components/SettingsDialog.vue';
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher.vue';
import SessionSidebar from '@/components/SessionSidebar.vue';
import { listSessions } from '@/lib/api';
import { useAppStore } from '@/stores/app';
import type { SessionInfo } from '@/types';

const store = useAppStore();
const {
  selectedSessionId,
  newSessionCwd,
  sidebarOpen,
  sidebarCollapsed,
  filePanelOpen,
  fileTabs,
  activeFilePath,
  theme,
  soundEnabled,
} = storeToRefs(store);
const sessions = ref<SessionInfo[]>([]);
const sessionsLoading = ref(true);
const appError = ref<string | null>(null);
const modelsRevision = ref(0);
const workspaceSwitcherOpen = ref(false);
const settingsOpen = ref(false);
const agentRunning = ref(false);
let sessionsRefreshing = false;
let sessionRetryTimer: ReturnType<typeof setInterval> | undefined;
// 当前工作区：历史会话的 cwd 或新会话选中的目录
const selectedWorkspace = computed(
  () =>
    sessions.value.find((session) => session.id === selectedSessionId.value)?.cwd ??
    newSessionCwd.value ??
    null,
);

async function refreshSessions(): Promise<void> {
  // 刷新侧栏会话列表
  if (sessionsRefreshing) return;
  sessionsRefreshing = true;
  try {
    sessions.value = await listSessions();
    appError.value = null;
    stopSessionRecovery();
  } catch (cause) {
    appError.value = cause instanceof Error ? cause.message : '无法加载会话';
    startSessionRecovery();
  } finally {
    sessionsLoading.value = false;
    sessionsRefreshing = false;
  }
}

function startSessionRecovery(): void {
  if (sessionRetryTimer !== undefined) return;
  sessionRetryTimer = setInterval(() => void refreshSessions(), 2_000);
}

function stopSessionRecovery(): void {
  if (sessionRetryTimer === undefined) return;
  clearInterval(sessionRetryTimer);
  sessionRetryTimer = undefined;
}

function startNewSession(): void {
  if (agentRunning.value) return;
  workspaceSwitcherOpen.value = true;
}

function openWorkspaceSwitcher(): void {
  if (!agentRunning.value) workspaceSwitcherOpen.value = true;
}

function switchWorkspace(cwd: string): void {
  // 切换工作区：进入新会话模式
  store.startSession(cwd);
  workspaceSwitcherOpen.value = false;
  appError.value = null;
}

function openSidebar(): void {
  // 展开侧栏：桌面端取消折叠，窄屏打开遮罩侧栏
  sidebarOpen.value = true;
  store.setSidebarCollapsed(false);
}

function collapseSidebar(): void {
  // 收起时同步关闭窄屏抽屉状态，避免 sidebarOpen 继续让侧栏保持可见。
  sidebarOpen.value = false;
  store.setSidebarCollapsed(true);
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
  // Agent 结束：刷新会话列表并（可选）播放完成音
  void refreshSessions();
  if (soundEnabled.value) playCompletionTone(0.08);
}

function playCompletionTone(volume: number): void {
  // 用 Web Audio 生成一个简单的提示音（声音关闭或不可用时静默忽略）
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

onBeforeUnmount(stopSessionRecovery);
</script>

<template>
  <AppShell
    v-model:sidebar-open="sidebarOpen"
    :sidebar-collapsed="sidebarCollapsed"
    :file-panel-open="filePanelOpen && !!selectedWorkspace"
  >
    <template #sidebar>
      <SessionSidebar
        :sessions="sessions"
        :loading="sessionsLoading"
        :selected-session-id="selectedSessionId"
        :new-session-active="newSessionCwd !== null"
        :agent-running="agentRunning"
        @new-session="startNewSession"
        @select-session="store.selectSession"
        @open-settings="settingsOpen = true"
        @collapse-sidebar="collapseSidebar"
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
      :sidebar-collapsed="sidebarCollapsed"
      @session-created="sessionCreated"
      @session-forked="sessionForked"
      @agent-end="handleAgentEnd"
      @open-sidebar="openSidebar"
      @toggle-files="store.toggleFilePanel"
      @switch-workspace="openWorkspaceSwitcher"
      @running-change="agentRunning = $event"
    />
  </AppShell>

  <SettingsDialog
    v-if="settingsOpen"
    :cwd="selectedWorkspace"
    :theme="theme"
    :sound-enabled="soundEnabled"
    @close="settingsOpen = false"
    @models-saved="modelsRevision += 1"
    @toggle-theme="store.toggleTheme"
    @toggle-sound="toggleSound"
  />
  <WorkspaceSwitcher
    v-if="workspaceSwitcherOpen"
    :current-cwd="selectedWorkspace"
    @close="workspaceSwitcherOpen = false"
    @selected="switchWorkspace"
  />
</template>
