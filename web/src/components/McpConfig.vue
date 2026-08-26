<!-- MCP Server 配置弹窗：列出已配置的 MCP server（含连接状态/工具数），支持增删改、启停、试连。 -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';

import {
  deleteMcpServer,
  getMcpServers,
  testMcpServer,
  updateMcpServer,
  upsertMcpServer,
} from '@/lib/api';
import type { McpScope, McpServerConfigInput, McpServerView, McpTransport } from '@/types';

const props = withDefaults(defineProps<{ cwd: string; embedded?: boolean }>(), { embedded: false });
const emit = defineEmits<{ close: [] }>();

interface McpDraft {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  enabled: boolean;
  approval: boolean;
}

const servers = ref<McpServerView[]>([]);
const loading = ref(true);
const saving = ref(false);
const testing = ref<string | null>(null);
const testResult = ref<string | null>(null);
const error = ref<string | null>(null);
const formOpen = ref(false);
const draft = ref<McpDraft | null>(null);

onMounted(load);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const result = await getMcpServers(props.cwd);
    servers.value = result.servers;
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    loading.value = false;
  }
}

function toDraft(server: McpServerView): McpDraft {
  return {
    name: server.name,
    scope: server.scope,
    transport: server.transport,
    command: server.command ?? '',
    args: (server.args ?? []).join(' '),
    env: mapToLines(server.env),
    cwd: server.cwd ?? '',
    url: server.url ?? '',
    headers: mapToLines(server.headers),
    enabled: server.enabled,
    approval: server.approval === 'required',
  };
}

function addServer(): void {
  draft.value = {
    name: '',
    scope: 'user',
    transport: 'stdio',
    command: '',
    args: '',
    env: '',
    cwd: '',
    url: '',
    headers: '',
    enabled: true,
    approval: false,
  };
  formOpen.value = true;
  testResult.value = null;
  error.value = null;
}

function editServer(server: McpServerView): void {
  draft.value = toDraft(server);
  formOpen.value = true;
  testResult.value = null;
  error.value = null;
}

function cancelForm(): void {
  formOpen.value = false;
  draft.value = null;
  testResult.value = null;
}

async function save(): Promise<void> {
  if (!draft.value) return;
  error.value = null;
  const name = draft.value.name.trim();
  if (!name) {
    error.value = 'Server 名称不能为空';
    return;
  }
  let config: McpServerConfigInput;
  try {
    config = draftToConfig(draft.value);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '配置不完整';
    return;
  }
  saving.value = true;
  try {
    if (servers.value.some((server) => server.name === name)) {
      await updateMcpServer(name, { cwd: props.cwd, scope: draft.value.scope, server: config });
    } else {
      await upsertMcpServer({ name, cwd: props.cwd, scope: draft.value.scope, server: config });
    }
    cancelForm();
    await load();
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    saving.value = false;
  }
}

async function removeServer(server: McpServerView): Promise<void> {
  error.value = null;
  if (!window.confirm(`删除 MCP server「${server.name}」？`)) return;
  try {
    await deleteMcpServer(server.name, props.cwd, server.scope);
    await load();
  } catch (cause) {
    error.value = messageOf(cause);
  }
}

async function toggleEnabled(server: McpServerView): Promise<void> {
  error.value = null;
  const config: McpServerConfigInput = { transport: server.transport, enabled: !server.enabled };
  if (server.transport === 'stdio') {
    if (server.command) config.command = server.command;
    if (server.args?.length) config.args = server.args;
    if (server.env) config.env = server.env;
    if (server.cwd) config.cwd = server.cwd;
  } else {
    if (server.url) config.url = server.url;
    if (server.headers) config.headers = server.headers;
  }
  if (server.approval) config.approval = server.approval;
  try {
    await updateMcpServer(server.name, { cwd: props.cwd, scope: server.scope, server: config });
    await load();
  } catch (cause) {
    error.value = messageOf(cause);
  }
}

async function testConnection(server: McpServerView): Promise<void> {
  testing.value = server.name;
  testResult.value = null;
  error.value = null;
  try {
    const result = await testMcpServer(server.name, props.cwd, server.scope);
    testResult.value = result.success
      ? `连接成功：发现 ${result.toolCount} 个工具`
      : `连接失败：${result.error ?? '未知错误'}`;
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    testing.value = null;
  }
}

async function testDraft(): Promise<void> {
  if (!draft.value) return;
  testing.value = 'form';
  testResult.value = null;
  error.value = null;
  try {
    const result = await testMcpServer(
      draft.value.name.trim() || 'server',
      props.cwd,
      draft.value.scope,
      draftToConfig(draft.value),
    );
    testResult.value = result.success
      ? `连接成功：发现 ${result.toolCount} 个工具`
      : `连接失败：${result.error ?? '未知错误'}`;
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    testing.value = null;
  }
}

