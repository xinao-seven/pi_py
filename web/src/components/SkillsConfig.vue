<!-- Skills 配置弹窗：列出项目/用户级技能，切换模型可见性并显示加载诊断。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { getSkills, setSkillDisabled } from '@/lib/api';
import type { SkillDiagnostic, SkillInfo } from '@/types';

const props = withDefaults(defineProps<{ cwd: string; embedded?: boolean }>(), { embedded: false });
const emit = defineEmits<{ close: [] }>();

const skills = ref<SkillInfo[]>([]);
const diagnostics = ref<SkillDiagnostic[]>([]);
const loading = ref(true);
const pending = ref(new Set<string>());
const error = ref<string | null>(null);
const enabledCount = computed(
  () => skills.value.filter((skill) => !skill.disableModelInvocation).length,
);

onMounted(load);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const result = await getSkills(props.cwd);
    skills.value = result.skills;
    diagnostics.value = result.diagnostics;
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    loading.value = false;
  }
}

async function toggle(skill: SkillInfo): Promise<void> {
  // 切换技能的 disable-model-invocation（是否对模型隐藏）
  const next = !skill.disableModelInvocation;
  pending.value.add(skill.filePath);
  pending.value = new Set(pending.value);
  error.value = null;
  try {
    await setSkillDisabled(skill.filePath, next);
    skill.disableModelInvocation = next;
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    pending.value.delete(skill.filePath);
    pending.value = new Set(pending.value);
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Skills 操作失败';
}
</script>

<template>
  <div
    :class="props.embedded ? 'settings-embedded-panel' : 'modal-backdrop'"
    @click.self="!props.embedded && emit('close')"
    @keydown.esc="!props.embedded && emit('close')"
  >
    <section
      class="config-dialog"
      :class="{ 'config-dialog--embedded': props.embedded }"
      :role="props.embedded ? undefined : 'dialog'"
      :aria-modal="props.embedded ? undefined : 'true'"
      aria-labelledby="skills-title"
    >
      <header v-if="!props.embedded" class="config-header">
        <div>
          <div class="welcome-kicker">PROJECT + USER SKILLS</div>
          <h2 id="skills-title">Skills</h2>
          <p>{{ enabledCount }} / {{ skills.length }} 可由模型调用</p>
        </div>
        <button type="button" aria-label="关闭 Skills 配置" autofocus @click="emit('close')">
          ×
        </button>
      </header>
      <div v-if="loading" class="config-state">正在发现本地 Skills…</div>
      <div v-else class="config-body skills-list">
        <div v-if="skills.length === 0" class="config-empty">当前工作区没有发现 Skill</div>
        <article v-for="skill in skills" :key="skill.filePath" class="skill-card">
          <div>
            <div class="skill-title-row">
              <strong>{{ skill.name }}</strong>
              <span>{{ skill.sourceInfo.scope === 'project' ? '项目' : '用户' }}</span>
            </div>
            <p>{{ skill.description || '未提供描述' }}</p>
            <code :title="skill.filePath">{{ skill.filePath }}</code>
          </div>
          <button
            type="button"
            class="skill-toggle"
            :class="{ 'skill-toggle--on': !skill.disableModelInvocation }"
            :disabled="pending.has(skill.filePath)"
            :aria-pressed="!skill.disableModelInvocation"
            @click="toggle(skill)"
          >
            {{ skill.disableModelInvocation ? '已隐藏' : '已启用' }}
          </button>
        </article>
        <details v-if="diagnostics.length" class="skill-diagnostics">
          <summary>{{ diagnostics.length }} 条加载诊断</summary>
          <p v-for="diagnostic in diagnostics" :key="`${diagnostic.path}:${diagnostic.message}`">
            {{ diagnostic.type }} · {{ diagnostic.message }}
          </p>
        </details>
      </div>
      <div v-if="error" class="config-error" role="alert">{{ error }}</div>
      <footer class="config-footer">
        <button type="button" @click="load">刷新</button>
        <button v-if="!props.embedded" type="button" class="primary-action" @click="emit('close')">
          完成
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
/* 技能列表：卡片、开关与诊断信息；弹窗骨架在 globals.css 中共享 */
.skills-list {
  display: grid;
  gap: 10px;
}

.skill-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 0;
}

.skill-card > div {
  min-width: 0;
}

.skill-title-row {
  display: flex;
  align-items: center;
  gap: 7px;
}

.skill-title-row span {
  padding: 2px 5px;
  border-radius: 6px;
  color: var(--faint);
  background: var(--panel-soft);
  font-size: 8px;
}

.skill-card p {
  margin: 6px 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}

.skill-card code {
  display: block;
  overflow: hidden;
  color: var(--faint);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-toggle {
  flex: 0 0 auto;
  min-width: 60px;
  min-height: 30px;
  border: 1px solid var(--line);
  border-radius: 16px;
  color: var(--faint);
  background: transparent;
  font-size: 9px;
  cursor: pointer;
}

.skill-toggle--on {
  border-color: rgba(231, 255, 111, 0.34);
  color: var(--accent);
  background: rgba(231, 255, 111, 0.06);
}

:root[data-theme='light'] .skill-toggle--on {
  border-color: #8ca63a;
  color: #3d5700;
  background: #eff5d7;
}

.skill-diagnostics {
  color: var(--faint);
  font-size: 10px;
}
</style>
