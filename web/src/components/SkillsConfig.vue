<!-- Skills 配置弹窗：列出项目/用户级技能，切换模型可见性并显示加载诊断。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { getSkills, setSkillDisabled } from '@/lib/api';
import type { SkillDiagnostic, SkillInfo } from '@/types';

const props = defineProps<{ cwd: string }>();
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
  <div class="modal-backdrop" @click.self="emit('close')" @keydown.esc="emit('close')">
    <section class="config-dialog" role="dialog" aria-modal="true" aria-labelledby="skills-title">
      <header class="config-header">
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
        <button type="button" class="primary-action" @click="emit('close')">完成</button>
      </footer>
    </section>
  </div>
</template>
