// M4-⑦: 端到端验证「模型零标记完成 规划 → 确认 → 执行 → 完成」。
//
// 与 M0 的 spike 一样，用真实 SDK + 真实 AgentRegistry + 真实 PlanModeService / TaskRunner，
// 只把模型换成 fauxProvider（脚本化响应），全程离线、临时目录，不碰真实 ~/.pi/agent。
// 装配与 eval 共用 eval/harness.mjs（避免「评测里跑通的路径和这里不是同一条」）。
//
// 这个 spike 是 M4 的核心验收：模型**从不输出** `Plan:` 标题、编号列表或 `[DONE:n]`，
// 计划与推进全部通过工具调用完成，且服务端会校验步骤证据。
import { startHarness, fauxAssistantMessage, fauxToolCall } from '../eval/harness.mjs';

const failures = [];
function check(label, condition, detail = '') {
  console.log(`  ${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

// 预设白名单（SDK 的 tools 是可用工具白名单，harness 会并入内联扩展的工具名）。
const h = await startHarness({ toolNames: ['read', 'write', 'edit', 'bash'] });
const { session, sessionId, plans, tasks, faux, seen, waitForSettle } = h;
// 会话创建时的工具列表：后面要断言「整个计划生命周期一字未变」（缓存前缀稳定）。
const activeBeforePlan = session.getActiveToolNames?.() ?? [];

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
await session.prompt('规划一下这个重构');

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
check(
  '规划期工具列表没变（不因开关计划而失效缓存）',
  JSON.stringify([...(session.getActiveToolNames?.() ?? [])].sort()) ===
    JSON.stringify([...activeBeforePlan].sort()),
  session.getActiveToolNames?.().join(','),
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
const activeDuringExecution = session.getActiveToolNames?.() ?? [];
check(
  '执行期计划工具仍激活（模型要继续 update_plan / complete_step）',
  ['submit_plan', 'update_plan', 'complete_step', 'block_step'].every((name) =>
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
  tasks.get(plan.taskId).execution.lease !== undefined,
  `owner=${tasks.get(plan.taskId).execution.lease?.owner}`,
);
await waitForSettle();

const afterRun = tasks.get(plan.taskId);
const step = (id) => afterRun.steps.find((item) => item.id === id);
check('退出码不符的证据被拒绝后补齐（s1 完成且证据是真的那条）', step('s1').status === 'completed');
check('被拒绝过的那次没有写进状态', step('s1').evidence?.commands?.[0]?.exitCode === 0);
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
h.writeArtifact('migration.sql', '-- migration');
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

// ── ④ 计划结束后：工具集一字不变（缓存前缀稳定）────────────────────────────
// 旧实现在这里「收回计划工具」，代价是请求最前面的 tools 数组＋system prompt 变化，
// 整段前缀缓存当场失效。现在工具集在会话生命周期内恒定，规划期只读靠 tool_call 拦截。
console.log('\n=== ④ 计划结束后工具集不变（缓存前缀稳定）===');
const activeAfter = session.getActiveToolNames?.() ?? [];
check(
  '计划完成后计划工具仍在列表（不再增删工具，避免前缀缓存失效）',
  activeAfter.includes('submit_plan') && activeAfter.includes('complete_step'),
  activeAfter.join(','),
);
check(
  '写工具保持可用',
  activeAfter.includes('edit') && activeAfter.includes('write'),
  activeAfter.join(','),
);
// 提问通道（M4.1）不属于 Plan：计划结束后依然可用。
check(
  'ask_user 仍在（提问通道独立于 Plan）',
  activeAfter.includes('ask_user'),
  activeAfter.join(','),
);

// ── ⑤ 放弃计划：记录保留、工具集不变 ─────────────────────────────────────
console.log('\n=== ⑤ 放弃计划：记录保留（可查）===');
const second = plans.startPlanning(sessionId, '再规划一个后续计划');
const activeDuring = session.getActiveToolNames?.() ?? [];
check(
  '新计划进入规划期：工具集不变（写工具仍在列表，调用时被拦）',
  activeDuring.includes('edit') && activeDuring.includes('submit_plan'),
  activeDuring.join(','),
);
// 规划期真的写不了：tool_call 拦截（这才是只读的兑现点）。
check(
  '规划期写操作被拦截（edit 的 tool_call 被 block）',
  plans.session(sessionId)?.onToolCall({ toolName: 'edit', toolCallId: 'spike-1', input: {} })
    ?.block === true,
);
await plans.command(sessionId, 'abandon');
check('放弃后任务仍是可查的记录（cancelled）', tasks.get(second.taskId).status === 'cancelled');
const activeAfterAbandon = session.getActiveToolNames?.() ?? [];
check(
  '放弃后工具集与规划前完全一致（没有任何增删）',
  JSON.stringify([...activeAfterAbandon].sort()) === JSON.stringify([...activeBeforePlan].sort()),
  `before=${activeBeforePlan.join(',')} after=${activeAfterAbandon.join(',')}`,
);
check(
  '放弃后 ask_user 仍在（它不属于计划）',
  activeAfterAbandon.includes('ask_user'),
  activeAfterAbandon.join(','),
);

// ── ⑥ propose_plan：模型提议、用户拍板 ───────────────────────────────────
// 真实运行时里的关键风险点：工具要能挂起等用户回答（走提问通道），回答后真开启规划，
// 而且即使工具列表不变，规划期的写操作依然写不进去（拦在 tool_call）。
console.log('\n=== ⑥ propose_plan：模型提议 → 用户同意 → 只读规划期 ===');
faux.setResponses([
  fauxAssistantMessage(
    [fauxToolCall('propose_plan', { goal: '把缓存前缀失效的问题修掉', reason: '改动面大' })],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage('好，我先把方案理清楚。'),
]);
const prompted = session.prompt('这个改动挺大，要不要先规划？');
// 工具挂起等回答：轮询到挂起项后，模拟用户在弹窗里选「先规划」。
const pendingQuestion = await (async () => {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const found = h.questions.pendingForSession(sessionId);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('propose_plan 没有挂起提问（提问通道未接到）');
})();
check('propose_plan 挂起并推出一条待回答提问', pendingQuestion.questions[0]?.id === 'plan-mode');
h.questions.answer(sessionId, pendingQuestion.questionId, {
  answers: [{ id: 'plan-mode', selected: ['先规划'] }],
});
await prompted;
const proposed = plans.state(sessionId);
check(
  '用户同意后真的开了计划（drafting）',
  proposed.status === 'drafting',
  `status=${proposed.status}`,
);
check(
  '计划目标来自工具参数',
  proposed.goal === '把缓存前缀失效的问题修掉',
  `goal=${proposed.goal}`,
);
check(
  '提议后进入只读：edit 依然被拦（工具没从列表里拿掉也写不进去）',
  plans.session(sessionId)?.onToolCall({ toolName: 'edit', toolCallId: 'spike-2', input: {} })
    ?.block === true,
);

await h.cleanup();

console.log('');
if (failures.length > 0) {
  console.error(`❌ M4 端到端验证失败：${failures.join('；')}`);
  process.exit(1);
}
console.log('✅ M4 端到端通过：模型零标记完成「规划 → 确认 → 执行 → 完成」，证据由服务端校验');
