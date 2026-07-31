import { defineStore } from "pinia";
import { ref } from "vue";

import type { FileTab } from "@/types";

export const useAppStore = defineStore("app", () => {
  const selectedSessionId = ref<string | null>(null);
  const newSessionCwd = ref<string | null>(null);
  const sidebarOpen = ref(false);
  const filePanelOpen = ref(false);
  const fileWorkspaceRoot = ref<string | null>(null);
  const fileTabs = ref<FileTab[]>([]);
  const activeFilePath = ref<string | null>(null);
  const modelsConfigOpen = ref(false);
  const skillsConfigOpen = ref(false);

  function selectSession(sessionId: string): void {
    selectedSessionId.value = sessionId;
    newSessionCwd.value = null;
    sidebarOpen.value = false;
  }

  function startSession(cwd: string): void {
    selectedSessionId.value = null;
    newSessionCwd.value = cwd;
    sidebarOpen.value = false;
  }

  function setFileWorkspace(root: string | null): void {
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
    const name = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
    if (!fileTabs.value.some((tab) => tab.path === path)) {
      fileTabs.value.push({ path, name });
    }
    activeFilePath.value = path;
    filePanelOpen.value = true;
  }

  function closeFile(path: string): void {
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
    selectSession,
    startSession,
    setFileWorkspace,
    toggleFilePanel,
    openFile,
    closeFile,
  };
});
