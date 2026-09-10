// M0-④ 续: {block:true} 的真实语义 —— 工具体是否真的没跑？阻断原因是否回给模型？
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import {
  ModelRuntime,
  createAgentSession,
  SessionManager,
  DefaultResourceLoader,
} from '@earendil-works/pi-coding-agent';

const root = mkdtempSync(join(tmpdir(), 'pi-spike-block-'));
const agentDir = join(root, 'agent');
const cwd = join(root, 'ws');
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, 'auth.json'), '{}\n');
writeFileSync(join(agentDir, 'models.json'), '{ "providers": {} }\n');

let probeRuns = 0;
const order = [];

const planExt = (pi) => {
  pi.on('tool_call', (e) => {
    order.push(`plan:${e.toolName}`);
    if (e.toolName === 'probe') return { block: true, reason: 'PLAN_BLOCKED: 规划期禁止副作用' };
    return undefined;
  });
  pi.registerTool({
    name: 'probe',
    label: 'probe',
    description: 'probe',
    parameters: { type: 'object', properties: {} },
    async execute() {
      probeRuns++;
      return { content: [{ type: 'text', text: 'probe ran' }] };
    },
  });
};
const approvalExt = (pi) => {
  pi.on('tool_call', (e) => {
    order.push(`approval:${e.toolName}`);
    return undefined;
  });
};

const faux = fauxProvider();
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'),
  modelsPath: join(agentDir, 'models.json'),
  allowModelNetwork: false,
});
runtime.registerNativeProvider(faux.provider);
const model = runtime.getModel(faux.provider.id, faux.getModel().id);
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  extensionFactories: [planExt, approvalExt],
});
await loader.reload();

const sessionManager = SessionManager.create(cwd, join(agentDir, 'sessions'));
const { session } = await createAgentSession({
  cwd,
  agentDir,
  modelRuntime: runtime,
  model,
  sessionManager,
  resourceLoader: loader,
  thinkingLevel: 'off',
});

const seen = [];
session.subscribe((e) => {
  if (e.type === 'tool_execution_start') seen.push(`execution_start(${e.toolName})`);
  if (e.type === 'tool_execution_end')
    seen.push(`execution_end(${e.toolName}, isError=${e.isError})`);
  if (String(e.type).includes('block')) seen.push(`${e.type}(${e.toolName})`);
});

faux.setResponses([
  fauxAssistantMessage([fauxToolCall('probe', {})], { stopReason: 'toolUse' }),
  fauxAssistantMessage('结束'),
]);
await session.prompt('调用 probe');

const msgs = session.state?.messages ?? session.messages ?? [];
const toolResult = msgs.find((m) => m.role === 'toolResult');
console.log('[1] 钩子顺序:', order.join(' → '));
console.log(
  '[2] 工具体实际执行次数 probeRuns =',
  probeRuns,
  probeRuns === 0 ? '→ block 生效，工具体未执行 ✅' : '→ block 未生效 ❌',
);
console.log('[3] 事件:', seen.join(', '));
console.log('[4] 回给模型的 toolResult:');
console.log('    isError =', toolResult?.isError, '| toolName =', toolResult?.toolName);
console.log('    content =', JSON.stringify(toolResult?.content));

session.dispose?.();
rmSync(root, { recursive: true, force: true });
