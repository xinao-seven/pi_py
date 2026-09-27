<!--
  会话信息面板：查看当前会话「发给模型的东西」。
  中文说明：入口按钮放在聊天头部（「切换项目」左侧），面板是居中弹窗——因为内容里有一段
  完整的系统提示词和多份清单，400px 的浮层读不下。数据是**点开才读**的当前状态
  （后端不缓存、不落库），所以「改了工具集/开关过计划」之后点刷新即可看到最新。
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { ApiError, getSessionPrompt } from '@/lib/api';
import type { PromptToolInfo, PromptToolSource, SessionPromptSnapshot } from '@/types';

const props = defineProps<{
  /** 当前会话；为空（还没创建会话）时按钮禁用。 */
  sessionId: string | null;
}>();

const open = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const snapshot = ref<SessionPromptSnapshot | null>(null);
const copied = ref(false);
let copiedTimer: number | undefined;

const disabled = computed(() => !props.sessionId);

async function load(): Promise<void> {
  const sessionId = props.sessionId;
  if (!sessionId) return;
  loading.value = true;
  error.value = null;
  try {
    snapshot.value = (await getSessionPrompt(sessionId)).snapshot;
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : '无法读取会话信息';
  } finally {
    loading.value = false;
  }
}

function toggle(): void {
  open.value = !open.value;
  // 第一次打开才请求（之后靠「刷新」按钮显式重读）。
  if (open.value && snapshot.value === null) void load();
}

function close(): void {
  open.value = false;
  copied.value = false;
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) close();
}

onMounted(() => document.addEventListener('keydown', onDocumentKeydown));
onUnmounted(() => {
  document.removeEventListener('keydown', onDocumentKeydown);
  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
});

// 切到另一个会话：清掉上一个会话的快照（面板开着就直接重读）。
watch(
  () => props.sessionId,
  () => {
    snapshot.value = null;
    error.value = null;
    copied.value = false;
    if (open.value) void load();
  },
);

async function copySystemPrompt(): Promise<void> {
  const text = snapshot.value?.systemPrompt.text ?? '';
  if (text === '') return;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => (copied.value = false), 1_500);
  } catch {
    // 剪贴板可能被浏览器策略拒绝（非 https / 无权限）：明确告诉用户，不假装成功。
    error.value = '复制失败：浏览器拒绝了剪贴板访问';
  }
}

/** 工具分组（顺序固定：内置 → 内联扩展 → MCP → 文件扩展 → 包 → 其他）。 */
const TOOL_GROUPS: ReadonlyArray<{ key: PromptToolSource; label: string; hint: string }> = [
  { key: 'builtin', label: '内置工具', hint: 'SDK 自带（read / bash / edit / write …）' },
  {
    key: 'inline',
    label: '内联扩展',
    hint: '本服务通过扩展注册的工具（计划 / 提问 / 子任务 / MCP …）',
  },
  { key: 'mcp', label: 'MCP 工具', hint: 'MCP server 提供的工具（按 server 分组）' },
  { key: 'extension', label: '文件扩展', hint: '用户级或工作区的扩展' },
  { key: 'package', label: '包', hint: 'pi 包提供的扩展' },
  { key: 'sdk', label: 'SDK 注入', hint: '通过 createAgentSession 直接注入的工具' },
  { key: 'other', label: '其他', hint: '来源未知或为空的工具' },
];

const toolGroups = computed(() =>
  TOOL_GROUPS.map((group) => ({
    ...group,
    tools: (snapshot.value?.tools ?? []).filter((tool) => tool.source === group.key),
  })).filter((group) => group.tools.length > 0),
);

/** MCP 工具再按 server 分一层（面板上「哪个 server 贡献了哪些工具」看得最清楚）。 */
const mcpServers = computed(() => {
  const groups = new Map<string, PromptToolInfo[]>();
  for (const tool of (snapshot.value?.tools ?? []).filter((item) => item.source === 'mcp')) {
    const server = tool.mcp?.server ?? '未知 server';
    groups.set(server, [...(groups.get(server) ?? []), tool]);
  }
  return [...groups.entries()].map(([server, tools]) => ({ server, tools }));
});

