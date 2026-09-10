<!-- 会话预设配置：列出内置/自定义预设，支持新增、编辑、删除。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import {
  createPreset,
  deletePreset,
  getModels,
  getMcpServers,
  getPresets,
  updatePreset,
} from '@/lib/api';
import type { ModelCatalog, PresetCompaction, SessionPreset, SessionPresetInput } from '@/types';

const props = withDefaults(defineProps<{ embedded?: boolean; cwd?: string | null }>(), {
  embedded: false,
  cwd: '',
});
const emit = defineEmits<{ close: [] }>();

// 压缩策略档位 → 具体 token 数值（与后端 SDK 的 CompactionSettings 语义一致）。
type CompactionStrategy = 'auto' | 'off' | 'aggressive' | 'conservative';
const COMPACTION_STRATEGIES: Record<CompactionStrategy, PresetCompaction> = {
  auto: { enabled: true, keepRecentTokens: 20000, reserveTokens: 16384 },
  off: { enabled: false, keepRecentTokens: 20000, reserveTokens: 16384 },
  aggressive: { enabled: true, keepRecentTokens: 8000, reserveTokens: 16384 },
  conservative: { enabled: true, keepRecentTokens: 40000, reserveTokens: 16384 },
};
const STRATEGY_LABELS: Record<CompactionStrategy, string> = {
  auto: '自动（保留 20000 tokens）',
  off: '关闭',
  aggressive: '激进（保留 8000 tokens）',
  conservative: '保守（保留 40000 tokens）',
};
const ALL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

// MCP 服务选择模式：all = 全部（后端默认）；none = 禁用；custom = 按名单勾选。
type McpMode = 'all' | 'none' | 'custom';

interface PresetDraft {
  id: string | null; // null = 新建
  name: string;
  systemPrompt: string;
  toolNames: string[];
  strategy: CompactionStrategy;
  provider: string; // '' = 默认模型
  modelId: string;
  thinkingLevel: string; // '' = 默认思考等级
  mcpMode: McpMode;
  mcpServers: string[]; // mode = custom 时生效
}

const presets = ref<SessionPreset[]>([]);
const catalog = ref<ModelCatalog | null>(null);
const mcpServerNames = ref<string[]>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const formOpen = ref(false);
const draft = ref<PresetDraft | null>(null);

onMounted(load);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [list, models] = await Promise.all([getPresets(), getModels()]);
    presets.value = list;
    catalog.value = models;
    // MCP 服务清单：优先取当前工作区的合并配置；无工作区（未打开会话）时
    // 后端回退为用户级配置列表，保证预设界面随时可选 MCP 白名单。
    const mcp = await getMcpServers(props.cwd || undefined);
    mcpServerNames.value = mcp.servers.map((server) => server.name);
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    loading.value = false;
  }
}

function strategyOf(preset: SessionPreset): CompactionStrategy {
  return (
    (Object.keys(COMPACTION_STRATEGIES) as CompactionStrategy[]).find((key) => {
      const value = COMPACTION_STRATEGIES[key];
      return (
        value.enabled === preset.compaction.enabled &&
        value.keepRecentTokens === preset.compaction.keepRecentTokens &&
        value.reserveTokens === preset.compaction.reserveTokens
      );
    }) ?? 'auto'
  );
}

function toDraft(preset: SessionPreset): PresetDraft {
  return {
    id: preset.id,
    name: preset.name,
    systemPrompt: preset.systemPrompt,
    toolNames: [...preset.toolNames],
    strategy: strategyOf(preset),
    provider: preset.provider ?? '',
    modelId: preset.modelId ?? '',
    thinkingLevel: preset.thinkingLevel ?? '',
    mcpMode: mcpModeOf(preset),
    mcpServers: preset.mcpServers ? [...preset.mcpServers] : [],
  };
}

