<!-- 模型配置弹窗：以结构化表单编辑 models.json，支持一键 DeepSeek V4 预设。 -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { getModelsConfig, saveModelsConfig } from '@/lib/api';
import type { ModelDefinition, ModelsConfigValue } from '@/types';

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });

interface ProviderForm {
  name: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  models: ModelDefinition[];
  raw: Record<string, unknown>;
}

const emit = defineEmits<{
  close: [];
  saved: [];
}>();

const providers = ref<ProviderForm[]>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const presetNotice = ref<string | null>(null);

onMounted(async () => {
  // 打开时读取现有配置并转成表单结构（保留未编辑的扩展字段）
  try {
    const config = await getModelsConfig();
    providers.value = Object.entries(config.providers).map(([name, provider]) => ({
      name,
      api: provider.api ?? 'openai-completions',
      baseUrl: provider.baseUrl ?? '',
      apiKey: provider.apiKey ?? '',
      models: (provider.models ?? []).map((model) => ({ ...model })),
      raw: { ...provider },
    }));
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    loading.value = false;
  }
});

function addProvider(): void {
  providers.value.push({
    name: `provider-${providers.value.length + 1}`,
    api: 'openai-completions',
    baseUrl: '',
    apiKey: '',
    models: [],
    raw: {},
  });
}

function configureDeepSeek(): void {
  // 一键写入 DeepSeek V4 预设（Flash/Pro、1M 上下文、思考档位、密钥变量引用）。
  // 写入的是 pi.py 自身配置目录（~/.pi/agent-python/models.json），
  // 不会修改原版 pi 的 ~/.pi/agent/models.json。
  const preset: ProviderForm = {
    name: 'deepseek',
    api: 'deepseek-chat-completions',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '$DEEPSEEK_API_KEY',
    models: [
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        contextWindow: 1_000_000,
        reasoning: true,
        thinkingLevels: ['off', 'low', 'high', 'max'],
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        contextWindow: 1_000_000,
        reasoning: true,
        thinkingLevels: ['off', 'high', 'max'],
      },
    ],
    raw: {},
  };
  const existingIndex = providers.value.findIndex(
    (provider) => provider.name.trim().toLowerCase() === 'deepseek',
  );
  if (existingIndex === -1) providers.value.push(preset);
  else providers.value.splice(existingIndex, 1, preset);
  error.value = null;
  presetNotice.value =
    'DeepSeek V4 预设已就绪；保存后请在原版 pi 的 auth.json 中配置 DEEPSEEK_API_KEY（或在 pi 中执行 /login）。';
}

function addModel(provider: ProviderForm): void {
  provider.models.push({ id: '', name: '', reasoning: true });
}

