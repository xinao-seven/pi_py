// M0-④: 扩展注册的工具（pi.registerTool）是否同样走 tool_call 钩子链？
//        多个扩展注册 tool_call 时的执行顺序？能否在工具执行前阻断？
//        这是 M4（submit_plan 工具 + Plan 能力分类拦截）与 M5（子会话审批继承）的地基。
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

const root = mkdtempSync(join(tmpdir(), 'pi-spike-hooks-'));
const agentDir = join(root, 'agent');
const cwd = join(root, 'ws');
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, 'auth.json'), '{}\n');
writeFileSync(join(agentDir, 'models.json'), '{ "providers": {} }\n');

const trace = [];
let planToolExecuted = 0;

// 扩展 A —— 模拟 Plan 模式（先注册）
const planExtension = (pi) => {
  pi.on('tool_call', (event) => {
    trace.push(`plan-hook:${event.toolName}`);
    if (event.toolName === 'edit') return { block: true, reason: 'plan mode is read-only' };
    return undefined;
  });
  // 模拟 M4 的 submit_plan 工具
  pi.registerTool({
    name: 'submit_plan',
    label: 'Submit plan',
    description: 'Submit a structured plan',
    promptSnippet: 'Call submit_plan to propose a plan.',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    async execute() {
      planToolExecuted++;
      return { content: [{ type: 'text', text: 'plan accepted' }] };
    },
  });
};

// 扩展 B —— 模拟审批中枢（后注册）
const approvalExtension = (pi) => {
  pi.on('tool_call', (event) => {
    trace.push(`approval-hook:${event.toolName}`);
    if (event.toolName === 'bash') return { block: true, reason: 'approval denied (spike)' };
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
  extensionFactories: [planExtension, approvalExtension],
});
await loader.reload();
// 注：loader 不对外暴露扩展清单，工具可用性以 [3] 的"实际执行次数"为准。

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

faux.setResponses([
  fauxAssistantMessage([fauxToolCall('submit_plan', { title: '重构 Plan 模式' })], {
    stopReason: 'toolUse',
  }),
  fauxAssistantMessage([fauxToolCall('edit', { path: 'a.ts', oldText: 'x', newText: 'y' })], {
    stopReason: 'toolUse',
  }),
  fauxAssistantMessage([fauxToolCall('bash', { command: 'pnpm test' })], { stopReason: 'toolUse' }),
  fauxAssistantMessage('全部结束'),
]);

const toolEvents = [];
session.subscribe((e) => {
  if (e.type === 'tool_execution_start') toolEvents.push(`START ${e.toolName}`);
  if (e.type === 'tool_execution_end') toolEvents.push(`END   ${e.toolName} isError=${e.isError}`);
  if (e.type === 'tool_execution_blocked') toolEvents.push(`BLOCKED ${e.toolName}`);
});

await session.prompt('请先提交计划，然后改文件、跑测试');

console.log('\n[1] tool_call 钩子调用顺序:');
trace.forEach((t, i) => console.log(`    ${i + 1}. ${t}`));
console.log('\n[2] 工具执行事件:');
toolEvents.forEach((t) => console.log('   ', t));
console.log(
  `\n[3] submit_plan 工具体实际执行次数 = ${planToolExecuted}（1 = 扩展注册的工具可用且可被调用）`,
);
// 注意：钩子返回 { block: true } 时，SDK 仍会发出 execution_start/end(isError=true)，
// 但工具体不会执行。精确语义由 04b-block-semantics.mjs 单独验证。
console.log(
  '[4] edit 的事件里出现 execution_start/end(isError=true)（block 的表现在此，非工具体执行）=',
  toolEvents.some((t) => t.includes('edit')),
);
console.log(
  '[5] bash 的事件里出现 execution_start/end(isError=true)（同上）=',
  toolEvents.some((t) => t.includes('bash')),
);
console.log('\n[6] 最终消息角色:');
console.log(
  '   ',
  (session.state?.messages ?? session.messages ?? [])
    .map((m) => (m.role === 'toolResult' ? `toolResult(${m.toolName})` : m.role))
    .join(' → '),
);

session.dispose?.();
rmSync(root, { recursive: true, force: true });
