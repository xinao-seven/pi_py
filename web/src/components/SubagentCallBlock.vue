<!-- 子任务工具卡片（M5）：把 subagent 的 details 渲染成一张可读的委派摘要。 -->
<script setup lang="ts">
import { computed } from 'vue';

import type { SubagentToolDetails } from '@/types';

const props = defineProps<{
  details: SubagentToolDetails;
  resultText: string;
  streaming?: boolean;
}>();

/** 状态文案：让人一眼看出「子任务跑完了没有、为什么没跑完」。 */
const STATUS_LABEL: Record<SubagentToolDetails['status'], string> = {
  completed: '完成',
  failed: '失败',
  aborted: '已取消',
  budget_exceeded: '超预算中止',
  timeout: '超时中止',
  unavailable: '不可用',
};

const statusLabel = computed(() => STATUS_LABEL[props.details.status] ?? props.details.status);
const failed = computed(
  () => props.details.status !== 'completed' && props.details.status !== 'aborted',
);

/** 用量一行（与 CLI 的紧凑风格一致）：模型 · 轮数 · tokens · 耗时 · 成本。 */
const usageLine = computed(() => {
  const { usage, durationMs } = props.details;
  const parts: string[] = [];
  if (props.details.model)
    parts.push(`${props.details.model.provider}/${props.details.model.modelId}`);
  parts.push(`${usage.turns} 轮`);
  parts.push(`↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)}`);
  parts.push(formatDuration(durationMs));
  if (usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`);
  return parts.join(' · ');
});

/** 轨迹：按工具名归并计数（bash×2, read×1）。 */
const trajectory = computed(() => {
  const counts = new Map<string, { count: number; failed: number }>();
  for (const item of props.details.trajectory) {
    const entry = counts.get(item.tool) ?? { count: 0, failed: 0 };
    entry.count += 1;
    if (!item.ok) entry.failed += 1;
    counts.set(item.tool, entry);
  }
  return [...counts.entries()].map(([tool, entry]) => ({
    tool,
    label:
      entry.failed > 0
        ? `${tool}×${entry.count}（${entry.failed} 失败）`
        : `${tool}×${entry.count}`,
  }));
});

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1)}k`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}
</script>

<template>
  <details class="subagent" :class="{ 'subagent--failed': failed }" open>
    <summary>
      <span class="subagent-glyph" aria-hidden="true">⇢</span>
      <span class="subagent-preset">{{ details.preset }}</span>
      <span class="subagent-depth">子任务 · 深度 {{ details.depth }}</span>
      <span class="subagent-status">{{ streaming && !details ? '运行中' : statusLabel }}</span>
    </summary>
    <div class="subagent-body">
      <div class="subagent-line">{{ usageLine }}</div>
      <!-- 模型回退等说明必须显示：否则「预设没生效」这种情况用户完全看不出来 -->
      <div v-if="details.note" class="subagent-note">⚠ {{ details.note }}</div>
      <div v-if="details.reason" class="subagent-reason">原因：{{ details.reason }}</div>
      <div v-if="trajectory.length" class="subagent-trajectory">
        轨迹：{{ trajectory.map((item) => item.label).join(', ') }}
      </div>
      <pre class="subagent-summary">{{ resultText }}</pre>
      <div v-if="details.subagentSessionId" class="subagent-meta">
        子会话 {{ details.subagentSessionId.slice(0, 8) }}
      </div>
    </div>
  </details>
</template>

<style scoped>
/* 子任务卡片：与工具块同族，但突出「这是一次委派」 */
.subagent {
  margin: 0 0 13px;
  border-left: 3px solid #4f8ff7;
  background: transparent;
}

.subagent--failed {
  border-left-color: #d05252;
}

.subagent summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0 5px 12px;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
  list-style: none;
}

.subagent summary::-webkit-details-marker {
  display: none;
}

.subagent-glyph {
  color: #4f8ff7;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-weight: 700;
}

.subagent-preset {
  color: var(--text);
  font-family: 'Cascadia Code', Consolas, monospace;
}

.subagent-depth,
.subagent-status {
  color: var(--faint);
  font-size: 10px;
}

.subagent-status {
  margin-left: auto;
}

.subagent-body {
  padding: 4px 0 10px 12px;
}

.subagent-line {
  color: var(--faint);
  font-size: 10px;
}

.subagent-note {
  margin-top: 4px;
  color: var(--accent);
  font-size: 10px;
}

.subagent-reason {
  margin-top: 4px;
  color: var(--danger);
  font-size: 10px;
}

.subagent-trajectory,
.subagent-meta {
  margin-top: 4px;
  color: var(--faint);
  font-size: 10px;
}

.subagent-summary {
  max-height: 320px;
  overflow-x: auto;
  margin: 6px 0 0;
  padding: 10px 11px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: #aeb4be;
  background: #0d0f13;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
  scrollbar-width: thin;
}

:root[data-theme='light'] .subagent-summary {
  color: #213025;
  background: #f3f5ee;
}
</style>