const modelLabel = computed(() => {
  const model = snapshot.value?.model;
  if (!model) return '模型未知';
  return [model.provider, model.modelId].filter(Boolean).join('/') || '模型未知';
});

function formatChars(chars: number): string {
  if (chars < 1_000) return `${chars} 字`;
  return `${(chars / 1_000).toFixed(1)}k 字`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

/** 参数名：必填加 `*`，一眼看出哪些参数不能省。 */
function paramsLabel(tool: PromptToolInfo): string {
  if (tool.params.length === 0) return '无参数';
  return tool.params.map((param) => `${param.name}${param.required ? '*' : ''}`).join(', ');
}

function toolMetaLabel(tool: PromptToolInfo): string {
  if (tool.source === 'mcp' && tool.mcp) return `${tool.mcp.server} · ${tool.mcp.tool}`;
  return tool.sourcePath ?? '';
}
</script>

<template>
  <button
    class="session-info-button"
    type="button"
    :disabled="disabled"
    aria-haspopup="dialog"
    :aria-expanded="open"
    title="查看这个会话发给模型的内容（系统提示词 / 工具 / skills / MCP）"
    @click="toggle"
  >
    <span aria-hidden="true">ⓘ</span>
    <span>会话信息</span>
  </button>

  <div v-if="open" class="modal-backdrop" role="presentation" @click.self="close">
    <section
      class="config-dialog session-info-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-info-title"
    >
      <header class="config-header">
        <div>
          <div class="welcome-kicker">WHAT THE MODEL SEES</div>
          <h2 id="session-info-title">会话信息</h2>
          <p v-if="snapshot">
            读取于 {{ formatTime(snapshot.capturedAt) }} · {{ modelLabel }} ·
            {{ snapshot.thinkingLevel ?? '思考级别未知' }} · {{ snapshot.cwd }}
          </p>
          <p v-else>查看这个会话当前会发给模型的内容。</p>
        </div>
        <div class="session-info-actions">
          <button type="button" :disabled="loading || disabled" @click="load">
            {{ loading ? '读取中…' : '刷新' }}
          </button>
          <button type="button" aria-label="关闭会话信息" @click="close">×</button>
        </div>
      </header>

      <p v-if="error" class="session-info-error" role="alert">{{ error }}</p>
      <div v-if="loading && !snapshot" class="config-state">正在读取会话信息…</div>

      <div v-else-if="snapshot" class="config-body session-info-body">
        <ul class="session-info-chips">
          <li>
            <span>系统提示词</span
            ><strong>{{ formatChars(snapshot.overview.systemPromptChars) }}</strong>
          </li>
          <li>
            <span>工具</span>
            <strong
              >{{ snapshot.overview.toolsActive }}/{{ snapshot.overview.toolsRegistered }}</strong
            >
          </li>
          <li>
            <span>MCP</span><strong>{{ snapshot.overview.mcpTools }}</strong>
          </li>
          <li>
            <span>skills</span><strong>{{ snapshot.overview.skills }}</strong>
          </li>
          <li>
            <span>提示词模板</span><strong>{{ snapshot.overview.promptTemplates }}</strong>
          </li>
          <li>
            <span>上下文文件</span><strong>{{ snapshot.overview.contextFiles }}</strong>
          </li>
        </ul>

        <p class="session-info-hint">
          工具计数是「已激活 /
          已注册」：未激活的工具这一次不会发给模型。改过工具集或开关过计划后点「刷新」。
        </p>

        <p v-if="snapshot.diagnostics.length" class="session-info-error" role="alert">
          资源诊断：{{ snapshot.diagnostics.join('；') }}
        </p>

        <details class="session-info-section">
          <summary>
            系统提示词（{{ formatChars(snapshot.overview.systemPromptChars) }}）
            <span v-if="snapshot.systemPrompt.source" class="session-info-source">
              {{ snapshot.systemPrompt.source }}
            </span>
          </summary>
          <div class="session-info-section-actions">
            <button
              type="button"
              :disabled="snapshot.systemPrompt.text === ''"
              @click="copySystemPrompt"
            >
              {{ copied ? '已复制' : '复制全文' }}
            </button>
            <span v-if="snapshot.systemPrompt.appendedPrompts > 0">
              另有 {{ snapshot.systemPrompt.appendedPrompts }} 段追加提示词（已并入下文）
            </span>
            <span v-if="snapshot.overview.systemPromptTruncated" class="session-info-truncated">
              内容过大，展示已截断
            </span>
          </div>
          <pre class="session-info-pre">{{ snapshot.systemPrompt.text || '（空）' }}</pre>
        </details>

        <details class="session-info-section" open>
          <summary>工具（{{ snapshot.overview.toolsRegistered }}）</summary>
          <div v-for="group in toolGroups" :key="group.key" class="session-info-group">
            <h4>
              {{ group.label }}
              <span>{{ group.tools.length }}</span>
              <em>{{ group.hint }}</em>
            </h4>
            <ul class="session-info-list">
              <li v-for="tool in group.tools" :key="tool.name">
                <div class="session-info-row">
                  <code>{{ tool.name }}</code>
                  <span :class="tool.active ? 'session-info-on' : 'session-info-off'">
                    {{ tool.active ? '已激活' : '未激活' }}
                  </span>
                  <span v-if="toolMetaLabel(tool)" class="session-info-source">{{
                    toolMetaLabel(tool)
                  }}</span>
                </div>
                <p v-if="tool.description" class="session-info-desc">{{ tool.description }}</p>
                <p class="session-info-desc">
                  参数：<code>{{ paramsLabel(tool) }}</code>
                </p>
                <p v-if="tool.promptGuidelines.length" class="session-info-desc">
                  提示词指南：{{ tool.promptGuidelines.join(' / ') }}
                </p>
              </li>
            </ul>
          </div>
          <p v-if="toolGroups.length === 0" class="config-empty">这个会话没有注册任何工具。</p>
        </details>

        <details class="session-info-section">
          <summary>MCP 工具（{{ mcpServers.length }} 个 server）</summary>
          <div v-for="group in mcpServers" :key="group.server" class="session-info-group">
            <h4>
              {{ group.server }}
              <span>{{ group.tools.length }}</span>
            </h4>
            <ul class="session-info-list">
              <li v-for="tool in group.tools" :key="tool.name">
                <div class="session-info-row">
                  <code>{{ tool.mcp?.tool ?? tool.name }}</code>
                  <span :class="tool.active ? 'session-info-on' : 'session-info-off'">
                    {{ tool.active ? '已激活' : '未激活' }}
                  </span>
                  <span class="session-info-source">{{ tool.name }}</span>
                </div>
                <p v-if="tool.description" class="session-info-desc">{{ tool.description }}</p>
              </li>
            </ul>
          </div>
          <p v-if="mcpServers.length === 0" class="config-empty">这个会话没有 MCP 工具。</p>
        </details>

        <details class="session-info-section">
          <summary>Skills（{{ snapshot.skills.length }}）</summary>
          <ul class="session-info-list">
            <li v-for="skill in snapshot.skills" :key="skill.name">
              <div class="session-info-row">
                <code>{{ skill.name }}</code>
                <span v-if="skill.disableModelInvocation" class="session-info-off"
                  >不注入提示词</span
                >
              </div>
              <p v-if="skill.description" class="session-info-desc">{{ skill.description }}</p>
              <p class="session-info-desc">{{ skill.location }}</p>
            </li>
          </ul>
          <p v-if="snapshot.skills.length === 0" class="config-empty">没有发现 skill。</p>
        </details>

        <details class="session-info-section">
          <summary>提示词模板（{{ snapshot.promptTemplates.length }}）</summary>
          <ul class="session-info-list">
            <li v-for="template in snapshot.promptTemplates" :key="template.name">
              <div class="session-info-row">
                <code>{{ template.name }}</code>
                <span v-if="template.argumentHint" class="session-info-source">
                  {{ template.argumentHint }}
                </span>
              </div>
              <p v-if="template.description" class="session-info-desc">
                {{ template.description }}
              </p>
              <p v-if="template.path" class="session-info-desc">{{ template.path }}</p>
            </li>
          </ul>
          <p v-if="snapshot.promptTemplates.length === 0" class="config-empty">没有提示词模板。</p>
        </details>

        <details class="session-info-section">
          <summary>上下文文件（{{ snapshot.contextFiles.length }}）</summary>
          <ul class="session-info-list">
            <li v-for="file in snapshot.contextFiles" :key="file.path">
              <div class="session-info-row">
                <code>{{ file.path }}</code>
                <span class="session-info-source">{{ formatChars(file.chars) }}</span>
              </div>
            </li>
          </ul>
          <p v-if="snapshot.contextFiles.length === 0" class="config-empty">没有上下文文件。</p>
        </details>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 入口按钮：与头部的「切换项目 / 文件」保持同一套外观（10px、1px 边框、panel 底色） */
.session-info-button {
  display: inline-flex;
  gap: 5px;
  flex: 0 0 auto;
  align-items: center;
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  background: var(--panel);
  font-size: 10px;
  white-space: nowrap;
  cursor: pointer;
}

.session-info-button:disabled {
  opacity: 0.4;
  cursor: default;
}

:root[data-theme='light'] .session-info-button {
  color: var(--muted);
  background: #f8f9f5;
}

.session-info-dialog {
  width: min(760px, 100%);
}

.session-info-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.session-info-actions > button:first-child {
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  background: var(--panel);
  font-size: 10px;
  cursor: pointer;
}

.session-info-actions > button:disabled {
  opacity: 0.4;
  cursor: default;
}

.session-info-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

.session-info-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.session-info-chips li {
  display: inline-flex;
  gap: 5px;
  align-items: baseline;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--faint);
  font-size: 10px;
}

