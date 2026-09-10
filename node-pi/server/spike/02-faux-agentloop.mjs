// M0-②: fauxProvider → ModelRuntime.registerNativeProvider → createAgentSession
//       验证可以离线、确定性地驱动完整 agent loop（含工具调用），绝不触网、绝不碰真实 ~/.pi
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { ModelRuntime, createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

const root = mkdtempSync(join(tmpdir(), 'pi-spike-faux-'));
const agentDir = join(root, 'agent');
const cwd = join(root, 'ws');
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, 'auth.json'), '{}\n');
writeFileSync(join(agentDir, 'models.json'), '{ "providers": {} }\n');

const faux = fauxProvider();
console.log('[1] faux api id =', faux.api, '| provider.id =', faux.provider.id);

const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'),
  modelsPath: join(agentDir, 'models.json'),
  allowModelNetwork: false,
});
runtime.registerNativeProvider(faux.provider);

const providerId = faux.provider.id;
const model = runtime.getModel(providerId, faux.getModel().id) ?? runtime.getModel(providerId);
console.log(
  '[2] registerNativeProvider 后可解析模型 =',
  model ? `${model.provider}/${model.id}` : 'FAILED',
);
if (!model) {
  console.error(
    '  providers:',
    runtime
      .getProviders()
      .map((p) => p.id)
      .join(','),
  );
  process.exit(1);
}

// 脚本化响应：第 1 轮调用工具，第 2 轮给出结论
faux.setResponses([
  fauxAssistantMessage([fauxToolCall('read', { path: 'hello.txt' })], { stopReason: 'toolUse' }),
  fauxAssistantMessage('已读取文件，结论是 OK。'),
]);

const sessionManager = SessionManager.create(cwd, join(agentDir, 'sessions'));
const { session } = await createAgentSession({
  cwd,
  agentDir,
  modelRuntime: runtime,
  model,
  sessionManager,
  tools: ['read'],
  thinkingLevel: 'off',
});

const events = [];
session.subscribe((event) => {
  events.push(event.type);
  if (event.type === 'tool_execution_start')
    console.log('    → tool_execution_start:', event.toolName, JSON.stringify(event.args));
  if (event.type === 'tool_execution_end')
    console.log('    → tool_execution_end:', event.toolName, 'isError=', event.isError);
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const text = (event.message.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (text) console.log('    → assistant:', text);
  }
});

const t0 = performance.now();
await session.prompt('读一下 hello.txt');
console.log(
  `[3] agent loop 完成，耗时 ${(performance.now() - t0).toFixed(1)}ms，faux 调用轮次 = ${faux.state.callCount}`,
);
console.log('[4] 事件序列（去重前 24 条）:', [...new Set(events)].join(', '));

const msgs = session.state?.messages ?? session.messages ?? [];
const roles = msgs.map((m) => (m.role === 'toolResult' ? `toolResult(${m.toolName})` : m.role));
console.log('[5] 最终消息序列:', roles.join(' → '));
console.log('[6] session JSONL =', sessionManager.getSessionFile());
console.log('[7] getSessionStats():', JSON.stringify(session.getSessionStats?.()));
console.log('[8] getContextUsage():', JSON.stringify(session.getContextUsage?.()));

// 确定性验证：同一脚本 + callCount 断言
const pending = faux.getPendingResponseCount();
console.log(`[9] 剩余待发响应 = ${pending}（0 表示脚本被完整消费，可确定性断言）`);

session.dispose?.();
rmSync(root, { recursive: true, force: true });
