// M4-⑦: 端到端验证「模型零标记完成 规划 → 确认 → 执行 → 完成」。
//
// 与 M0 的 spike 一样，用真实 SDK + 真实 AgentRegistry + 真实 PlanModeService / TaskRunner，
// 只把模型换成 fauxProvider（脚本化响应），全程离线、临时目录，不碰真实 ~/.pi/agent。
//
// 这个 spike 是 M4 的核心验收：模型**从不输出** `Plan:` 标题、编号列表或 `[DONE:n]`，
// 计划与推进全部通过工具调用完成，且服务端会校验步骤证据。
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
import { AgentRegistry, dropInlineOwnedExtensions } from '../dist/services/agent-registry.js';
import { PlanModeService } from '../dist/services/plan-mode-service.js';
import { TaskService } from '../dist/services/task-service.js';
import { MemoryTaskRepository } from '../dist/services/platform/task-repository.js';
import { TaskRecoveryService } from '../dist/services/task-recovery.js';
import { TaskInFlightTracker } from '../dist/services/task-recovery-extension.js';
import { TaskRunner } from '../dist/services/task-runner.js';
import { PLAN_TOOL_NAMES } from '../dist/services/plan-tools.js';

const root = mkdtempSync(join(tmpdir(), 'pi-spike-plan-'));
const agentDir = join(root, 'agent');
const cwd = join(root, 'ws');
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, 'auth.json'), '{}\n');
writeFileSync(join(agentDir, 'models.json'), '{ "providers": {} }\n');

