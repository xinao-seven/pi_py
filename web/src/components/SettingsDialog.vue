<!-- 统一设置弹窗：左侧切换配置分类，右侧承载常规、模型、Skills 与 MCP 面板。 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import McpConfig from '@/components/McpConfig.vue';
import ModelsConfig from '@/components/ModelsConfig.vue';
import SkillsConfig from '@/components/SkillsConfig.vue';

type SettingsSection = 'general' | 'models' | 'skills' | 'mcp';

const props = defineProps<{
  cwd: string | null;
  theme: 'dark' | 'light';
  soundEnabled: boolean;
}>();

const emit = defineEmits<{
  close: [];
  modelsSaved: [];
  toggleTheme: [];
  toggleSound: [];
}>();

const activeSection = ref<SettingsSection>('general');

function selectSection(section: SettingsSection): void {
  if ((section === 'skills' || section === 'mcp') && !props.cwd) return;
  activeSection.value = section;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="settings-backdrop">
    <button class="settings-scrim" type="button" aria-label="关闭设置" @click="emit('close')" />
    <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="settings-header">
        <h2 id="settings-title">设置</h2>
        <button type="button" aria-label="关闭设置" autofocus @click="emit('close')">×</button>
      </header>

      <div class="settings-layout">
        <nav class="settings-nav" aria-label="设置分类">
          <button
            type="button"
            :class="{ 'settings-nav-button--active': activeSection === 'general' }"
            @click="selectSection('general')"
          >
            <span aria-hidden="true">☷</span>常规
          </button>
          <button
            type="button"
            :class="{ 'settings-nav-button--active': activeSection === 'models' }"
            @click="selectSection('models')"
          >
            <span aria-hidden="true">◇</span>模型
          </button>
          <button
            type="button"
            :disabled="!cwd"
            :class="{ 'settings-nav-button--active': activeSection === 'skills' }"
            :title="cwd ? undefined : '请先选择工作区'"
            @click="selectSection('skills')"
          >
            <span aria-hidden="true">✦</span>Skills
          </button>
          <button
            type="button"
            :disabled="!cwd"
            :class="{ 'settings-nav-button--active': activeSection === 'mcp' }"
            :title="cwd ? undefined : '请先选择工作区'"
            @click="selectSection('mcp')"
          >
            <span aria-hidden="true">⌁</span>MCP
          </button>
        </nav>

        <div class="settings-content">
          <section v-if="activeSection === 'general'" class="settings-general">
            <header>
              <h3>常规</h3>
              <p>界面显示与完成提醒。</p>
            </header>
            <div class="settings-row">
              <div>
                <strong>界面主题</strong>
                <span>浅色主题采用纯白与中性灰；深色主题保持灰阶。</span>
              </div>
              <button type="button" @click="emit('toggleTheme')">
                {{ theme === 'light' ? '浅色' : '深色' }}
              </button>
            </div>
            <div class="settings-row">
              <div>
                <strong>完成提示音</strong>
                <span>Agent 完成回复时播放一段简短提示音。</span>
              </div>
              <button
                type="button"
                :class="{ 'settings-value-button--active': soundEnabled }"
                :aria-pressed="soundEnabled"
                @click="emit('toggleSound')"
              >
                {{ soundEnabled ? '已开启' : '已关闭' }}
              </button>
            </div>
            <div class="settings-row settings-row--static">
              <div>
                <strong>当前工作区</strong>
                <span>{{ cwd || '尚未选择工作区，Skills 与 MCP 暂不可用。' }}</span>
              </div>
            </div>
          </section>

          <ModelsConfig
            v-else-if="activeSection === 'models'"
            embedded
            @close="activeSection = 'general'"
            @saved="emit('modelsSaved')"
          />
          <SkillsConfig
            v-else-if="activeSection === 'skills' && cwd"
            :cwd="cwd"
            embedded
            @close="activeSection = 'general'"
          />
          <McpConfig
            v-else-if="activeSection === 'mcp' && cwd"
            :cwd="cwd"
            embedded
            @close="activeSection = 'general'"
          />
        </div>
      </div>

      <footer class="settings-footer">
        <button type="button" @click="emit('close')">完成</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.settings-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  padding: 24px;
  place-items: center;
}

.settings-scrim {
  position: absolute;
  inset: 0;
  border: 0;
  background: rgba(22, 22, 22, 0.38);
  cursor: default;
}

.settings-dialog {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(900px, 94vw);
  height: min(680px, 90vh);
  min-height: 460px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--panel);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.18);
}

.settings-header,
.settings-footer {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  min-height: 48px;
  padding: 0 16px;
  border-color: var(--line);
  background: var(--panel);
}

.settings-header {
  border-bottom: 1px solid var(--line);
}

.settings-header h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}

.settings-header button {
  width: 30px;
  height: 30px;
  margin-left: auto;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
}

.settings-header button:hover {
  border-color: var(--line);
  background: var(--panel-soft);
}

.settings-layout {
  display: grid;
  grid-template-columns: 170px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 9px;
  border-right: 1px solid var(--line);
  background: var(--panel-raised);
}

.settings-nav button {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 36px;
  padding: 0 10px;
  border: 0;
  border-radius: 5px;
  color: var(--muted);
  background: transparent;
  text-align: left;
  font-size: 12px;
  cursor: pointer;
}

.settings-nav button:hover:not(:disabled) {
  color: var(--text);
  background: var(--panel-soft);
}

.settings-nav button:disabled {
  opacity: 0.38;
  cursor: default;
}

.settings-nav .settings-nav-button--active {
  color: var(--text);
  background: var(--panel-soft);
  font-weight: 650;
}

.settings-content {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.settings-general {
  height: 100%;
  padding: 22px 24px;
  overflow-y: auto;
}

.settings-general > header {
  margin-bottom: 12px;
}

.settings-general h3 {
  margin: 0;
  font-size: 15px;
}

.settings-general p {
  margin: 5px 0 0;
  color: var(--faint);
  font-size: 11px;
}

.settings-row {
  display: flex;
  align-items: center;
  gap: 20px;
  min-height: 68px;
  border-bottom: 1px solid var(--line);
}

.settings-row > div {
  display: grid;
  gap: 5px;
  flex: 1;
  min-width: 0;
}

.settings-row strong {
  font-size: 12px;
}

.settings-row span {
  overflow-wrap: anywhere;
  color: var(--faint);
  font-size: 10px;
}

.settings-row > button,
.settings-footer button {
  min-height: 31px;
  padding: 0 11px;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  color: var(--muted);
  background: var(--panel);
  font-size: 11px;
  cursor: pointer;
}

.settings-row > button:hover,
.settings-footer button:hover,
.settings-value-button--active {
  color: var(--text) !important;
  background: var(--panel-soft) !important;
}

.settings-footer {
  justify-content: flex-end;
  border-top: 1px solid var(--line);
}

.settings-footer button {
  color: var(--accent-ink);
  background: var(--accent);
}

@media (max-width: 680px) {
  .settings-backdrop {
    padding: 0;
  }

  .settings-dialog {
    width: 100%;
    height: 100%;
    min-height: 0;
    border: 0;
    border-radius: 0;
  }

  .settings-layout {
    grid-template-columns: 108px minmax(0, 1fr);
  }

  .settings-nav button {
    padding: 0 8px;
  }

  .settings-general {
    padding: 18px 14px;
  }

  .settings-row {
    align-items: flex-start;
    padding: 12px 0;
  }
}
</style>
