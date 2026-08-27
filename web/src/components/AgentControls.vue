<!-- Agent 控制条：模型 / 推理档位 / 工具预设选择、压缩按钮、上下文占用条与重试指示。 -->
<script setup lang="ts">
import { computed } from 'vue';

import type { ContextUsage, ModelCatalog, ModelRef, RetryInfo, SessionPreset } from '@/types';

const props = defineProps<{
  catalog: ModelCatalog | null;
  model: ModelRef | null;
  thinkingLevel: string;
  activeTools: string[];
  presets: SessionPreset[];
  selectedPreset: string;
  isNew: boolean;
  compacting: boolean;
  running: boolean;
  retryInfo: RetryInfo | null;
  contextUsage: ContextUsage | null;
  planActive: boolean;
  planBusy: boolean;
}>();

const emit = defineEmits<{
  modelChange: [model: ModelRef];
  thinkingChange: [level: string];
  toolsChange: [toolNames: string[]];
  presetChange: [preset: SessionPreset];
  compact: [];
  togglePlan: [];
}>();

const modelKey = computed(() =>
  props.model ? `${props.model.provider}:${props.model.modelId}` : '',
);
const availableThinkingLevels = computed(() =>
  // 当前模型支持的思考档位（来自模型目录）
  props.model
    ? (props.catalog?.thinkingLevels[`${props.model.provider}:${props.model.modelId}`] ?? ['off'])
    : ['off'],
);
const toolPreset = computed(() => {
  // 由当前激活工具集合推导预设：空=none，全部=full，否则=default
  if (props.activeTools.length === 0) return 'none';
  if (
    ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'].every((name) =>
      props.activeTools.includes(name),
    )
  ) {
    return 'full';
  }
  return 'default';
});

function changeModel(event: Event): void {
  // 根据下拉值（provider:model）触发模型切换
  const value = (event.target as HTMLSelectElement).value;
  const model = props.catalog?.modelList.find((item) => `${item.provider}:${item.id}` === value);
  if (model) emit('modelChange', { provider: model.provider, modelId: model.id });
}

function changeTools(event: Event): void {
  // 按预设切换工具集合
  const preset = (event.target as HTMLSelectElement).value;
  if (preset === 'none') emit('toolsChange', []);
  else if (preset === 'full') {
    emit('toolsChange', ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
  } else {
    emit('toolsChange', ['read', 'bash', 'edit', 'write']);
  }
}

function changePreset(event: Event): void {
  // 切换会话预设：交由父级 applyPreset 预填模型/推理/工具并记住系统提示词与压缩策略
  const id = (event.target as HTMLSelectElement).value;
  const preset = props.presets.find((item) => item.id === id);
  if (preset) emit('presetChange', preset);
}
</script>

<template>
  <div class="agent-controls">
    <label v-if="isNew" class="control-field">
      <span>预设</span>
      <select :value="selectedPreset" :disabled="running" @change="changePreset">
        <option v-for="preset in presets" :key="preset.id" :value="preset.id">
          {{ preset.name }}{{ preset.builtin ? '（内置）' : '' }}
        </option>
      </select>
    </label>

    <label class="control-field">
      <span>模型</span>
      <select :value="modelKey" :disabled="running" @change="changeModel">
        <option
          v-for="item in catalog?.modelList ?? []"
          :key="`${item.provider}:${item.id}`"
          :value="`${item.provider}:${item.id}`"
        >
          {{ item.name }} · {{ item.provider }}
        </option>
      </select>
    </label>

    <label class="control-field">
      <span>推理</span>
      <select
        :value="thinkingLevel"
        :disabled="running"
        @change="emit('thinkingChange', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="level in availableThinkingLevels" :key="level" :value="level">
          {{ level }}
        </option>
      </select>
    </label>

    <label class="control-field">
      <span>工具</span>
      <select :value="toolPreset" :disabled="running" @change="changeTools">
        <option value="none">关闭</option>
        <option value="default">默认</option>
        <option value="full">完整</option>
      </select>
    </label>

    <button
      class="compact-button"
      :class="{ 'compact-button--active': planActive }"
      type="button"
      :disabled="running || planBusy"
      :aria-pressed="planActive"
      @click="emit('togglePlan')"
    >
      Plan
    </button>

    <button
      class="compact-button"
      type="button"
      :disabled="running || compacting"
      @click="emit('compact')"
    >
      {{ compacting ? '压缩中…' : '压缩上下文' }}
    </button>

    <div v-if="retryInfo" class="retry-indicator" role="status">
      重试 {{ retryInfo.attempt }}/{{ retryInfo.maxAttempts }}
    </div>
    <div v-else-if="contextUsage" class="context-meter" :title="`${contextUsage.tokens} tokens`">
      <span :style="{ width: `${Math.min(100, contextUsage.percent)}%` }" />
    </div>
  </div>
</template>