const failures = [];
function check(label, condition, detail = '') {
  console.log(`  ${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

const faux = fauxProvider();
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'),
  modelsPath: join(agentDir, 'models.json'),
  allowModelNetwork: false,
});
runtime.registerNativeProvider(faux.provider);
const model = runtime.getModel(faux.provider.id, faux.getModel().id);

// ── 与 app.ts 同构的装配（计划 = 任务 + 工具 + 执行器）───────────────────────
const tasks = new TaskService(new MemoryTaskRepository());
const plans = new PlanModeService();
plans.setTaskService(tasks);
plans.setListener(() => undefined);
const owner = 'spike-owner';
const recovery = new TaskRecoveryService(tasks, { owner });
let sessionManager;
let runner;
const tracker = new TaskInFlightTracker(tasks, {
  lookupActiveTask: (sessionId) => registry.get(sessionId)?.activeTaskId,
  onSettled: (sessionId) => runner?.handleSettled(sessionId),
});

const factory = {
  async create(input) {
    const loader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir,
      extensionFactories: [plans.buildExtension(), tracker.buildExtension()],
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
      tools: [...PLAN_TOOL_NAMES, 'read', 'write', 'edit', 'bash'],
      thinkingLevel: 'off',
    });
    return session;
  },
};

const registry = new AgentRegistry(factory, undefined, plans);
runner = new TaskRunner({ tasks, recovery, registry, tracker, owner });
plans.setExecutor(runner);

const entry = await registry.create({ cwd });
const sessionId = entry.session.sessionId;

/**
 * 等一次 run 结算（registry.command 不 await 模型，与 HTTP 202 语义一致）。
 * 用计数器而不是「订阅后等下一个事件」：subscribe 会同步重放历史事件，
 * 直接在回调里解引用取消函数会撞上 TDZ。
 */
let settleCount = 0;
let consumed = 0;
registry.subscribe(sessionId, 0, (event) => {
  if (event.payload?.type === 'agent_settled') settleCount += 1;
});
function waitForSettle() {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (settleCount > consumed) {
        consumed += 1;
        clearInterval(timer);
        resolve();
      }
    }, 5);
    timer.unref?.();
    setTimeout(() => clearInterval(timer), 15_000).unref?.();
  });
}

const seen = { toolResults: [], assistantText: [] };
entry.session.subscribe((event) => {
  if (event.type === 'tool_execution_end') {
    seen.toolResults.push({
      toolName: event.toolName,
      isError: event.isError,
      text: JSON.stringify(event.result?.content ?? '').slice(0, 200),
    });
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const text = (event.message.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    if (text.trim()) seen.assistantText.push(text);
  }
});

// ── ① 规划：模型只调用 submit_plan，不写任何标记 ────────────────────────────
console.log('=== ① 规划期：submit_plan（模型零标记）===');
plans.startPlanning(sessionId, '重构 Plan 模式：把正则解析换成结构化工具契约');
faux.setResponses([
  fauxAssistantMessage(
    [
      fauxToolCall('submit_plan', {
        title: '重构 Plan 模式',
        steps: [
          { title: '跑一遍测试基线', verification: { kind: 'command', command: 'npm test' } },
          // 产物先不存在：用于验证「证据不足会被拒绝」。
          { title: '产出迁移文件', verification: { kind: 'file', path: 'migration.sql' } },
          { title: '更新文档' },
        ],
      }),
    ],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage('计划已提交，等你确认后开始执行。'),
]);
await entry.session.prompt('规划一下这个重构');

let plan = plans.state(sessionId);
check('计划已进入 proposed（等待确认）', plan.status === 'proposed', `status=${plan.status}`);
check('步骤来自 submit_plan 的结构化参数', plan.steps.length === 3, `steps=${plan.steps.length}`);
check(
  'verification 被原样保存',
  plan.steps[1].verification?.kind === 'file' &&
    plan.steps[1].verification?.path === 'migration.sql',
);
check('awaitingUserAction 提示面板要用户确认', plan.awaitingUserAction === true);
const task = tasks.get(plan.taskId);
check('计划就是 origin=plan 的任务', task.origin === 'plan' && task.sessionId === sessionId);
check(
  '规划期写操作被拦住（模型这轮没有写文件）',
  !seen.toolResults.some((result) => result.toolName === 'write' || result.toolName === 'edit'),
);

// ── ② 确认执行：服务端校验状态并取租约 ─────────────────────────────────────
console.log('\n=== ② 确认执行：plan_execute → 租约 + 绑定会话 ===');
faux.setResponses([
  // 第一步：命令类验证，证据给错 → 服务端必须拒绝。
  fauxAssistantMessage(
    [
      fauxToolCall('complete_step', {
        stepId: 's1',
        evidence: { summary: '测试跑过了', commands: [{ command: 'npm test', exitCode: 1 }] },
      }),
    ],
    { stopReason: 'toolUse' },
  ),
  // 第二步：补齐真实证据 → 通过。
  fauxAssistantMessage(
    [
      fauxToolCall('complete_step', {
        stepId: 's1',
        evidence: { summary: '测试全绿', commands: [{ command: 'npm test', exitCode: 0 }] },
      }),
    ],
    { stopReason: 'toolUse' },
  ),
  // 第三步：产物还不存在 → 被拒绝。
  fauxAssistantMessage(
    [fauxToolCall('complete_step', { stepId: 's2', evidence: { summary: '迁移文件写好了' } })],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage('产物还没生成，先停下等你处理。'),
]);
const executing = await plans.command(sessionId, 'execute');
check('计划进入 executing', executing.status === 'executing', `status=${executing.status}`);
const activeDuringExecution = entry.session.getActiveToolNames?.() ?? [];
check(
  '执行期计划工具仍激活（模型要继续 update_plan / complete_step）',
  ['submit_plan', 'update_plan', 'complete_step', 'block_step', 'ask_user'].every((name) =>
    activeDuringExecution.includes(name),
  ),
  activeDuringExecution.join(','),
);
check(
  '执行期写工具已放行',
  activeDuringExecution.includes('edit') && activeDuringExecution.includes('write'),
  activeDuringExecution.join(','),
);
check(
  '执行器取得租约（防双跑）',
  tasks.get(plan.taskId).execution.lease?.owner === owner,
  `owner=${tasks.get(plan.taskId).execution.lease?.owner}`,
);
await waitForSettle();

const afterRun = tasks.get(plan.taskId);
const step = (id) => afterRun.steps.find((item) => item.id === id);
check('退出码不符的证据被拒绝（s1 仍未完成）', step('s1').status === 'completed');
check(
  '被拒绝过的那次没有写进状态（证据是真的那条）',
  step('s1').evidence?.commands?.[0]?.exitCode === 0,
);
check('产物不存在时 complete_step 报错', step('s2').status !== 'completed');
const rejected = seen.toolResults.filter((result) => result.isError);
check(
  '服务端确实返回了两次工具错误（证据不符 + 产物缺失）',
  rejected.length === 2,
  `${rejected.length} 次`,
);
check(
  '错误信息是可照做的（含期望退出码 / 产物路径）',
  rejected.some((result) => /期望 0/.test(result.text)) &&
    rejected.some((result) => /产物不存在/.test(result.text)),
);

// ── ③ 产物补齐后继续：计划跑到完成 ──────────────────────────────────────────
console.log('\n=== ③ 补齐产物后继续执行到完成 ===');
writeFileSync(join(cwd, 'migration.sql'), '-- migration\n');
faux.setResponses([
  fauxAssistantMessage(
    [fauxToolCall('complete_step', { stepId: 's2', evidence: { summary: '迁移文件已生成' } })],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage(
    [fauxToolCall('complete_step', { stepId: 's3', evidence: { summary: '文档已更新' } })],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage('三步都完成了。'),
]);
await plans.command(sessionId, 'resume');
await waitForSettle();

const finished = plans.state(sessionId);
check('计划完成', finished.status === 'completed', `status=${finished.status}`);
check('任务完成（状态由步骤聚合）', tasks.get(plan.taskId).status === 'completed');
check(
  '每一步都有证据',
  tasks.get(plan.taskId).steps.every((item) => item.evidence !== undefined),
);
check(
  '模型全程没有输出任何计划标记（Plan: / [DONE:n]）',
  !seen.assistantText.some((text) => /(^|\n)\s*#{0,6}\s*\**\s*(Plan|计划)\s*[:：]/i.test(text)) &&
    !seen.assistantText.some((text) => /\[DONE:\d+\]/i.test(text)),
);

// ── ④ 工具权限：规划期只读、执行期放行 ──────────────────────────────────────
console.log('\n=== ④ 计划结束后收回计划工具 ===');
const activeAfter = entry.session.getActiveToolNames?.() ?? [];
check(
  '计划完成后不再挂计划工具（不留「随时新建计划」的入口）',
  !activeAfter.includes('submit_plan') && !activeAfter.includes('complete_step'),
  activeAfter.join(','),
);
check(
  '写工具保持可用',
  activeAfter.includes('edit') && activeAfter.includes('write'),
  activeAfter.join(','),
);

// ── ⑤ 放弃计划：记录保留、工具差集撤销 ─────────────────────────────────────
console.log('\n=== ⑤ 放弃计划：记录保留（可查）===');
const second = plans.startPlanning(sessionId, '再规划一个后续计划');
const activeDuring = entry.session.getActiveToolNames?.() ?? [];
check('新计划进入规划期：写工具被关掉', !activeDuring.includes('edit'), activeDuring.join(','));
await plans.command(sessionId, 'abandon');
check('放弃后任务仍是可查的记录（cancelled）', tasks.get(second.taskId).status === 'cancelled');
const activeAfterAbandon = entry.session.getActiveToolNames?.() ?? [];
check(
  '放弃后写工具恢复、计划工具收回',
  activeAfterAbandon.includes('edit') && !activeAfterAbandon.includes('submit_plan'),
  activeAfterAbandon.join(','),
);

await registry.close();
plans.dispose();
tasks.dispose();
rmSync(root, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
  console.error(`❌ M4 端到端验证失败：${failures.join('；')}`);
  process.exit(1);
}
console.log('✅ M4 端到端通过：模型零标记完成「规划 → 确认 → 执行 → 完成」，证据由服务端校验');
