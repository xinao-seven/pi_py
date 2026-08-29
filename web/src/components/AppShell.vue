<!-- 应用外壳：三栏布局（侧栏 / 主区 / 文件面板），窄屏时侧栏以遮罩方式打开。 -->
<script setup lang="ts">
defineProps<{
  sidebarOpen: boolean;
  sidebarCollapsed?: boolean;
  filePanelOpen?: boolean;
}>();

const emit = defineEmits<{
  'update:sidebarOpen': [value: boolean];
}>();
</script>

<template>
  <div
    class="app-shell"
    :class="{
      'app-shell--files': filePanelOpen,
      'app-shell--sidebar-collapsed': sidebarCollapsed,
    }"
  >
    <button
      v-if="sidebarOpen"
      class="sidebar-scrim"
      type="button"
      aria-label="关闭会话侧栏"
      @click="emit('update:sidebarOpen', false)"
    />
    <aside class="sidebar" :class="{ 'sidebar--open': sidebarOpen }">
      <slot name="sidebar" />
    </aside>
    <main class="main-panel" :class="{ 'main-panel--with-files': filePanelOpen }">
      <slot />
    </main>
    <aside v-if="filePanelOpen" class="file-panel-shell">
      <slot name="files" />
    </aside>
  </div>
</template>

<style scoped>
/* 三栏布局骨架：侧栏 / 主区 / 文件面板，含折叠态、亮色覆盖与移动端浮层 */
.app-shell {
  display: grid;
  grid-template-areas: 'sidebar main';
  grid-template-columns: 248px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--panel);
  transition: grid-template-columns 200ms ease;
}

.app-shell--files {
  grid-template-areas: 'sidebar main files';
  grid-template-columns: 248px minmax(360px, 1fr) clamp(360px, 38vw, 620px);
}

.app-shell--sidebar-collapsed {
  grid-template-columns: 0 minmax(0, 1fr);
}

.app-shell--files.app-shell--sidebar-collapsed {
  grid-template-areas: 'sidebar main files';
  grid-template-columns: 0 minmax(360px, 1fr) clamp(360px, 38vw, 620px);
}

.app-shell--sidebar-collapsed .sidebar {
  border-right: 0;
}

:root[data-theme='light'] .app-shell {
  background: var(--panel);
}

.sidebar {
  grid-area: sidebar;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--line);
  background: var(--panel-raised);
  backdrop-filter: none;
  z-index: 30;
}

:root[data-theme='light'] .sidebar {
  box-shadow: 8px 0 28px rgba(40, 55, 25, 0.04);
}

.main-panel {
  grid-area: main;
  position: relative;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.file-panel-shell {
  grid-area: files;
  min-width: 0;
  min-height: 0;
  border-left: 1px solid var(--line);
  background: #0f1116;
}

:root[data-theme='light'] .file-panel-shell {
  background: #ffffff;
}

.sidebar-scrim {
  display: none;
}

@media (max-width: 1200px) {
  .file-panel-shell {
    position: fixed;
    inset: 0 0 0 auto;
    z-index: 35;
    width: min(650px, calc(100vw - 70px));
    box-shadow: -18px 0 55px rgba(0, 0, 0, 0.42);
  }

  :root[data-theme='light'] .file-panel-shell {
    box-shadow: -18px 0 55px rgba(39, 54, 23, 0.16);
  }
}

@media (max-width: 760px) {
  .app-shell {
    display: block;
  }

  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    width: min(86vw, 310px);
    transform: translateX(-102%);
    transition: transform 190ms ease;
  }

  .sidebar--open {
    transform: translateX(0);
  }

  .sidebar-scrim {
    position: fixed;
    inset: 0;
    z-index: 25;
    display: block;
    border: 0;
    background: rgba(0, 0, 0, 0.58);
    backdrop-filter: blur(2px);
  }

  .file-panel-shell {
    position: fixed;
    inset: 0 0 0 auto;
    z-index: 45;
    width: min(92vw, 520px);
    height: 100%;
    border-left: 1px solid var(--line);
    background: var(--panel);
  }
}
</style>