/** 预设的 mcpServers → UI 模式：null/缺省 = all；[] = none；非空数组 = custom。 */
function mcpModeOf(preset: SessionPreset): McpMode {
  if (preset.mcpServers === null || preset.mcpServers === undefined) return 'all';
  return preset.mcpServers.length === 0 ? 'none' : 'custom';
}

function addPreset(): void {
  draft.value = {
    id: null,
    name: '',
    systemPrompt: '',
    toolNames: ['read', 'bash', 'edit', 'write'],
    strategy: 'auto',
    provider: '',
    modelId: '',
    thinkingLevel: '',
    mcpMode: 'all',
    mcpServers: [],
  };
  formOpen.value = true;
  error.value = null;
}

function editPreset(preset: SessionPreset): void {
  draft.value = toDraft(preset);
  formOpen.value = true;
  error.value = null;
}

function cancelForm(): void {
  formOpen.value = false;
  draft.value = null;
}

async function save(): Promise<void> {
  if (!draft.value) return;
  error.value = null;
  const name = draft.value.name.trim();
  if (!name) {
    error.value = '预设名称不能为空';
    return;
  }
  const input: SessionPresetInput = {
    name,
    systemPrompt: draft.value.systemPrompt,
    toolNames: draft.value.toolNames,
    compaction: COMPACTION_STRATEGIES[draft.value.strategy],
    provider: draft.value.provider,
    modelId: draft.value.modelId,
    thinkingLevel: draft.value.thinkingLevel,
    mcpServers:
      draft.value.mcpMode === 'all'
        ? null
        : draft.value.mcpMode === 'none'
          ? []
          : draft.value.mcpServers,
  };
  saving.value = true;
  try {
    if (draft.value.id) {
      await updatePreset(draft.value.id, input);
    } else {
      await createPreset(input);
    }
    cancelForm();
    await load();
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    saving.value = false;
  }
}

async function removePreset(preset: SessionPreset): Promise<void> {
  error.value = null;
  if (!window.confirm(`删除预设「${preset.name}」？`)) return;
  try {
    await deletePreset(preset.id);
    await load();
  } catch (cause) {
    error.value = messageOf(cause);
  }
}

const modelKey = computed(() =>
  draft.value && draft.value.provider && draft.value.modelId
    ? `${draft.value.provider}:${draft.value.modelId}`
    : '',
);

function onModelChange(event: Event): void {
  if (!draft.value) return;
  const value = (event.target as HTMLSelectElement).value;
  if (!value) {
    draft.value.provider = '';
    draft.value.modelId = '';
    return;
  }
  const item = catalog.value?.modelList.find((model) => `${model.provider}:${model.id}` === value);
  if (item) {
    draft.value.provider = item.provider;
    draft.value.modelId = item.id;
  }
}

const thinkingLevels = computed(() => {
  if (!draft.value) return [];
  if (draft.value.provider && draft.value.modelId) {
    return (
      catalog.value?.thinkingLevels[`${draft.value.provider}:${draft.value.modelId}`] ?? ['off']
    );
  }
  return ALL_THINKING_LEVELS;
});

function modelName(preset: SessionPreset): string {
  if (!preset.provider || !preset.modelId) return '默认模型';
  const item = catalog.value?.modelList.find(
    (model) => model.provider === preset.provider && model.id === preset.modelId,
  );
  return item ? `${item.name} · ${item.provider}` : `${preset.provider}/${preset.modelId}`;
}

/** 预设的 MCP 服务摘要（列表视图展示用）。 */
function mcpLabel(preset: SessionPreset): string {
  if (preset.mcpServers === null || preset.mcpServers === undefined) return '全部';
  if (preset.mcpServers.length === 0) return '禁用';
  return preset.mcpServers.join(', ');
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : '预设操作失败';
}
</script>

