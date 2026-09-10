// M0-⑥: 端到端验证两个修复（用真实 SDK + 真实 AgentRegistry + 真实 PlanModeService）
//   [修复 A] register() 派发 session_start —— 修复前 plan 命令永远 409 plan_unavailable
//   [修复 B] context 钩子清理陈旧 plan 上下文 —— 修复前 web-plan-context 无上限累积
// M4 更新：计划改由工具产出（submit_plan）、状态存在任务库里，因此这里注入真实
// TaskService（内存仓储），并用 plan_start / plan_abandon 取代 enable / disable。
// 离线、临时目录，不触网、不碰真实 ~/.pi/agent。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import {
  ModelRuntime,
  createAgentSession,
  SessionManager,
  DefaultResourceLoader,
} from '@earendil-works/pi-coding-agent';
import { AgentRegistry, dropInlineOwnedExtensions } from '../dist/services/agent-registry.js';
import { PlanModeService } from '../dist/services/plan-mode-service.js';
import { TaskService } from '../dist/services/task-service.js';
import { MemoryTaskRepository } from '../dist/services/platform/task-repository.js';

const root = mkdtempSync(join(tmpdir(), 'pi-spike-start-'));
const agentDir = join(root, 'agent');
const cwd = join(root, 'ws');
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, 'auth.json'), '{}\n');
writeFileSync(join(agentDir, 'models.json'), '{ "providers": {} }\n');

const faux = fauxProvider();
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'),
  modelsPath: join(agentDir, 'models.json'),
  allowModelNetwork: false,
});
runtime.registerNativeProvider(faux.provider);
const model = runtime.getModel(faux.provider.id, faux.getModel().id);

const plans = new PlanModeService();
plans.setListener(() => undefined);
// M4：计划就是 origin='plan' 的任务，没有任务服务扩展工厂会直接失败。
const tasks = new TaskService(new MemoryTaskRepository());
plans.setTaskService(tasks);
let sessionManager;

/**
 * 探针扩展：注册在 plan 扩展**之后**，因此它的 context 处理器看到的是
 * plan 扩展过滤后的消息列表（SDK 的钩子链按注册顺序串行传递）。
 */
const PLAN_TYPES = new Set(['web-plan-context', 'web-plan-execution-context', 'web-plan-execute']);
const probeState = { lastPlanningCount: -1, lastNormalCount: -1, calls: 0 };
function contextProbe(pi) {
  pi.on('context', (event) => {
    probeState.calls++;
    const planMessages = event.messages.filter((m) => PLAN_TYPES.has(m.customType));
    const status = plans.state(sessionManager.getSessionId()).status;
    if (status === 'drafting' || status === 'proposed') {
      probeState.lastPlanningCount = planMessages.length;
    } else {
      probeState.lastNormalCount = planMessages.length;
    }
    return undefined;
  });
}

/** 复刻 OriginalPiSessionFactory.create() 的关键部分，注入真实内联扩展。 */
const factory = {
  async create(input) {
    const loader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir,
      extensionFactories: [plans.buildExtension(), contextProbe],
      extensionsOverride: (base) => dropInlineOwnedExtensions(base).result,
    });
    await loader.reload();
    sessionManager = SessionManager.create(input.cwd, join(agentDir, 'sessions'));
    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      sessionManager,
      resourceLoader: loader,
      tools: [],
      thinkingLevel: 'off',
    });
    return session;
  },
};

const registry = new AgentRegistry(factory, undefined, plans);
const entry = await registry.create({ cwd });
const sessionId = entry.session.sessionId;

// ── 修复 A：session_start 是否真的派发 ──────────────────────────────────────
console.log('=== 修复 A：session_start 派发 ===');
console.log(`  注册表 planState 初始值: ${JSON.stringify(registry.planState(sessionId))}`);
let startError;
try {
  await registry.command(sessionId, { type: 'plan_start', message: '规划一下这个需求' });
} catch (error) {
  startError = error;
}
if (startError) {
  console.log(`  ❌ plan_start 失败: ${startError.code ?? startError.message}`);
} else {
  console.log('  ✅ plan_start 成功（修复前会抛 409 plan_unavailable）');
  console.log(`     planState 现在: ${JSON.stringify(registry.planState(sessionId))}`);
  console.log(
    `     计划已落库为任务: ${tasks
      .list({ sessionId })
      .map((task) => task.id)
      .join(', ')}`,
  );
}

// ── 修复 B：多轮规划后 plan 上下文是否清理干净 ─────────────────────────────
console.log('\n=== 修复 B：陈旧 plan 上下文清理 ===');
faux.setResponses([fauxAssistantMessage('先看看代码结构')]);
await entry.session.prompt('规划一下');
faux.setResponses([fauxAssistantMessage('方案讨论中')]);
await entry.session.prompt('继续讨论');
faux.setResponses([fauxAssistantMessage('再讨论一轮')]);
await entry.session.prompt('再继续');
await registry.command(sessionId, { type: 'plan_abandon' });
faux.setResponses([fauxAssistantMessage('已退出规划')]);
await entry.session.prompt('好了不规划了');

const entries = readFileSync(sessionManager.getSessionFile(), 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => JSON.parse(line));
const written = entries.filter((e) => e.customType === 'web-plan-context').length;

console.log(`  JSONL 里写入过的 web-plan-context 条目（审计痕迹，应该保留）: ${written}`);
console.log(`  测到的 context 钩子调用次数: ${probeState.calls}`);
console.log(`  规划期：模型实际收到的 plan 注入消息数: ${probeState.lastPlanningCount}（应为 1）`);
console.log(`  退出后：模型实际收到的 plan 注入消息数: ${probeState.lastNormalCount}（应为 0）`);
console.log(
  probeState.lastPlanningCount === 1 && probeState.lastNormalCount === 0
    ? '  ✅ 修复生效：JSONL 保留审计痕迹，但模型上下文已按模式清理干净'
    : '  ❌ 过滤未生效',
);

console.log('\n=== 最终 planState ===');
console.log(`  ${JSON.stringify(registry.planState(sessionId))}`);

await registry.close();
plans.dispose();
rmSync(root, { recursive: true, force: true });
