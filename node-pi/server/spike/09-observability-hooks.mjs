// 可观测性扩容 P0/P1：验证「接线真的通了」的四件事（离线、无网络、临时目录）。
//
// 为什么需要 spike 而不是只有单测：
//   ① P1 的请求形状依赖 `before_provider_request`，而它只在**真实 provider 的
//      `onPayload` 钩子**里被触发——fauxProvider 直接产出响应，不经过这条路径，
//      所以 e2e 无法证明它。这里改成静态校验「SDK + 每个 provider 仍在调用 onPayload」，
//      将来 SDK 升级把这行删掉时，CI 会立刻报错，而不是悄悄少一份数据。
//   ② `context` / `model_select` 钩子有同样的接线依赖，一并校验。
//   ③ 用真实的 anthropic / openai 参数形状喂给 `promptShapeOf`，确认形状提取在
//      真实载荷上是可用的（单测里的载荷是手写的）。
//   ④ 迁移 v4 的 wait_ms / active_ms 列真实存在（SQLite 后端）。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildObservabilityExtension } from '../dist/services/observability/observability-extension.js';
import { collectInjections, promptShapeOf } from '../dist/services/observability/prompt-shape.js';
import { SessionLedger } from '../dist/services/observability/session-ledger.js';
import { openPlatformStore } from '../dist/services/platform/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '..');
const nodeModules = join(serverRoot, 'node_modules');
const piAiApi = join(nodeModules, '@earendil-works/pi-ai/dist/api');
const piCodingAgent = join(nodeModules, '@earendil-works/pi-coding-agent/dist/core');