function draftToConfig(d: McpDraft): McpServerConfigInput {
  const config: McpServerConfigInput = { transport: d.transport, enabled: d.enabled };
  if (d.approval) config.approval = 'required';
  if (d.transport === 'stdio') {
    const command = d.command.trim();
    if (!command) throw new Error('stdio 需要填写启动命令（command）');
    config.command = command;
    const args = d.args.trim().split(/\s+/).filter(Boolean);
    if (args.length) config.args = args;
    const env = linesToMap(d.env);
    if (Object.keys(env).length) config.env = env;
    const cwd = d.cwd.trim();
    if (cwd) config.cwd = cwd;
  } else {
    const url = d.url.trim();
    if (!url) throw new Error('streamable-http 需要填写 URL');
    config.url = url;
    const headers = linesToMap(d.headers);
    if (Object.keys(headers).length) config.headers = headers;
  }
  return config;
}

function mapToLines(map: Record<string, string> | undefined): string {
  if (!map) return '';
  return Object.entries(map)
    .map(([key, value]) => (value === '' ? key : `${key}: ${value}`))
    .join('\n');
}

function linesToMap(lines: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(':');
    const key = index === -1 ? trimmed : trimmed.slice(0, index).trim();
    const value = index === -1 ? '' : trimmed.slice(index + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function statusLabel(status: McpServerView['status']): string {
  return (
    { connected: '已连接', connecting: '连接中', error: '连接失败', disabled: '已禁用' }[status] ??
    status
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'MCP 操作失败';
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
      aria-labelledby="mcp-title"
    >
      <header v-if="!props.embedded" class="config-header">
        <div>
          <div class="welcome-kicker">MODEL CONTEXT PROTOCOL</div>
          <h2 id="mcp-title">MCP Servers</h2>
          <p>
            MCP 工具以
            <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>
            命名出现在会话工具列表；配置保存后自动对所有会话生效。
          </p>
        </div>
        <button type="button" aria-label="关闭 MCP 配置" autofocus @click="emit('close')">×</button>
      </header>

      <div v-if="loading" class="config-state">正在读取 MCP 配置…</div>

      <div v-else-if="formOpen && draft" class="config-body">
        <div class="config-presets">
          <button type="button" class="config-add" @click="cancelForm">← 返回列表</button>
          <button
            type="button"
            class="config-add"
            :disabled="testing === 'form'"
            @click="testDraft"
          >
            {{ testing === 'form' ? '测试中…' : '测试连接' }}
          </button>
        </div>
        <article class="provider-card mcp-form">
          <div class="provider-grid">
            <label>名称<input v-model="draft.name" placeholder="如 filesystem" /></label>
            <label
              >作用域
              <select v-model="draft.scope">
                <option value="user">用户级（~/.pi/agent/mcp.json）</option>
                <option value="workspace">工作区级（.pi/mcp.json）</option>
              </select>
            </label>
            <label
              >传输方式
              <select v-model="draft.transport">
                <option value="stdio">stdio（本地子进程）</option>
                <option value="streamable-http">streamable-http（远程）</option>
              </select>
            </label>
            <label class="checkbox-field mcp-switch"
              ><input v-model="draft.enabled" type="checkbox" />启用</label
            >
          </div>

          <template v-if="draft.transport === 'stdio'">
            <div class="provider-grid">
              <label>启动命令<input v-model="draft.command" placeholder="如 npx" /></label>
              <label
                >参数（空格分隔）<input
                  v-model="draft.args"
                  placeholder="-y @modelcontextprotocol/server-filesystem E:/code"
              /></label>
            </div>
            <div class="provider-grid">
              <label
                >工作目录（可选）<input v-model="draft.cwd" placeholder="默认使用当前工作区"
              /></label>
              <label class="checkbox-field mcp-switch"
                ><input v-model="draft.approval" type="checkbox" />工具调用需人工审批</label
              >
            </div>
            <label class="mcp-line-field"
              >环境变量（每行 KEY=value 或 KEY: value）
              <textarea
                v-model="draft.env"
                rows="3"
                placeholder="API_KEY=$MY_TOKEN"
                spellcheck="false"
              />
            </label>
          </template>

          <template v-else>
            <label class="mcp-line-field"
              >Endpoint URL<input v-model="draft.url" placeholder="https://example.com/mcp"
            /></label>
            <label class="mcp-line-field"
              >请求头（每行 Header: value）
              <textarea
                v-model="draft.headers"
                rows="3"
                placeholder="Authorization: Bearer $TOKEN"
                spellcheck="false"
              />
            </label>
            <label class="checkbox-field mcp-switch"
              ><input v-model="draft.approval" type="checkbox" />工具调用需人工审批</label
            >
          </template>

          <p class="config-help mcp-help">
            stdio 通过 <code>command/args</code> 启动子进程（可执行任意命令），与 bash
            同等级信任；建议为有外部副作用的 server 开启人工审批。
          </p>
        </article>
        <p v-if="testResult" class="config-notice" role="status">{{ testResult }}</p>
      </div>

      <div v-else class="config-body">
        <div class="config-presets">
          <button type="button" class="config-add" @click="addServer">＋ 添加 Server</button>
        </div>
        <div v-if="servers.length === 0" class="config-empty">
          尚未配置 MCP server，点击上方添加。
        </div>
        <article
          v-for="server in servers"
          :key="`${server.scope}:${server.name}`"
          class="skill-card"
        >
          <div>
            <div class="mcp-title-row">
              <strong>{{ server.name }}</strong>
              <span class="mcp-badge mcp-badge--scope">{{
                server.scope === 'workspace' ? '工作区' : '用户'
              }}</span>
              <span class="mcp-badge" :class="`mcp-badge--${server.status}`">
                <span class="mcp-dot" aria-hidden="true" />{{ statusLabel(server.status) }}
              </span>
              <span class="mcp-tools">{{ server.toolCount }} 个工具</span>
            </div>
            <p class="mcp-desc">
              <code>{{
                server.transport === 'stdio'
                  ? `${server.command ?? ''} ${(server.args ?? []).join(' ')}`
                  : (server.url ?? '')
              }}</code>
              <span v-if="server.approval === 'required'" class="mcp-badge mcp-badge--approval"
                >需审批</span
              >
            </p>
            <p v-if="server.status === 'error' && server.error" class="mcp-error">
              {{ server.error }}
            </p>
            <details v-if="server.tools.length">
              <summary>{{ server.toolCount }} 个工具</summary>
              <ul class="mcp-tool-list">
                <li v-for="tool in server.tools" :key="tool.name">
                  <code>{{ tool.name }}</code>
                  <span v-if="tool.description">{{ tool.description }}</span>
                </li>
              </ul>
            </details>
          </div>
          <div class="mcp-actions">
            <button
              type="button"
              class="mcp-toggle"
              :class="{ 'mcp-toggle--on': server.enabled }"
              :aria-pressed="server.enabled"
              @click="toggleEnabled(server)"
            >
              {{ server.enabled ? '已启用' : '已停用' }}
            </button>
            <button
              type="button"
              :disabled="testing === server.name"
              @click="testConnection(server)"
            >
              {{ testing === server.name ? '测试中…' : '测试' }}
            </button>
            <button type="button" @click="editServer(server)">编辑</button>
            <button type="button" class="danger-link mcp-remove" @click="removeServer(server)">
              删除
            </button>
          </div>
        </article>
      </div>

      <p v-if="testResult && !formOpen" class="config-notice mcp-test-result" role="status">
        {{ testResult }}
      </p>
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
          {{ saving ? '保存中…' : '保存 Server' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.mcp-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.mcp-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  font-size: 9px;
}

.mcp-badge--scope {
  color: var(--accent);
  border-color: var(--accent-dim, var(--line-strong));
}

.mcp-badge--approval {
  color: var(--danger);
  border-color: var(--danger-dim, var(--line-strong));
}

.mcp-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
}

.mcp-badge--connected .mcp-dot {
  background: #2ecc71;
}
.mcp-badge--connecting .mcp-dot {
  background: #f1c40f;
}
.mcp-badge--error .mcp-dot {
  background: #e74c3c;
}
.mcp-badge--disabled .mcp-dot {
  background: var(--muted);
}

.mcp-tools {
  color: var(--faint);
  font-size: 10px;
}

.mcp-desc {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 6px 0 0;
  color: var(--faint);
  font-size: 10px;
}

.mcp-desc code,
.mcp-error {
  font-size: 10px;
}

.mcp-error {
  margin: 4px 0 0;
  color: var(--danger);
}

.mcp-tool-list {
  margin: 6px 0 0;
  padding-left: 16px;
  color: var(--muted);
  font-size: 10px;
}

.mcp-tool-list li {
  display: flex;
  gap: 8px;
}

.mcp-tool-list li span {
  color: var(--faint);
}

.mcp-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.mcp-actions button {
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  background: transparent;
  font-size: 10px;
  cursor: pointer;
}

.mcp-actions button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}

.mcp-actions button:disabled {
  cursor: default;
  opacity: 0.5;
}

.mcp-remove {
  border: 0 !important;
  margin-top: 0;
}

.mcp-toggle--on {
  border-color: var(--accent) !important;
  color: var(--accent) !important;
}

.mcp-form {
  display: grid;
  gap: 12px;
}

.mcp-line-field {
  display: grid;
  gap: 5px;
  color: var(--faint);
  font-size: 9px;
}

.mcp-line-field input,
.mcp-line-field textarea {
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text);
  background: #0e1014;
  font-size: 11px;
  font-family: inherit;
}

.mcp-line-field textarea {
  resize: vertical;
}

.mcp-switch {
  align-self: end;
  padding-bottom: 8px;
}

.mcp-help {
  margin: 0;
}

.mcp-test-result {
  padding: 0 20px;
}
</style>