async function save(): Promise<void> {
  // 保存：校验名称/模型 id 后合并扩展字段，写回 models.json
  error.value = null;
  const names = providers.value.map((provider) => provider.name.trim());
  if (names.some((name) => !name) || new Set(names).size !== names.length) {
    error.value = 'Provider 名称不能为空或重复';
    return;
  }
  if (providers.value.some((provider) => provider.models.some((model) => !model.id.trim()))) {
    error.value = '模型 ID 不能为空';
    return;
  }
  const value: ModelsConfigValue = { providers: {} };
  for (const provider of providers.value) {
    const models = provider.models.map((model) => {
      const serialized: ModelDefinition = {
        ...model,
        id: model.id.trim(),
        reasoning: model.reasoning ?? true,
      };
      if (model.name?.trim()) serialized.name = model.name.trim();
      else delete serialized.name;
      if (model.contextWindow && model.contextWindow > 0) {
        serialized.contextWindow = model.contextWindow;
      } else delete serialized.contextWindow;
      return serialized;
    });
    value.providers[provider.name.trim()] = {
      ...provider.raw,
      api: provider.api,
      ...(provider.baseUrl.trim() ? { baseUrl: provider.baseUrl.trim() } : {}),
      ...(provider.apiKey.trim() ? { apiKey: provider.apiKey.trim() } : {}),
      models,
    };
    if (!provider.baseUrl.trim()) delete value.providers[provider.name.trim()].baseUrl;
    if (!provider.apiKey.trim()) delete value.providers[provider.name.trim()].apiKey;
  }
  saving.value = true;
  try {
    await saveModelsConfig(value);
    emit('saved');
    if (!props.embedded) emit('close');
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    saving.value = false;
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : '模型配置操作失败';
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
      aria-labelledby="models-title"
    >
      <header v-if="!props.embedded" class="config-header">
        <div>
          <div class="welcome-kicker">LOCAL MODEL CATALOG</div>
          <h2 id="models-title">模型配置</h2>
        </div>
        <button type="button" aria-label="关闭模型配置" autofocus @click="emit('close')">×</button>
      </header>

      <div v-if="loading" class="config-state">正在读取 models.json…</div>
      <div v-else class="config-body">
        <p class="config-help">
          这里编辑的是 pi.py
          自己的模型配置（<code>%USERPROFILE%\.pi\agent-python\models.json</code>），不会改动原版 pi
          的文件。API Key 只保存变量引用（例如 <code>$DEEPSEEK_API_KEY</code>），真实值来自原版 pi
          的 <code>%USERPROFILE%\.pi\agent\auth.json</code>（在 pi 中执行
          <code>/login</code> 即可写入），不会写入此文件。
        </p>
        <div class="config-presets">
          <button type="button" class="config-add" @click="configureDeepSeek">
            一键配置 DeepSeek V4
          </button>
          <button type="button" class="config-add" @click="addProvider">
            ＋ 添加自定义 Provider
          </button>
        </div>
        <p v-if="presetNotice" class="config-notice" role="status">{{ presetNotice }}</p>
        <article
          v-for="(provider, providerIndex) in providers"
          :key="providerIndex"
          class="provider-card"
        >
          <div class="provider-grid">
            <label>名称<input v-model="provider.name" /></label>
            <label
              >协议
              <select v-model="provider.api">
                <option value="openai-completions">OpenAI Compatible</option>
                <option value="anthropic-messages">Anthropic Messages</option>
                <option value="deepseek-chat-completions">DeepSeek Chat Completions</option>
              </select>
            </label>
            <label>Base URL<input v-model="provider.baseUrl" placeholder="https://…/v1" /></label>
            <label
              >API Key 引用<input v-model="provider.apiKey" placeholder="$OPENAI_API_KEY"
            /></label>
          </div>
          <div class="model-list-heading">
            <strong>模型</strong>
            <button type="button" @click="addModel(provider)">＋ 添加模型</button>
          </div>
          <div v-if="provider.models.length === 0" class="config-empty">尚未添加模型</div>
          <div v-for="(model, modelIndex) in provider.models" :key="modelIndex" class="model-row">
            <input v-model="model.id" aria-label="模型 ID" placeholder="model-id" />
            <input v-model="model.name" aria-label="模型显示名称" placeholder="显示名称" />
            <input
              v-model.number="model.contextWindow"
              aria-label="上下文窗口"
              type="number"
              min="1"
              placeholder="context"
            />
            <label class="checkbox-field"
              ><input v-model="model.reasoning" type="checkbox" />推理</label
            >
            <button
              type="button"
              aria-label="删除模型"
              @click="provider.models.splice(modelIndex, 1)"
            >
              ×
            </button>
          </div>
          <button type="button" class="danger-link" @click="providers.splice(providerIndex, 1)">
            删除 Provider
          </button>
        </article>
      </div>

      <div v-if="error" class="config-error" role="alert">{{ error }}</div>
      <footer class="config-footer">
        <button v-if="!props.embedded" type="button" @click="emit('close')">取消</button>
        <button type="button" class="primary-action" :disabled="loading || saving" @click="save">
          {{ saving ? '保存中…' : '保存配置' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
/* 模型列表：行内表单与增删按钮；弹窗骨架（config-*）在 globals.css 中共享 */
.model-list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 14px 0 8px;
}

.model-list-heading button {
  border: 0;
  color: var(--accent);
  background: transparent;
  font-size: 10px;
  cursor: pointer;
}

.model-row {
  display: grid;
  grid-template-columns: 1.2fr 1fr 90px auto 28px;
  gap: 6px;
  margin-bottom: 6px;
}

.model-row > input {
  min-width: 0;
  min-height: 34px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text);
  background: var(--input-bg);
}

.model-row > button {
  border: 0;
  color: var(--faint);
  background: transparent;
  cursor: pointer;
}

@media (max-width: 760px) {
  .model-row {
    grid-template-columns: 1fr;
  }

  .model-row > button {
    justify-self: end;
  }
}
</style>
