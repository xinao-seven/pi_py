<!-- Agent 控制条：模型 / 推理档位 / 工具预设选择、压缩按钮、上下文占用条与重试指示。 -->
<script setup lang="ts">
import { computed } from "vue";

import type { ContextUsage, ModelCatalog, ModelRef, RetryInfo } from "@/types";

const props = defineProps<{
  catalog: ModelCatalog | null;
  model: ModelRef | null;
  thinkingLevel: string;
  activeTools: string[];
  compacting: boolean;
  running: boolean;
  retryInfo: RetryInfo | null;
  contextUsage: ContextUsage | null;
}>();

const emit = defineEmits<{
  modelChange: [model: ModelRef];
  thinkingChange: [level: string];
  toolsChange: [toolNames: string[]];
  compact: [];
}>();

const modelKey = computed(() =>
  props.model ? `${props.model.provider}:${props.model.modelId}` : "",
);
const availableThinkingLevels = computed(() =>
  // 当前模型支持的思考档位（来自模型目录）
  props.model
    ? props.catalog?.thinkingLevels[`${props.model.provider}:${props.model.modelId}`] ?? ["off"]
    : ["off"],
);
const toolPreset = computed(() => {
  // 由当前激活工具集合推导预设：空=none，全部=full，否则=default
  if (props.activeTools.length === 0) return "none";
  if (["read", "bash", "edit", "write", "grep", "find", "ls"].every((name) => props.activeTools.includes(name))) {
    return "full";
  }
  return "default";
});

function changeModel(event: Event): void {
  // 根据下拉值（provider:model）触发模型切换
  const value = (event.target as HTMLSelectElement).value;
  const model = props.catalog?.modelList.find(
    (item) => `${item.provider}:${item.id}` === value,
  );
  if (model) emit("modelChange", { provider: model.provider, modelId: model.id });
}

function changeTools(event: Event): void {
  // 按预设切换工具集合
  const preset = (event.target as HTMLSelectElement).value;
  if (preset === "none") emit("toolsChange", []);
  else if (preset === "full") {
    emit("toolsChange", ["read", "bash", "edit", "write", "grep", "find", "ls"]);
  } else {
    emit("toolsChange", ["read", "bash", "edit", "write"]);
  }
}
</script>

<template>
  <div class="agent-controls">
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
      type="button"
      :disabled="running || compacting"
      @click="emit('compact')"
    >
      {{ compacting ? "压缩中…" : "压缩上下文" }}
    </button>

    <div v-if="retryInfo" class="retry-indicator" role="status">
      重试 {{ retryInfo.attempt }}/{{ retryInfo.maxAttempts }}
    </div>
    <div v-else-if="contextUsage" class="context-meter" :title="`${contextUsage.tokens} tokens`">
      <span :style="{ width: `${Math.min(100, contextUsage.percent)}%` }" />
    </div>
  </div>
</template>
