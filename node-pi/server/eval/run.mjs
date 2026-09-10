// M4 评测：离线 golden set（fauxProvider 驱动真实管线）+ 可比较的指标。
//
// 中文说明：这不是「跑几个单测」，而是**契约冻结后的回归门禁**——
// 每个用例都走真实链路（PlanModeService 的工具 → TaskService → TaskRunner 的租约 →
// PlanView 投影），断言的是「系统对这段模型行为的处理是否正确」，不是模型聪不聪明。
// 模型换成脚本化响应，因此结果确定、可重复、不触网；指标变化就意味着契约或策略变了。
//
// 用法：npm run eval（CI 的 eval job 直接调用；失败即阻断）。
import { startHarness, fauxAssistantMessage, fauxToolCall, hasLegacyMarkers } from './harness.mjs';

/** 一段「模型行为」：先提交计划，再逐条汇报步骤完成。 */
function planScript(steps, completions) {
  return [
    fauxAssistantMessage([fauxToolCall('submit_plan', { title: '评测计划', steps })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('计划已提交，等待确认。'),
    ...completions.flatMap((completion) => [
      fauxAssistantMessage([fauxToolCall('complete_step', completion)], { stopReason: 'toolUse' }),
      fauxAssistantMessage('继续下一步。'),
    ]),
    fauxAssistantMessage('全部完成。'),
  ];
}

/**
 * golden set：每个用例给出「模型的脚本化行为」与「期望的系统行为」。
 * `pass` 返回 true 记为该任务成功（进入 pass@1 统计）。
 */
const CASES = [
  {
    id: 'simple-two-steps',
    title: '两步计划：提交 → 确认 → 逐条上报完成',
    steps: [{ title: '读现有实现' }, { title: '改工具契约' }],
    // 真实模型一轮通常只推进一步：用户/执行器会继续说「继续」。
    // 这里显式声明还要驱动一轮（第二次上报），而不是假设模型一口气跑完全部步骤。
    drive: 1,
    script: (steps) =>
      planScript(steps, [
        { stepId: 's1', evidence: { summary: '读完 plan-mode-service.ts' } },
        { stepId: 's2', evidence: { summary: '改成工具驱动，18 例测试通过' } },
      ]),
    async expect(context) {
      const plan = context.plans.state(context.sessionId);
      return {
        pass: plan.status === 'completed' && context.tasks.get(plan.taskId).status === 'completed',
        detail: `plan=${plan.status}`,
      };
    },
  },
  {
    id: 'command-verification-retry',
    title: '命令类验证：先给错退出码（被拒）→ 补齐真实证据',
    steps: [{ title: '跑测试', verification: { kind: 'command', command: 'npm test' } }],
    script: () => [
      fauxAssistantMessage(
        [
          fauxToolCall('submit_plan', {
            title: '评测计划',
            steps: [{ title: '跑测试', verification: { kind: 'command', command: 'npm test' } }],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('计划已提交。'),
      fauxAssistantMessage(
        [
          fauxToolCall('complete_step', {
            stepId: 's1',
            evidence: { summary: '跑过了', commands: [{ command: 'npm test', exitCode: 1 }] },
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall('complete_step', {
            stepId: 's1',
            evidence: { summary: '测试全绿', commands: [{ command: 'npm test', exitCode: 0 }] },
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('完成。'),
    ],
    async expect(context) {
      const plan = context.plans.state(context.sessionId);
      const rejected = context.seen.toolResults.filter((result) => result.isError);
      const step = context.tasks.get(plan.taskId).steps[0];
      return {
        pass:
          plan.status === 'completed' &&
          step.evidence?.commands?.[0]?.exitCode === 0 &&
          rejected.length === 1,
        detail: `plan=${plan.status} rejected=${rejected.length} exit=${
          step.evidence?.commands?.[0]?.exitCode ?? 'n/a'
        }`,
      };
    },
  },
  {
    id: 'file-verification-gate',
    title: '产物类验证：产物缺失被拒 → 人工补齐产物后继续',
    steps: [{ title: '产出迁移文件', verification: { kind: 'file', path: 'migration.sql' } }],
    script: () => [
      fauxAssistantMessage(
        [
          fauxToolCall('submit_plan', {
            title: '评测计划',
            steps: [
              { title: '产出迁移文件', verification: { kind: 'file', path: 'migration.sql' } },
            ],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('计划已提交。'),
      // 产物还没生成就上报完成 → 服务端必须拒绝。
      fauxAssistantMessage(
        [fauxToolCall('complete_step', { stepId: 's1', evidence: { summary: '写好了' } })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('产物还没生成，先停下。'),
    ],
    async expect(context) {
      const plan = context.plans.state(context.sessionId);
      const step = context.tasks.get(plan.taskId).steps[0];
      const rejected = context.seen.toolResults.some(
        (result) => result.isError && /产物不存在/.test(result.text),
      );
      return {
        pass: plan.status === 'executing' && step.status !== 'completed' && rejected,
        detail: `plan=${plan.status} step=${step.status} rejected=${rejected}`,
      };
    },
    /** 第二幕：补齐产物 → 续跑 → 完成。 */
    async then(context) {
      context.harness.writeArtifact('migration.sql', '-- migration');
      context.harness.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('complete_step', {
              stepId: 's1',
              evidence: { summary: '迁移文件已生成' },
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('完成。'),
      ]);
      await context.harness.plans.command(context.sessionId, 'resume');
      await context.harness.waitForSettle();
      const plan = context.harness.plans.state(context.sessionId);
      return { pass: plan.status === 'completed', detail: `afterResume=${plan.status}` };
    },
  },
  {
    id: 'blocked-step-asks-user',
    title: '阻塞：模型用 block_step 上报缺凭据 → 计划暂停而不是假装完成',
    steps: [{ title: '部署到生产', verification: { kind: 'manual' } }],
    script: () => [
      fauxAssistantMessage(
        [
          fauxToolCall('submit_plan', {
            title: '评测计划',
            steps: [{ title: '部署到生产', verification: { kind: 'manual' } }],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('计划已提交。'),
      fauxAssistantMessage(
        [
          fauxToolCall('block_step', {
            stepId: 's1',
            reason: '缺少生产环境凭据，需要用户提供',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('已上报阻塞，等你处理。'),
    ],
    async expect(context) {
      const plan = context.plans.state(context.sessionId);
      const task = context.tasks.get(plan.taskId);
      return {
        pass:
          plan.status === 'paused' &&
          plan.awaitingUserAction === true &&
          task.steps[0].blockedReason?.includes('凭据') === true,
        detail: `plan=${plan.status} blockedReason=${task.steps[0].blockedReason ?? 'none'}`,
      };
    },
  },
  {
    id: 'mid-plan-edit',
    title: '执行中改计划：update_plan 带当前 revision 修订后续步骤',
    steps: [{ title: '第一步' }, { title: '旧第二步' }],
    script: (steps) => planScript(steps, [{ stepId: 's1', evidence: { summary: '第一步做完' } }]),
    // 执行中改计划：revision 必须用**运行时**的当前值（这正是 eval 要验的契约）。
    async afterExecute(context) {
      const revision = context.plans.state(context.sessionId).revision;
      context.harness.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('update_plan', {
              revision,
              steps: [{ title: '第一步' }, { title: '新第二步' }],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('计划已更新。'),
      ]);
      await context.harness.plans.command(context.sessionId, 'resume');
      await context.harness.waitForSettle();
    },
    async expect(context) {
      const plan = context.plans.state(context.sessionId);
      const updated = plan.steps.map((step) => step.title).join(',');
      const errors = context.seen.toolResults
        .filter((result) => result.isError)
        .map((r) => r.text.slice(0, 160));
      return {
        pass: plan.status === 'executing' && updated === '第一步,新第二步',
        detail: `steps=${updated} status=${plan.status} revision=${plan.revision} errors=${errors.join(' | ')}`,
      };
    },
  },
  {
    id: 'stale-revision-rejected',
    title: '陈旧 revision：update_plan 用过期版本 → 被拒并提示当前版本',
    steps: [{ title: '第一步' }],
    script: () => [
      fauxAssistantMessage(
        [fauxToolCall('submit_plan', { title: '评测计划', steps: [{ title: '第一步' }] })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('计划已提交。'),
      fauxAssistantMessage([fauxToolCall('update_plan', { revision: 1, title: '偷偷改名' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('版本不对，我重读一下。'),
    ],
    async expect(context) {
      const plan = context.plans.state(context.sessionId);
      const rejected = context.seen.toolResults.some(
        (result) => result.isError && /revision 不匹配/.test(result.text),
      );
      return {
        pass: rejected && plan.title === '评测计划',
        detail: `rejected=${rejected} title=${plan.title}`,
      };
    },
  },
  {
    id: 'no-legacy-markers',
    title: '零标记：全程不写 Plan: 标题 / [DONE:n]，计划与进度仍完整',
    steps: [{ title: '一步就够' }],
    script: (steps) =>
      planScript(steps, [{ stepId: 's1', evidence: { summary: '做完了，附上证据' } }]),
    async expect(context) {
      const plan = context.plans.state(context.sessionId);
      return {
        pass: plan.status === 'completed' && !hasLegacyMarkers(context.seen.assistantText),
        detail: `plan=${plan.status} legacyMarkers=${hasLegacyMarkers(context.seen.assistantText)}`,
      };
    },
  },
];

async function runCase(definition) {
  const harness = await startHarness();
  const context = {
    harness,
    plans: harness.plans,
    tasks: harness.tasks,
    sessionId: harness.sessionId,
    seen: harness.seen,
  };
  try {
    harness.plans.startPlanning(harness.sessionId, `${definition.title}`);
    harness.faux.setResponses(definition.script(definition.steps));
    await harness.session.prompt(definition.title);
    await harness.waitForSettle();

    // 提交计划后统一走「用户确认执行」——这正是 golden set 要覆盖的主路径。
    let plan = harness.plans.state(harness.sessionId);
    let planAccepted = true;
    if (plan.status === 'proposed') {
      await harness.plans.command(harness.sessionId, 'execute');
      await harness.waitForSettle();
      plan = harness.plans.state(harness.sessionId);
    } else if (plan.status !== 'drafting') {
      planAccepted = false;
    }
    // 脚本里第一条 submit_plan 是否被接受（未被服务端拒绝过即为一次通过）。
    const rejectedSubmissions = harness.seen.toolResults.filter(
      (result) => result.isError && /submit_plan|update_plan/.test(result.text),
    ).length;
    const firstSubmitAccepted = rejectedSubmissions === 0;

    // 执行期驱动：模型一轮只推进一步时，继续发「继续执行」直到用例要求的轮数用完。
    const completedCount = (view) =>
      view.steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length;
    for (let turn = 0; turn < (definition.drive ?? 0); turn += 1) {
      const current = harness.plans.state(harness.sessionId);
      if (current.status !== 'executing') break;
      const before = completedCount(current);
      await harness.plans.command(harness.sessionId, 'resume');
      await harness.waitForSettle();
      if (completedCount(harness.plans.state(harness.sessionId)) === before) break;
    }
    if (definition.afterExecute !== undefined) await definition.afterExecute(context);

    let outcome = await definition.expect(context);
    if (definition.then !== undefined) {
      const second = await definition.then(context);
      outcome = {
        pass: outcome.pass && second.pass,
        detail: `${outcome.detail} | ${second.detail}`,
      };
    }
    const toolResults = harness.seen.toolResults;
    const errors = toolResults.filter((result) => result.isError).length;
    const task = context.tasks.get(plan.taskId);
    return {
      id: definition.id,
      title: definition.title,
      pass: outcome.pass,
      detail: outcome.detail,
      metrics: {
        planAccepted,
        firstSubmitAccepted,
        toolCalls: toolResults.length,
        toolErrors: errors,
        steps: task.steps.length,
        evidenceCoverage:
          task.steps.length === 0
            ? 0
            : task.steps.filter((step) => step.evidence !== undefined).length / task.steps.length,
        legacyMarkers: hasLegacyMarkers(harness.seen.assistantText),
      },
    };
  } finally {
    await harness.cleanup();
  }
}

const results = [];
for (const definition of CASES) {
  try {
    results.push(await runCase(definition));
  } catch (error) {
    results.push({
      id: definition.id,
      title: definition.title,
      pass: false,
      detail: `运行失败：${error instanceof Error ? error.message : String(error)}`,
      metrics: {
        planAccepted: false,
        firstSubmitAccepted: false,
        toolCalls: 0,
        toolErrors: 0,
        steps: 0,
        evidenceCoverage: 0,
        legacyMarkers: false,
      },
    });
  }
}

const passed = results.filter((result) => result.pass).length;
const total = results.length;
const ratio = (pick) =>
  results.length === 0
    ? 0
    : results.reduce((sum, item) => sum + (pick(item.metrics) ? 1 : 0), 0) / results.length;
const mean = (pick) =>
  results.length === 0
    ? 0
    : results.reduce((sum, item) => sum + pick(item.metrics), 0) / results.length;
const toolCalls = results.reduce((sum, item) => sum + item.metrics.toolCalls, 0);
const toolErrors = results.reduce((sum, item) => sum + item.metrics.toolErrors, 0);

/** 门禁阈值：确定性 golden set 不允许退化（模型换成脚本，因此失败＝契约/策略变了）。 */
const THRESHOLDS = [
  { name: 'pass@1', value: (passed / total) * 100, min: 100 },
  { name: '计划一次通过率', value: ratio((m) => m.firstSubmitAccepted) * 100, min: 80 },
  {
    name: '零残留旧标记',
    value: results.every((item) => !item.metrics.legacyMarkers) ? 100 : 0,
    min: 100,
  },
];

console.log('=== M4 golden set（fauxProvider 离线，真实管线）===');
for (const result of results) {
  console.log(`  ${result.pass ? '✅' : '❌'} ${result.id.padEnd(28)} ${result.detail}`);
}
console.log('');
console.log(
  `  评测任务成功率 pass@1          : ${((passed / total) * 100).toFixed(1)}%  (${passed}/${total})`,
);
console.log(
  `  计划一次通过率（首交即接受）   : ${(ratio((m) => m.firstSubmitAccepted) * 100).toFixed(1)}%`,
);
console.log(
  `  工具调用失败率（含刻意拒绝）   : ${((toolErrors / Math.max(1, toolCalls)) * 100).toFixed(1)}%  (${toolErrors}/${toolCalls})`,
);
console.log(
  `  平均步骤证据覆盖率             : ${(mean((m) => m.evidenceCoverage) * 100).toFixed(1)}%`,
);
console.log(
  `  残留旧标记的用例数             : ${results.filter((item) => item.metrics.legacyMarkers).length}`,
);
console.log('');
for (const threshold of THRESHOLDS) {
  console.log(
    `  ${threshold.value >= threshold.min ? '✅' : '❌'} 门禁 ${threshold.name}: ${threshold.value.toFixed(1)}% (≥ ${threshold.min}%)`,
  );
}

const failedThresholds = THRESHOLDS.filter((threshold) => threshold.value < threshold.min);
if (passed !== total || failedThresholds.length > 0) {
  console.error(
    `\n❌ golden set 未通过（${passed}/${total}，未达标门禁 ${failedThresholds.length} 项）`,
  );
  process.exit(1);
}
console.log('\n✅ golden set 全部通过');