<template>
  <div
    :class="props.embedded ? 'settings-embedded-panel' : 'modal-backdrop'"
    @click.self="!props.embedded && emit('close')"
    @keydown.esc="!props.embedded && emit('close')"
  >
    <section
      class="config-dialog config-dialog--wide"
      :class="{ 'config-dialog--embedded': props.embedded }"
      :role="props.embedded ? undefined : 'dialog'"
      :aria-modal="props.embedded ? undefined : 'true'"
      aria-labelledby="presets-title"
    >
      <header v-if="!props.embedded" class="config-header">
        <div>
          <div class="welcome-kicker">SESSION PRESETS</div>
          <h2 id="presets-title">会话预设</h2>
          <p>新会话时可选择一套预设：系统提示词、工具、MCP 服务、压缩策略、默认模型与思考等级。</p>
        </div>
        <button type="button" aria-label="关闭预设配置" autofocus @click="emit('close')">×</button>
      </header>

      <div v-if="loading" class="config-state">正在读取预设…</div>

      <div v-else-if="formOpen && draft" class="config-body">
        <div class="config-presets">
          <button type="button" class="config-add" @click="cancelForm">← 返回列表</button>
        </div>
        <article class="provider-card preset-form">
          <div class="provider-grid">
            <label>名称<input v-model="draft.name" placeholder="如 代码审查" /></label>
            <label
              >压缩策略
              <select v-model="draft.strategy">
                <option v-for="(label, key) in STRATEGY_LABELS" :key="key" :value="key">
                  {{ label }}
                </option>
              </select>
            </label>
          </div>

          <label class="preset-line-field"
            >系统提示词（留空 = 使用 SDK 默认提示词）
            <textarea
              v-model="draft.systemPrompt"
              rows="5"
              placeholder="You are an expert coding assistant…"
              spellcheck="false"
            />
          </label>

          <div class="preset-field">
            <span class="preset-field-label"
              >可用工具<span class="preset-field-hint">默认勾选 = SDK 默认工具集</span></span
            >
            <div class="preset-chip-row">
              <label v-for="tool in BUILTIN_TOOLS" :key="tool" class="preset-chip">
                <input v-model="draft.toolNames" type="checkbox" :value="tool" />{{ tool }}
              </label>
            </div>
          </div>

          <div class="preset-field">
            <span class="preset-field-label"
              >MCP 服务<span class="preset-field-hint"
                >新建会话时向模型注入哪些 MCP server 的工具</span
              ></span
            >
            <div class="preset-chip-row">
              <label class="preset-chip">
                <input v-model="draft.mcpMode" type="radio" value="all" />全部
              </label>
              <label class="preset-chip">
                <input v-model="draft.mcpMode" type="radio" value="none" />禁用
              </label>
              <label class="preset-chip">
                <input v-model="draft.mcpMode" type="radio" value="custom" />自选
              </label>
            </div>
            <div v-if="draft.mcpMode === 'custom'" class="preset-chip-row preset-chip-row--nested">
              <span v-if="mcpServerNames.length === 0" class="preset-mcp-empty">
                当前未配置任何 MCP 服务（可在「MCP」页添加）
              </span>
              <label v-for="server in mcpServerNames" :key="server" class="preset-chip">
                <input v-model="draft.mcpServers" type="checkbox" :value="server" />{{ server }}
              </label>
            </div>
          </div>

          <div class="provider-grid">
            <label
              >默认模型
              <select :value="modelKey" @change="onModelChange">
                <option value="">默认（跟随目录设置）</option>
                <option
                  v-for="item in catalog?.modelList ?? []"
                  :key="`${item.provider}:${item.id}`"
                  :value="`${item.provider}:${item.id}`"
                >
                  {{ item.name }} · {{ item.provider }}
                </option>
              </select>
            </label>
            <label
              >默认思考等级
              <select v-model="draft.thinkingLevel">
                <option value="">默认（跟随设置）</option>
                <option v-for="level in thinkingLevels" :key="level" :value="level">
                  {{ level }}
                </option>
              </select>
            </label>
          </div>

          <p class="config-help">
            自定义系统提示词会替换 SDK 默认提示词（工具仍可用，但提示词里不会自动列出工具说明；
            项目级 AGENTS.md 等项目上下文仍会附加）。
          </p>
        </article>
      </div>

      <div v-else class="config-body">
        <div class="config-presets">
          <button type="button" class="config-add" @click="addPreset">＋ 新建预设</button>
        </div>
        <div v-if="presets.length === 0" class="config-empty">暂无预设，点击上方新建。</div>
        <article v-for="preset in presets" :key="preset.id" class="skill-card">
          <div>
            <div class="preset-title-row">
              <strong>{{ preset.name }}</strong>
              <span v-if="preset.builtin" class="preset-badge preset-badge--builtin">内置</span>
            </div>
            <p v-if="preset.systemPrompt" class="preset-preview" :title="preset.systemPrompt">
              提示词：{{ preset.systemPrompt }}
            </p>
            <div class="preset-meta">
              <span class="preset-meta-item">
                工具：{{ preset.toolNames.length ? preset.toolNames.join(', ') : '无' }}
              </span>
              <span class="preset-meta-item">压缩：{{ STRATEGY_LABELS[strategyOf(preset)] }}</span>
              <span class="preset-meta-item">模型：{{ modelName(preset) }}</span>
              <span class="preset-meta-item">思考：{{ preset.thinkingLevel || '默认' }}</span>
              <span class="preset-meta-item">MCP：{{ mcpLabel(preset) }}</span>
            </div>
          </div>
          <div v-if="!preset.builtin" class="preset-actions">
            <button type="button" @click="editPreset(preset)">编辑</button>
            <button type="button" class="danger-link" @click="removePreset(preset)">删除</button>
          </div>
        </article>
      </div>

      <div v-if="error" class="config-error" role="alert">{{ error }}</div>
      <footer class="config-footer">
        <button
          v-if="formOpen || !props.embedded"
          type="button"
          @click="formOpen ? cancelForm() : emit('close')"
        >
          {{ formOpen ? '返回列表' : '完成' }}
        </button>
        <button
          v-if="formOpen"
          type="button"
          class="primary-action"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? '保存中…' : '保存预设' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.preset-form {
  display: grid;
  gap: 16px;
}

