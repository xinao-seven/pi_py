<!-- 可观测性面板：成本账本、延迟分位数、工具成功率与审批命中率（数据来自 /api/observability）。 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { getObservabilityRun, getObservabilitySummary, listObservabilityRuns } from '@/lib/api';
import type { ObservabilityRun, ObservabilityRunDetail, ObservabilitySummary } from '@/types';

const props = defineProps<{
  /** 当前工作区（cwd 过滤是可选项，默认跟随）。 */
  cwd: string | null;
}>();

type RangeKey = '24h' | '7d' | '30d' | 'all';

const RANGES: Array<{ key: RangeKey; label: string; hours: number | null }> = [
  { key: '24h', label: '近 24 小时', hours: 24 },
  { key: '7d', label: '近 7 天', hours: 24 * 7 },
  { key: '30d', label: '近 30 天', hours: 24 * 30 },
  { key: 'all', label: '全部', hours: null },
];

const range = ref<RangeKey>('7d');
const scopeToWorkspace = ref(false);
const summary = ref<ObservabilitySummary | null>(null);
const runs = ref<ObservabilityRun[]>([]);
const detail = ref<ObservabilityRunDetail | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

/** 时间窗起点（all 时不带 from）。 */
const from = computed<string | undefined>(() => {
  const hours = RANGES.find((item) => item.key === range.value)?.hours ?? null;
  return hours === null ? undefined : new Date(Date.now() - hours * 3_600_000).toISOString();
});

const cwdFilter = computed(() => (scopeToWorkspace.value && props.cwd ? props.cwd : undefined));

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const query = { from: from.value, cwd: cwdFilter.value };
    const [nextSummary, nextRuns] = await Promise.all([
      getObservabilitySummary(query),
      listObservabilityRuns({ ...query, limit: 20 }),
    ]);
    summary.value = nextSummary;
    runs.value = nextRuns.runs;
    // 选中的 run 可能已被清理或不在当前窗口内：直接收起详情。
    if (detail.value && !nextRuns.runs.some((run) => run.id === detail.value?.run.id)) {
      detail.value = null;
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法加载可观测性数据';
  } finally {
    loading.value = false;
  }
}

