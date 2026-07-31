<script setup lang="ts">
defineProps<{
  sidebarOpen: boolean;
  filePanelOpen?: boolean;
}>();

const emit = defineEmits<{
  "update:sidebarOpen": [value: boolean];
}>();
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell--files': filePanelOpen }">
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
