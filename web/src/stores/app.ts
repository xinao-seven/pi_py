// 全局 UI 状态（Pinia）：当前会话、工作区、文件面板/标签、主题与声音偏好。
import { defineStore } from "pinia";
import { ref } from "vue";

import type { FileTab } from "@/types";

export const useAppStore = defineStore("app", () => {
  // 当前选中的历史会话；为 null 且 newSessionCwd 有值表示“新会话”模式
  const selectedSessionId = ref<string | null>(null);
  const newSessionCwd = ref<string | null>(null);
  const sidebarOpen = ref(false);
  const filePanelOpen = ref(false);
  const fileWorkspaceRoot = ref<string | null>(null);
  const fileTabs = ref<FileTab[]>([]);
  const activeFilePath = ref<string | null>(null);
  const modelsConfigOpen = ref(false);
  const skillsConfigOpen = ref(false);
  const theme = ref<"dark" | "light">("dark");
  const soundEnabled = ref(false);

  function initializePreferences(): void {
    // 启动时从 localStorage 恢复主题与声音偏好，并应用主题
    const savedTheme = window.localStorage.getItem("pi.theme");
    theme.value = savedTheme === "light" || savedTheme === "dark"
      ? savedTheme
      : window.matchMedia?.("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
    soundEnabled.value = window.localStorage.getItem("pi.sound") === "true";
    applyTheme();
  }

  function toggleTheme(): void {
    theme.value = theme.value === "dark" ? "light" : "dark";
    window.localStorage.setItem("pi.theme", theme.value);
    applyTheme();
  }

  function toggleSound(): void {
    soundEnabled.value = !soundEnabled.value;
    window.localStorage.setItem("pi.sound", String(soundEnabled.value));
  }

  function applyTheme(): void {
    // 把主题写到 <html data-theme>，CSS 变量据此切换深浅色
    document.documentElement.dataset.theme = theme.value;
  }

  function selectSession(sessionId: string): void {
    // 选中历史会话并关闭侧栏
    selectedSessionId.value = sessionId;
    newSessionCwd.value = null;
    sidebarOpen.value = false;
  }

  function startSession(cwd: string): void {
    // 进入新会话模式（等待第一条消息）
    selectedSessionId.value = null;
    newSessionCwd.value = cwd;
    sidebarOpen.value = false;
  }

  function setFileWorkspace(root: string | null): void {
    // 切换文件面板的工作区；换根目录时清空旧标签，避免跨根误读
    if (fileWorkspaceRoot.value === root) return;
    fileWorkspaceRoot.value = root;
    fileTabs.value = [];
    activeFilePath.value = null;
    if (!root) filePanelOpen.value = false;
  }

  function toggleFilePanel(root: string): void {
    setFileWorkspace(root);
    filePanelOpen.value = !filePanelOpen.value;
  }

  function openFile(path: string): void {
    // 打开文件：加入标签列表并设为活动文件
    const name = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
    if (!fileTabs.value.some((tab) => tab.path === path)) {
      fileTabs.value.push({ path, name });
    }
    activeFilePath.value = path;
    filePanelOpen.value = true;
  }

  function closeFile(path: string): void {
    // 关闭文件标签；若关闭的是活动文件则回退到相邻标签
    const index = fileTabs.value.findIndex((tab) => tab.path === path);
    if (index < 0) return;
    fileTabs.value.splice(index, 1);
    if (activeFilePath.value === path) {
      activeFilePath.value = fileTabs.value[index]?.path ?? fileTabs.value[index - 1]?.path ?? null;
    }
  }

  return {
    selectedSessionId,
    newSessionCwd,
    sidebarOpen,
    filePanelOpen,
    fileWorkspaceRoot,
    fileTabs,
    activeFilePath,
    modelsConfigOpen,
    skillsConfigOpen,
    theme,
    soundEnabled,
    selectSession,
    startSession,
    setFileWorkspace,
    toggleFilePanel,
    openFile,
    closeFile,
    initializePreferences,
    toggleTheme,
    toggleSound,
  };
});