.session-info-chips strong {
  color: var(--text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.session-info-hint,
.session-info-desc {
  margin: 0;
  color: var(--faint);
  font-size: 10px;
  line-height: 1.6;
}

.session-info-error {
  margin: 0;
  color: var(--danger);
  font-size: 10px;
}

.session-info-section {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-raised, var(--panel));
}

.session-info-section > summary {
  padding: 8px 10px;
  color: var(--text);
  font-size: 11px;
  cursor: pointer;
}

.session-info-section > summary .session-info-source {
  margin-left: 8px;
  color: var(--faint);
  font-size: 9px;
}

.session-info-section-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 0 10px 6px;
  color: var(--faint);
  font-size: 9px;
}

.session-info-section-actions > button {
  min-height: 24px;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  background: var(--panel);
  font-size: 9px;
  cursor: pointer;
}

.session-info-section-actions > button:disabled {
  opacity: 0.4;
  cursor: default;
}

.session-info-truncated {
  color: #d8b25f;
}

/* 系统提示词全文：等宽、可滚动、保留换行——只读展示，不渲染 Markdown */
.session-info-pre {
  max-height: 320px;
  margin: 0 10px 10px;
  padding: 10px 11px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: #aeb4be;
  background: #0d0f13;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: thin;
}

:root[data-theme='light'] .session-info-pre {
  color: #213025;
  background: #f3f5ee;
}

.session-info-group {
  padding: 4px 10px 8px;
}

.session-info-group h4 {
  display: flex;
  gap: 6px;
  align-items: baseline;
  margin: 6px 0 6px;
  color: var(--muted);
  font-size: 10px;
}

.session-info-group h4 > span {
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}

.session-info-group h4 > em {
  color: var(--faint);
  font-size: 9px;
  font-style: normal;
}

.session-info-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.session-info-list > li {
  padding-left: 9px;
  border-left: 2px solid var(--line);
}

.session-info-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  font-size: 10px;
}

.session-info-row code {
  color: var(--text);
  font-family: 'Cascadia Code', Consolas, monospace;
}

.session-info-on {
  color: #2d9d68;
  font-size: 9px;
}

.session-info-off {
  color: var(--faint);
  font-size: 9px;
}

.session-info-source {
  color: var(--faint);
  font-size: 9px;
  word-break: break-all;
}
</style>
