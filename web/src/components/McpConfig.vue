<!-- MCP Server 配置弹窗：列出已配置的 MCP server（含连接状态/工具数），支持增删改、启停、试连。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import {
  deleteMcpServer,
  getMcpServers,
  getMcpTemplates,
  testMcpServer,
  updateMcpServer,
  upsertMcpServer,
} from '@/lib/api';
import type {
  McpScope,
  McpServerConfigInput,
  McpServerView,
  McpTemplate,
  McpTransport,
} from '@/types';

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
const templates = ref<McpTemplate[]>([]);
const templatesOpen = ref(false);
const addingTemplate = ref<string | null>(null);

/** 模板分组标题（与后端 MCP_TEMPLATE_GROUPS 对应）。 */
const GROUP_LABEL: Record<McpTemplate['group'], string> = {
  core: '通用能力',
  research: '联网检索与文档',
  browser: '浏览器自动化',
  code: '代码 / 仓库',
  data: '数据库',
  team: '协作与线上排障',
  debug: '调试',
};
const groupedTemplates = computed(() =>
  (Object.keys(GROUP_LABEL) as Array<McpTemplate['group']>)
    .map((group) => ({
      group,
      label: GROUP_LABEL[group],
      items: templates.value.filter((item) => item.group === group),
    }))
    .filter((entry) => entry.items.length > 0),
);

onMounted(async () => {
  await Promise.all([load(), loadTemplates()]);
});

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

async function loadTemplates(): Promise<void> {
  try {
    templates.value = await getMcpTemplates();
  } catch {
    // 模板库是增量能力：拉不到就只显示手工添加，不影响已有配置。
    templates.value = [];
  }
}

/** 模板 → 表单草稿（供「填入表单」与「一键添加」共用）。 */
function templateToDraft(template: McpTemplate): McpDraft {
  return {
    name: template.name,
    scope: 'user',
    transport: template.transport,
    command: template.command ?? '',
    args: (template.args ?? []).join(' '),
    env: mapToLines(template.env),
    cwd: '',
    url: template.url ?? '',
    headers: mapToLines(template.headers),
    enabled: true,
    approval: template.suggestApproval,
  };
}

/** 填入表单：用户补参数/凭据后再保存（有 needsInput 或需要凭据的模板走这里）。 */
function fillTemplate(template: McpTemplate): void {
  draft.value = templateToDraft(template);
  formOpen.value = true;
  testResult.value = null;
  error.value = null;
}

/** 一键添加：无凭据、也不缺必填输入的模板直接写入配置（写完可以立即试连）。 */
async function addFromTemplate(template: McpTemplate): Promise<void> {
  addingTemplate.value = template.id;
  error.value = null;
  testResult.value = null;
  try {
    const config = draftToConfig(templateToDraft(template));
    await upsertMcpServer({ name: template.name, cwd: props.cwd, scope: 'user', server: config });
    await load();
    testResult.value = `已添加「${template.title}」：建议点「连接测试」确认它能起来（或展开卡片看状态）`;
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    addingTemplate.value = null;
  }
}

function accessLabel(access: McpTemplate['access']): string {
  return { 'read-only': '只读', 'local-write': '本地写', 'external-write': '外部副作用' }[access];
}