.preset-line-field {
  display: grid;
  gap: 6px;
  color: var(--faint);
  font-size: 9px;
}

.preset-line-field input,
.preset-line-field textarea,
.provider-grid select {
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--text);
  background: var(--input-bg);
  font-size: 11px;
  font-family: inherit;
  transition: border-color 0.15s ease;
}

.preset-line-field input:focus-visible,
.preset-line-field textarea:focus-visible,
.provider-grid select:focus-visible {
  border-color: var(--line-strong);
}

.preset-line-field textarea {
  resize: vertical;
  line-height: 1.6;
}

.preset-field {
  display: grid;
  gap: 7px;
}

.preset-field-label {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  color: var(--faint);
  font-size: 9px;
}

.preset-field-hint {
  color: var(--faint);
  opacity: 0.75;
}

.preset-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.preset-chip-row--nested {
  margin-left: 2px;
  padding-left: 10px;
  border-left: 2px solid var(--line);
}

.preset-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  background: var(--input-bg);
  font-size: 11px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    color 0.15s ease;
}

.preset-chip:hover {
  border-color: var(--line-strong);
  color: var(--text);
}

.preset-chip:has(input:checked) {
  border-color: var(--accent);
  color: var(--text);
}

.preset-chip input {
  margin: 0;
  accent-color: var(--accent);
}

.preset-mcp-empty {
  color: var(--faint);
  font-size: 10px;
}

.preset-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preset-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  font-size: 9px;
}

.preset-badge--builtin {
  color: var(--accent);
  border-color: var(--accent-dim, var(--line-strong));
}

.preset-preview {
  margin: 6px 0 0;
  overflow: hidden;
  color: var(--faint);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preset-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.preset-meta-item {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 2px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--faint);
  font-size: 9px;
  white-space: nowrap;
}

.preset-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.preset-actions button {
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  background: transparent;
  font-size: 10px;
  cursor: pointer;
}

.preset-actions button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}
</style>
