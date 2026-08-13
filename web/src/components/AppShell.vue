<!-- 应用外壳：三栏布局（侧栏 / 主区 / 文件面板），窄屏时侧栏以遮罩方式打开。 -->
<script setup lang="ts">
defineProps<{
  sidebarOpen: boolean;
  sidebarCollapsed?: boolean;
  filePanelOpen?: boolean;
}>();

const emit = defineEmits<{
  "update:sidebarOpen": [value: boolean];
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