/** 模板卡片上的徽标（是否需要凭据、风险、建议审批、工具数）。 */
function templateBadges(template: McpTemplate): string[] {
  const badges = [accessLabel(template.access)];
  if (template.requiresCredentials) badges.push('需要凭据');
  if (template.needsInput) badges.push('需填参数');
  if (template.suggestApproval) badges.push('建议审批');
  badges.push(`工具 ${template.toolCountHint}`);
  return badges;
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
    {
      connected: '已连接',
      connecting: '连接中',
      error: '连接失败',
      disabled: '已禁用',
      idle: '未连接',
    }[status] ?? status
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
          <button
            v-if="templates.length"
            type="button"
            class="config-add"
            :aria-expanded="templatesOpen"
            @click="templatesOpen = !templatesOpen"
          >
            {{ templatesOpen ? '收起模板库' : `模板库（${templates.length} 个推荐）` }}
          </button>
        </div>

        <!--
          模板库：把「知道包名和参数」这件事接过来。
          无凭据且不缺必填输入的模板可以一键添加；其余填入表单后由用户补凭据/参数。
          风险徽标（只读 / 本地写 / 外部副作用、建议审批、工具数）是刻意的：
          每个 server 的工具都会进系统提示词，装太多会分散模型注意力。
        -->
        <section v-if="templatesOpen" class="mcp-templates" aria-label="MCP server 模板库">
          <p class="config-help mcp-help">
            从推荐模板一键添加；需要凭据的模板会先填进表单，你把
            <code>$ENV</code> 变量准备好即可。建议每个工作区常驻 2–4 个（工具都会进提示词）。
          </p>
          <div v-for="entry in groupedTemplates" :key="entry.group" class="mcp-template-group">
            <h3>{{ entry.label }}</h3>
            <article v-for="template in entry.items" :key="template.id" class="mcp-template-card">
              <div class="mcp-template-head">
                <strong>{{ template.title }}</strong>
                <span v-for="badge in templateBadges(template)" :key="badge" class="mcp-badge">
                  {{ badge }}
                </span>
              </div>
              <p class="mcp-template-desc">{{ template.description }}</p>
              <code class="mcp-template-cmd"
                >{{ template.transport === 'stdio' ? template.command : template.url }}
                {{ (template.args ?? []).join(' ') }}</code
              >
              <ul v-if="template.notes?.length" class="mcp-template-notes">
                <li v-for="note in template.notes" :key="note">{{ note }}</li>
              </ul>
              <p v-if="template.needsInput" class="mcp-template-needs">
                需要你补充：{{ template.needsInput }}
              </p>
              <div class="mcp-template-actions">
                <button
                  v-if="template.canAddDirectly"
                  type="button"
                  class="config-add"
                  :disabled="addingTemplate === template.id"
                  @click="addFromTemplate(template)"
                >
                  {{ addingTemplate === template.id ? '添加中…' : '一键添加' }}
                </button>
                <button type="button" class="config-add" @click="fillTemplate(template)">
                  填入表单
                </button>
                <a
                  class="mcp-template-link"
                  :href="template.homepage"
                  target="_blank"
                  rel="noreferrer"
                >
                  文档 ↗
                </a>
              </div>
            </article>
          </div>
        </section>
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
/* 模板库：推荐清单卡片（分组 + 风险徽标 + 一键添加/填入表单） */
.mcp-templates {
  margin: 8px 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: linear-gradient(135deg, rgba(231, 255, 111, 0.03), transparent 40%), var(--panel);
}

.mcp-template-group {
  margin-top: 10px;
}

.mcp-template-group h3 {
  margin: 0 0 6px;
  color: var(--faint);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.mcp-template-card {
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 5px;
  margin-bottom: 6px;
}

.mcp-template-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.mcp-template-desc {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}

.mcp-template-cmd {
  display: block;
  margin-top: 5px;
  padding: 4px 6px;
  overflow-x: auto;
  border-radius: 3px;
  background: var(--bg);
  color: var(--faint);
  font-size: 10px;
  white-space: nowrap;
}

.mcp-template-notes {
  margin: 5px 0 0;
  padding-left: 16px;
  color: var(--faint);
  font-size: 10px;
  line-height: 1.6;
}

.mcp-template-needs {
  margin: 5px 0 0;
  color: var(--accent);
  font-size: 10px;
}

.mcp-template-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 7px;
}

.mcp-template-link {
  color: var(--faint);
  font-size: 10px;
  text-decoration: none;
}

.mcp-template-link:hover {
  color: var(--accent);
}

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
.mcp-badge--idle .mcp-dot {
  background: var(--faint);
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
  background: var(--input-bg);
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