async function toggleRun(run: ObservabilityRun): Promise<void> {
  if (detail.value?.run.id === run.id) {
    detail.value = null;
    return;
  }
  try {
    detail.value = await getObservabilityRun(run.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法加载运行详情';
  }
}

watch([range, scopeToWorkspace], () => void load());
onMounted(() => void load());

/** 成本：小于 0.1 分时显示下限，避免一排 0.0000。 */
function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd.toFixed(usd < 0.1 ? 4 : 2)}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(rate > 0 && rate < 0.01 ? 2 : 1)}%`;
}

/** 步骤结果文案：策略拦截 / 失败 / 成功。 */
function stepResultLabel(step: { blockedBy: string | null; isError: boolean }): string {
  if (step.blockedBy) return `已拦截（${step.blockedBy}）`;
  return step.isError ? '失败' : 'ok';
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/** 每日用量柱状图的高度（相对当日最大值的百分比，最小 4% 保证可见）。 */
const dailyBars = computed(() => {
  const daily = summary.value?.daily ?? [];
  const max = Math.max(...daily.map((item) => item.costUsd), 0.000001);
  return daily.map((item) => ({
    ...item,
    height: `${Math.max(4, Math.round((item.costUsd / max) * 100))}%`,
  }));
});

const storeState = computed(() => summary.value?.store ?? null);
const totals = computed(() => summary.value?.totals ?? null);
</script>

<template>
  <div class="observability-panel">
    <header class="observability-header">
      <div>
        <h3>用量与可观测性</h3>
        <p>会话运行的成本、延迟与工具成功率（数据落本地 platform.db，不含对话正文）。</p>
      </div>
      <div class="observability-actions">
        <select v-model="range" aria-label="统计时间范围">
          <option v-for="item in RANGES" :key="item.key" :value="item.key">{{ item.label }}</option>
        </select>
        <label v-if="cwd" class="observability-toggle">
          <input v-model="scopeToWorkspace" type="checkbox" />
          仅当前工作区
        </label>
        <button type="button" :disabled="loading" @click="load">
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="observability-error" role="alert">{{ error }}</p>

    <p v-if="storeState?.mode === 'off'" class="observability-notice">
      未开启可观测性（设置 PI_NODE_TRACE=1 后重启后端即可采集）。
    </p>
    <p v-else-if="storeState?.degraded" class="observability-notice observability-notice--warn">
      trace 写入持续失败，已降级并为丢弃 {{ storeState.dropped }} 条记录；请检查数据库目录权限。
    </p>

    <section class="observability-kpis" aria-label="关键指标">
      <article class="kpi">
        <span class="kpi-label">运行次数</span>
        <strong>{{ totals?.runs ?? 0 }}</strong>
        <span class="kpi-hint">失败率 {{ formatRate(totals?.errorRate ?? 0) }}</span>
      </article>
      <article class="kpi">
        <span class="kpi-label">累计成本</span>
        <strong>{{ formatCost(totals?.costUsd ?? 0) }}</strong>
        <span class="kpi-hint">
          输入 {{ formatTokens(totals?.inputTokens ?? 0) }} / 输出
          {{ formatTokens(totals?.outputTokens ?? 0) }}
        </span>
      </article>
      <article class="kpi">
        <span class="kpi-label">运行耗时 p95</span>
        <strong>{{ formatDuration(totals?.p95DurationMs ?? null) }}</strong>
        <span class="kpi-hint">p50 {{ formatDuration(totals?.p50DurationMs ?? null) }}</span>
      </article>
      <article class="kpi">
        <span class="kpi-label">首 token p50</span>
        <strong>{{ formatDuration(totals?.p50TtftMs ?? null) }}</strong>
        <span class="kpi-hint">轮次 {{ totals?.turns ?? 0 }}</span>
      </article>
    </section>

    <section class="observability-section">
      <h4>模型</h4>
      <table v-if="summary?.byModel.length" class="observability-table">
        <thead>
          <tr>
            <th>模型</th>
            <th>运行</th>
            <th>tokens</th>
            <th>成本</th>
            <th>p95 耗时</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in summary.byModel" :key="`${row.provider}/${row.model}`">
            <td class="mono">{{ row.provider ?? '—' }}/{{ row.model ?? '—' }}</td>
            <td>{{ row.runs }}</td>
            <td>{{ formatTokens(row.tokens) }}</td>
            <td>{{ formatCost(row.costUsd) }}</td>
            <td>{{ formatDuration(row.p95DurationMs) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="observability-empty">该时间范围内还没有已结算的运行。</p>
    </section>

    <section class="observability-section">
      <h4>工具</h4>
      <table v-if="summary?.byTool.length" class="observability-table">
        <thead>
          <tr>
            <th>工具</th>
            <th>调用</th>
            <th>失败</th>
            <th>策略拦截</th>
            <th>失败率</th>
            <th>p50 / p95</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in summary.byTool" :key="row.toolName">
            <td class="mono">{{ row.toolName }}</td>
            <td>{{ row.calls }}</td>
            <td :class="{ 'cell-error': row.errors > 0 }">{{ row.errors }}</td>
            <td :class="{ 'cell-blocked': row.blocked > 0 }">{{ row.blocked }}</td>
            <td>{{ formatRate(row.errorRate) }}</td>
            <td>
              {{ formatDuration(row.p50DurationMs) }} / {{ formatDuration(row.p95DurationMs) }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="observability-empty">该时间范围内还没有工具调用。</p>
      <p class="observability-footnote">
        被策略拦下的调用（审批拒绝/超时、规划期只读）不计入失败率。
      </p>
    </section>

    <section class="observability-section">
      <h4>审批</h4>
      <table v-if="summary?.byApproval.length" class="observability-table">
        <thead>
          <tr>
            <th>规则</th>
            <th>风险</th>
            <th>放行</th>
            <th>拒绝</th>
            <th>超时</th>
            <th>p50 等待</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in summary.byApproval" :key="`${row.rule}/${row.risk}`">
            <td class="mono">{{ row.rule }}</td>
            <td>{{ row.risk }}</td>
            <td>{{ row.approved }}</td>
            <td :class="{ 'cell-blocked': row.denied > 0 }">{{ row.denied }}</td>
            <td :class="{ 'cell-blocked': row.timedOut > 0 }">{{ row.timedOut }}</td>
            <td>{{ formatDuration(row.p50WaitMs) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="observability-empty">该时间范围内没有需要人工确认的命令。</p>
    </section>

    <section v-if="dailyBars.length" class="observability-section">
      <h4>每日成本</h4>
      <div class="observability-bars">
        <div
          v-for="item in dailyBars"
          :key="item.date"
          class="observability-bar"
          :title="`${item.date}：${formatCost(item.costUsd)} / ${item.runs} 次`"
        >
          <span :style="{ height: item.height }" />
          <em>{{ item.date.slice(5) }}</em>
        </div>
      </div>
    </section>

    <section class="observability-section">
      <h4>最近运行</h4>
      <ul v-if="runs.length" class="observability-runs">
        <li v-for="run in runs" :key="run.id">
          <button type="button" class="run-row" @click="toggleRun(run)">
            <span class="run-status" :class="`run-status--${run.status}`">{{ run.status }}</span>
            <span class="run-model mono">{{ run.model ?? '—' }}</span>
            <span class="run-time">{{ formatTime(run.startedAt) }}</span>
            <span class="run-duration">{{ formatDuration(run.durationMs) }}</span>
            <span class="run-cost">{{ formatCost(run.costUsd) }}</span>
          </button>

          <div v-if="detail?.run.id === run.id" class="run-detail">
            <p v-if="run.errorMessage" class="run-error">{{ run.errorMessage }}</p>
            <table class="observability-table observability-table--steps">
              <thead>
                <tr>
                  <th>步骤</th>
                  <th>名称</th>
                  <th>耗时</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(step, index) in detail.steps" :key="index">
                  <td class="mono">{{ step.kind }}</td>
                  <td class="mono">{{ step.toolName ?? '—' }}</td>
                  <td>{{ formatDuration(step.durationMs) }}</td>
                  <td>
                    <span v-if="step.blockedBy" class="step-blocked">
                      {{ stepResultLabel(step) }}
                    </span>
                    <span v-else-if="step.isError" class="cell-error">失败</span>
                    <span v-else class="step-ok">ok</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </li>
      </ul>
      <p v-else class="observability-empty">该时间范围内还没有运行记录。</p>
    </section>
  </div>
</template>

<style scoped>
/* 可观测性面板：KPI 卡片 + 分组表格 + 每日成本柱状图 + 运行列表 */
.observability-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 0;
  padding: 4px 2px 24px;
  overflow-y: auto;
}

.observability-header {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  justify-content: space-between;
}

.observability-header h3 {
  margin: 0 0 4px;
  font-size: 13px;
}

.observability-header p {
  margin: 0;
  color: var(--faint);
  font-size: 10px;
  line-height: 1.6;
}

.observability-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
  align-items: center;
}

.observability-actions select,
.observability-actions button {
  padding: 5px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text);
  background: var(--input-bg);
  font-size: 10px;
  cursor: pointer;
}

.observability-actions button:disabled {
  opacity: 0.6;
  cursor: default;
}

.observability-toggle {
  display: flex;
  gap: 5px;
  align-items: center;
  color: var(--muted);
  font-size: 10px;
}

.observability-error {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid rgba(255, 129, 120, 0.25);
  border-radius: 8px;
  color: var(--danger);
  font-size: 10px;
}

.observability-notice {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--muted);
  background: var(--panel-soft);
  font-size: 10px;
}

.observability-notice--warn {
  border-color: rgba(255, 129, 120, 0.25);
  color: var(--danger);
}

.observability-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}

.kpi {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 11px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-raised);
}

.kpi-label {
  color: var(--faint);
  font-size: 9px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.kpi strong {
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 17px;
}

.kpi-hint {
  color: var(--muted);
  font-size: 9px;
}

.observability-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.observability-section h4 {
  margin: 0;
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.observability-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
}

.observability-table th {
  padding: 5px 8px;
  border-bottom: 1px solid var(--line-strong);
  color: var(--faint);
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
}

.observability-table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--line);
  color: var(--text);
}

.observability-table--steps {
  font-size: 9px;
}

.mono {
  font-family: 'Cascadia Code', Consolas, monospace;
}

.cell-error {
  color: var(--danger);
}

.cell-blocked {
  color: #d8b25f;
}

.step-ok {
  color: var(--muted);
}

.step-blocked {
  color: #d8b25f;
}

.observability-empty,
.observability-footnote {
  margin: 0;
  color: var(--faint);
  font-size: 10px;
}

.observability-bars {
  display: flex;
  gap: 6px;
  align-items: flex-end;
  height: 84px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-raised);
}

.observability-bar {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
  min-width: 12px;
}

.observability-bar span {
  width: 100%;
  border-radius: 3px 3px 0 0;
  background: var(--accent);
  opacity: 0.75;
}

.observability-bar em {
  color: var(--faint);
  font-size: 8px;
  font-style: normal;
}

.observability-runs {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.run-row {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr) 96px 62px 62px;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--text);
  background: var(--panel-raised);
  font-size: 10px;
  text-align: left;
  cursor: pointer;
}

.run-row:hover {
  border-color: var(--line-strong);
}

.run-status {
  color: var(--muted);
}

.run-status--completed {
  color: var(--accent);
}

.run-status--error {
  color: var(--danger);
}

.run-status--running {
  color: #d8b25f;
}

.run-model,
.run-time,
.run-duration,
.run-cost {
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 4px 0 8px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--input-bg);
}

.run-error {
  margin: 0;
  color: var(--danger);
  font-size: 10px;
}
</style>
