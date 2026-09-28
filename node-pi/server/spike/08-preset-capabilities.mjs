// M6: 预设能力开关 + 「极简（原版 pi）」模式（真实 SDK + 真实装配；离线、临时目录）。
//
// 验证七件事（都是"接线是否真的通了"，不是纯单测能覆盖的）：
//   ① 默认会话：内联扩展注册的工具（plan_* / ask_user / subagent）会并入工具白名单。
//      白名单是**可用集**：漏并 subagent 会让「带预设的会话」里该工具直接 not found。
//   ② 极简会话（extensions 全 false + mcpServers: []）：只剩 SDK 内置工具。
//   ③ fileExtensions=false 时，用户装在 `~/.pi/agent/extensions/` 的文件扩展不再加载
//      （本 spike 自己在临时 agentDir 里造一个扩展来证明这一点）。
//   ④ 会话能力位（capabilities）与开关一致，可直接给前端用。
//   ⑤ **重开不放大**：极简会话跑完一轮、离开注册表之后从磁盘重新打开，能力开关、
//      工具白名单、系统提示词必须原样恢复（缺陷现场：以前 open() 写死按「全开」重建，
//      于是面板里凭空出现 MCP 工具 + 用户自加扩展 + plan/subagent，模型也能真的调它们）。
//   ⑥ 自定义预设重开：工具白名单与系统提示词不丢。
//   ⑦ 没有配置条目的会话（CLI 建的 / 全缺省创建）仍然按「全开」恢复（旧会话不受影响）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
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

console.log('\n=== ④ 极简会话离开注册表后从磁盘重开：能力不被放大 ===');
// 模拟真实触发点：prompt 结束后会话被移出内存（服务重启 / 面板打开信息面板 / SSE 重连
// 都会先走 open()）。修复前这里会按「全开」重建，MCP + 用户扩展 + plan/subagent 全回来。
faux.setResponses([fauxAssistantMessage('好的。')]);
await minimal.session.prompt('你好');
const minimalId = minimal.session.sessionId;
await registry.remove(minimalId);
const reopenedMinimal = await registry.open(minimalId);
const reopenedMinimalTools = reopenedMinimal.session.getActiveToolNames();
check(
  '重开不含内联工具（plan / ask_user / subagent）',
  ['propose_plan', 'submit_plan', 'ask_user', 'subagent'].every(
    (name) => !reopenedMinimalTools.includes(name),
  ),
  reopenedMinimalTools.join(','),
);
check(
  '重开仍不加载用户文件扩展（fileExtensions=false 落盘生效）',
  !reopenedMinimalTools.includes('demo_ext_tool'),
);
check(
  '重开能力位仍全关（含 MCP）',
  Object.values(reopenedMinimal.capabilities ?? {}).every((value) => value === false),
  JSON.stringify(reopenedMinimal.capabilities),
);
check(
  '重开 SDK 内置工具仍在',
  ['read', 'bash', 'edit', 'write'].every((name) => reopenedMinimalTools.includes(name)),
);
check(
  '重开仍在同一个会话 id 上（没有另建会话）',
  reopenedMinimal.session.sessionId === minimalId,
  reopenedMinimal.session.sessionId,
);

console.log('\n=== ⑤ 自定义预设重开：工具白名单与系统提示词不丢 ===');
const custom = await registry.create({
  cwd,
  ...model,
  toolNames: ['read'],
  systemPrompt: 'You are terse.',
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
check(
  '创建时白名单生效',
  custom.session.getActiveToolNames().join(',') === 'read',
  custom.session.getActiveToolNames().join(','),
);
// 注意：SDK 的会话文件在第一条消息落盘时才真正写盘（model_change / custom 条目先在内存里），
// 所以这里跑一轮再重开——真实 Web 会话也是「创建即带一条 prompt」的。
faux.setResponses([fauxAssistantMessage('好的。')]);
await custom.session.prompt('你好');
const customId = custom.session.sessionId;
await registry.remove(customId);
const reopenedCustom = await registry.open(customId);
const reopenedCustomTools = reopenedCustom.session.getActiveToolNames();
check(
  '重开后白名单仍是 read（没有放开成全部工具）',
  reopenedCustomTools.join(',') === 'read',
  reopenedCustomTools.join(','),
);
check(
  '重开后系统提示词仍在',
  (reopenedCustom.session.systemPrompt ?? '').includes('You are terse.'),
  (reopenedCustom.session.systemPrompt ?? '').slice(0, 60),
);

console.log('\n=== ⑥ 没有配置条目的会话（CLI 建的 / 全缺省创建）仍按全开恢复 ===');
// 不能因为这次修复而把旧会话关小：没有配置条目就是「缺省 = 全开」，与改动前一致。
// 顺手验证了另一半：全缺省创建时不写配置条目（少写一行噪声）。
const legacy = await registry.create({ cwd, ...model });
faux.setResponses([fauxAssistantMessage('好的。')]);
await legacy.session.prompt('你好');
const legacyId = legacy.session.sessionId;
await registry.remove(legacyId);
const reopenedLegacy = await registry.open(legacyId);
check(
  '缺少配置条目时能力位全开（与改动前一致）',
  Object.values(reopenedLegacy.capabilities ?? {}).every((value) => value === true),
  JSON.stringify(reopenedLegacy.capabilities),
);
const reopenedLegacyTools = reopenedLegacy.session.getActiveToolNames();
check(
  '缺少配置条目时不限制白名单：用户文件扩展照常加载',
  reopenedLegacyTools.includes('demo_ext_tool'),
);
check(
  '缺少配置条目时不限制白名单：内联工具照常注册（subagent）',
  reopenedLegacyTools.includes('subagent'),
);

await registry.close();
plans.dispose();
rmSync(root, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
  console.error(`❌ 预设能力开关验证失败：${failures.join('；')}`);
  process.exit(1);
}
console.log('✅ 预设能力开关验证通过：能力位真的改变了会话里注册的扩展与工具');