const failures = [];
function check(label, condition, detail = '') {
  console.log(`  ${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

console.log('=== ① provider 层仍会把 payload 交给扩展（P1 的数据来源）===');
// 这些 provider 实现都有「组装参数 → 发请求」这一步；只要它还在，onPayload 就必须被调用。
const PROVIDERS = [
  'anthropic-messages.js',
  'openai-completions.js',
  'openai-responses.js',
  'google-generative-ai.js',
  'google-vertex.js',
  'mistral-conversations.js',
  'azure-openai-responses.js',
  'bedrock-converse-stream.js',
  'openai-codex-responses.js',
  'pi-messages.js',
];
const missingPayload = PROVIDERS.filter((file) => {
  try {
    return !readFileSync(join(piAiApi, file), 'utf8').includes('onPayload');
  } catch {
    // 文件不存在（SDK 版本换了名字）也算失败，交给下面统一报出来。
    return true;
  }
});
check(
  `全部 ${PROVIDERS.length} 个 provider 都调用 onPayload（只调不到即静默丢数据）`,
  missingPayload.length === 0,
  missingPayload.join(','),
);

const simpleOptions = readFileSync(join(piAiApi, 'simple-options.js'), 'utf8');
check('streamSimple 把 onPayload 透传进 provider 选项', simpleOptions.includes('onPayload'));

const sdk = readFileSync(join(piCodingAgent, 'sdk.js'), 'utf8');
check(
  'coding-agent 把 payload 事件发给扩展（emitBeforeProviderRequest）',
  sdk.includes('emitBeforeProviderRequest'),
);
check(
  'coding-agent 在发请求前先派发 before_provider_headers',
  sdk.includes('emitBeforeProviderHeaders'),
);

console.log('\n=== ② 扩展注册的钩子与账本接口 ===');
const handlers = new Map();
const fakePi = {
  on(channel, handler) {
    handlers.set(channel, handler);
  },
};
const observed = [];
const observer = {
  noteProviderRequestStart: (sessionId) => observed.push(['requestStart', sessionId]),
  noteProviderResponse: (sessionId, status) => observed.push(['response', sessionId, status]),
  noteProviderPayload: (sessionId, payload) => observed.push(['payload', sessionId, payload]),
  noteContextMessages: (sessionId, messages) => observed.push(['context', sessionId, messages]),
  noteModelSelect: (input) => observed.push(['modelSelect', input.source]),
};
buildObservabilityExtension(observer)(fakePi);
check('注册了 5 个观测钩子', handlers.size === 5, [...handlers.keys()].join(','));

const ctx = { sessionManager: { getSessionId: () => 'session-1' } };
handlers.get('before_provider_request')?.({ payload: { messages: [] } }, ctx);
handlers.get('context')?.({ messages: [{ customType: 'task-resume', content: 'r' }] }, ctx);
handlers.get('model_select')?.(
  { model: { id: 'm2' }, previousModel: { id: 'm1' }, source: 'set' },
  ctx,
);
check(
  '三个新钩子都会把观测点转发出去',
  observed.map((item) => item[0]).join(',') === 'payload,context,modelSelect',
  observed.map((item) => item[0]).join(','),
);

console.log('\n=== ③ 真实 provider 载荷的形状提取 ===');
// 形状取自 pi-ai 的 anthropic-messages.js（messages + system + tools）与 openai-completions.js
// （messages + tools[{type,function:{name}}]）。
const anthropicShape = promptShapeOf({
  model: 'claude-x',
  system: 'You are pi.',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'read', description: 'read a file' }, { name: 'bash' }],
});
check(
  'anthropic 风格载荷 → 工具集/系统提示词指纹',
  anthropicShape?.tools.join(',') === 'bash,read' &&
    anthropicShape.systemChars === 'You are pi.'.length &&
    typeof anthropicShape.systemDigest === 'string',
  JSON.stringify(anthropicShape),
);
const openaiShape = promptShapeOf({
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ type: 'function', function: { name: 'grep' } }],
});
check(
  'openai 风格载荷 → 解出 function 包装里的工具名',
  openaiShape?.tools.join(',') === 'grep',
  JSON.stringify(openaiShape),
);
check('无法识别的载荷返回 undefined（而不是抛错）', promptShapeOf({ nope: 1 }) === undefined);

const injections = collectInjections([
  { role: 'user', content: 'hi' },
  { customType: 'web-plan-context', content: 'plan rev 1' },
  { customType: 'task-resume', content: 'resume' },
]);
check(
  '注入审计认出两种注入类型且不落正文（只有字符数与指纹）',
  injections.map((item) => item.customType).join(',') === 'web-plan-context,task-resume' &&
    injections.every((item) => item.chars > 0 && item.digest.length === 12),
  JSON.stringify(injections),
);

console.log('\n=== ④ 账本落库 + 迁移 v4 的 wait/active 列 ===');
const root = mkdtempSync(join(tmpdir(), 'pi-spike-observability-'));
const store = openPlatformStore({ mode: 'sqlite', dbPath: join(root, 'platform.db') });
const ledger = new SessionLedger(store.traces, undefined, { runIdFactory: () => 'spike-run-1' });
// 会话上下文就是注册表交给账本的那几个字段（provider/model 是**字符串**，不是 model 对象）。
const session = {
  sessionId: 'session-1',
  cwd: '/ws',
  provider: 'deepseek',
  model: 'deepseek-chat',
  thinkingLevel: 'off',
};
const record = (payload) => ledger.record(session, payload);
try {
  record({ type: 'agent_start' });
  record({ type: 'turn_start' });
  ledger.noteProviderPayload('session-1', {
    messages: [{}, {}],
    tools: [{ name: 'read' }],
    system: 'sys',
  });
  ledger.noteQuestionStart({
    sessionId: 'session-1',
    questionId: 'q1',
    toolCallId: 'c1',
    questionCount: 1,
  });
  ledger.noteQuestionDecision({
    sessionId: 'session-1',
    questionId: 'q1',
    reason: 'user',
    answers: 1,
  });
  record({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      usage: { input: 10, output: 1, cacheRead: 30 },
    },
  });
  record({ type: 'agent_settled' });

  const detail = store.traces.getRun('spike-run-1');
  check(
    'run 拆出了 waitMs / activeMs 两列',
    typeof detail?.run.waitMs === 'number' && typeof detail?.run.activeMs === 'number',
    JSON.stringify({
      waitMs: detail?.run.waitMs,
      activeMs: detail?.run.activeMs,
      durationMs: detail?.run.durationMs,
    }),
  );
  const question = detail?.steps.find((step) => step.kind === 'question');
  check(
    '提问落成 question 步骤',
    question?.meta?.reason === 'user',
    JSON.stringify(question?.meta),
  );
  const llm = detail?.steps.find((step) => step.kind === 'llm_call');
  check(
    '请求形状与缓存命中率落在 llm_call 上',
    llm?.meta?.promptTools === 1 &&
      llm?.meta?.promptToolNames?.[0] === 'read' &&
      llm?.meta?.cacheHitRate === 0.75,
    JSON.stringify(llm?.meta),
  );
  const summary = store.traces.summary({});
  check(
    '聚合里有机器耗时样本与累计人工等待',
    summary.totals.activeSamples.length === 1 && summary.totals.waitSamples.length === 1,
    JSON.stringify({
      active: summary.totals.activeSamples,
      wait: summary.totals.waitSamples,
      humanWaitMs: summary.totals.humanWaitMs,
    }),
  );
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}

console.log('\n=== ⑤ dist 与文档索引 ===');
const docsIndex = readFileSync(join(serverRoot, '..', '..', 'CLAUDE.md'), 'utf8');
check('CLAUDE.md 文档索引登记了 P0/P1 说明', docsIndex.includes('node-observability-p0p1.md'));
const readme = readFileSync(join(serverRoot, '..', '..', 'README.md'), 'utf8');
check('README 文档索引登记了 P0/P1 说明', readme.includes('node-observability-p0p1.md'));

if (failures.length) {
  console.error(`\n❌ 可观测性钩子契约验证失败：${failures.join(' / ')}`);
  process.exit(1);
}
console.log('\n✅ P0/P1 可观测性接线验证通过：白捡事件、人机等待拆分、请求形状与注入审计都已打通');
