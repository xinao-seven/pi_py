// M6: 预设能力开关 + 「极简（原版 pi）」模式（真实 SDK + 真实装配；离线、临时目录）。
//
// 验证四件事（都是"接线是否真的通了"，不是纯单测能覆盖的）：
//   ① 默认会话：内联扩展注册的工具（plan_* / ask_user / subagent）会并入工具白名单。
//      白名单是**可用集**：漏并 subagent 会让「带预设的会话」里该工具直接 not found。
//   ② 极简会话（extensions 全 false + mcpServers: []）：只剩 SDK 内置工具。
//   ③ fileExtensions=false 时，用户装在 `~/.pi/agent/extensions/` 的文件扩展不再加载
//      （本 spike 自己在临时 agentDir 里造一个扩展来证明这一点）。
//   ④ 会话能力位（capabilities）与开关一致，可直接给前端用。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AgentRegistry, OriginalPiSessionFactory } from '../dist/services/agent-registry.js';
import { ToolApprovalBroker } from '../dist/services/tool-approval.js';
import { PlanModeService } from '../dist/services/plan-mode-service.js';
import { QuestionBroker } from '../dist/services/user-question.js';
import { SubagentService } from '../dist/services/subagent-service.js';
import { TaskService } from '../dist/services/task-service.js';
import { MemoryTaskRepository } from '../dist/services/platform/task-repository.js';

const failures = [];
function check(label, condition, detail = '') {
  console.log(`  ${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

const root = mkdtempSync(join(tmpdir(), 'pi-spike-caps-'));
const agentDir = join(root, 'agent');
const cwd = join(root, 'ws');
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, 'auth.json'), '{}\n');
writeFileSync(join(agentDir, 'models.json'), '{ "providers": {} }\n');

// 用户文件扩展：默认必须被发现（与 CLI 一致），极简模式必须不加载。
mkdirSync(join(agentDir, 'extensions', 'demo'), { recursive: true });
writeFileSync(
  join(agentDir, 'extensions', 'demo', 'index.ts'),
  `import { defineTool } from '@earendil-works/pi-coding-agent';
export default function demoExtension(pi) {
  pi.registerTool(defineTool({
    name: 'demo_ext_tool',
    label: 'demo',
    description: 'spike 用：用来观察用户文件扩展是否被加载',
    parameters: {},
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  }));
}
`,
);

const faux = fauxProvider();
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'),
  modelsPath: join(agentDir, 'models.json'),
  allowModelNetwork: false,
});
runtime.registerNativeProvider(faux.provider);
const model = { provider: faux.provider.id, modelId: faux.getModel().id };

// 与 app.ts 同构的装配（顺序也一致）。
const approvals = new ToolApprovalBroker();
const plans = new PlanModeService();
const tasks = new TaskService(new MemoryTaskRepository());
plans.setTaskService(tasks);
const questions = new QuestionBroker();
const subagents = new SubagentService({ agentDir });
const factory = new OriginalPiSessionFactory(
  agentDir,
  undefined,
  approvals,
  plans,
  undefined,
  undefined,
  undefined,
  questions,
  subagents,
);
factory.useRuntime(async () => runtime);
const registry = new AgentRegistry(factory, approvals, plans, undefined, undefined, questions);
subagents.attach({ registry, factory });

console.log('=== ① 默认会话：内联工具并入白名单 + 文件扩展加载 ===');
const normal = await registry.create({ cwd, ...model, toolNames: ['read', 'write'] });
const normalTools = normal.session.getActiveToolNames();
check(
  '计划工具已并入（propose_plan / submit_plan）',
  normalTools.includes('propose_plan') && normalTools.includes('submit_plan'),
  normalTools.join(','),
);
check('ask_user 已并入', normalTools.includes('ask_user'));
check('subagent 已并入（本次修复的缺口）', normalTools.includes('subagent'));
check('白名单里的内置工具仍在', normalTools.includes('read') && normalTools.includes('write'));
check('白名单未列出的文件扩展工具不可用（白名单语义不变）', !normalTools.includes('demo_ext_tool'));
check(
  '能力位默认全开',
  Object.values(normal.capabilities ?? {}).every((value) => value === true),
  JSON.stringify(normal.capabilities),
);

console.log('\n=== ② 极简会话：只剩 SDK 内置工具 ===');
const minimal = await registry.create({
  cwd,
  ...model,
  // 不传 toolNames = 不限制白名单（SDK 自己发现），极简模式靠"不注册"来收窄能力。
  mcpServers: [],
  extensions: {
    approval: false,
    planMode: false,
    questions: false,
    subagents: false,
    tasks: false,
    observability: false,
    fileExtensions: false,
  },
});
const minimalTools = minimal.session.getActiveToolNames();
check('不含计划工具', !minimalTools.includes('propose_plan'), minimalTools.join(','));
check('不含 ask_user', !minimalTools.includes('ask_user'));
check('不含 subagent', !minimalTools.includes('subagent'));
check('用户文件扩展未被加载（fileExtensions=false）', !minimalTools.includes('demo_ext_tool'));
check(
  'SDK 内置工具仍在',
  ['read', 'bash', 'edit', 'write'].every((name) => minimalTools.includes(name)),
  minimalTools.join(','),
);
check(
  '能力位全关（含 MCP）',
  Object.values(minimal.capabilities ?? {}).every((value) => value === false),
  JSON.stringify(minimal.capabilities),
);

console.log('\n=== ③ toolNames 缺省 = SDK 默认发现（不受能力开关影响）===');
const discovered = await registry.create({ cwd, ...model, extensions: { planMode: false } });
const discoveredTools = discovered.session.getActiveToolNames();
check('仍未并入计划工具', !discoveredTools.includes('propose_plan'));
check('subagent 仍然可用（开关未关）', discoveredTools.includes('subagent'));
check('用户文件扩展仍然加载（开关未关）', discoveredTools.includes('demo_ext_tool'));

await registry.close();
plans.dispose();
rmSync(root, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
  console.error(`❌ 预设能力开关验证失败：${failures.join('；')}`);
  process.exit(1);
}
console.log('✅ 预设能力开关验证通过：能力位真的改变了会话里注册的扩展与工具');
