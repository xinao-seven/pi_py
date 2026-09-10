// M4 评测：离线 golden set（fauxProvider 驱动真实管线）+ 可比较的指标。
//
// 中文说明：这不是「跑几个单测」，而是**契约冻结后的回归门禁**——
// 每个用例都走真实链路（PlanModeService 的工具 → TaskService → TaskRunner 的租约 →
// PlanView 投影），断言的是「系统对这段模型行为的处理是否正确」，不是模型聪不聪明。
// 模型换成脚本化响应，因此结果确定、可重复、不触网；指标变化就意味着契约或策略变了。
//
// 用法：npm run eval（CI 的 eval job 直接调用；失败即阻断）。
import {
  startHarness,
  scriptedResponses,
  fauxAssistantMessage,
  fauxToolCall,
  hasLegacyMarkers,
} from './harness.mjs';

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
    id: 'ask-user-roundtrip',
    title: '提问往返：模型用 ask_user 问一句 → 用户在选择后回答 → 模型带着答案继续',
    steps: [{ title: '按用户选择实施' }],
    script: () => [
      fauxAssistantMessage(
        [fauxToolCall('submit_plan', { title: '评测计划', steps: [{ title: '按用户选择实施' }] })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('计划已提交。'),
      // 执行期提问：工具会挂起整个 run，直到用户回答。
      fauxAssistantMessage(
        [
          fauxToolCall('ask_user', {
            questions: [
              {
                id: 'deploy',
                question: '这次要一并部署到生产吗？',
                options: ['部署', '先不部署'],
              },
            ],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      // 拿到答案后按答案完成步骤（把答案写进证据里，便于断言答案真的回流了）。
      fauxAssistantMessage(
        [
          fauxToolCall('complete_step', {
            stepId: 's1',
            evidence: { summary: '用户选择：先不部署；已按此实施' },
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('完成。'),
    ],
    /** run 被提问挂起：像前端那样轮询到挂起问题并回答。 */
    async whileExecuting(context) {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const pending = context.harness.questions.pendingForSession(context.sessionId);
        if (pending !== undefined) {
          const first = pending.questions[0];
          await context.harness.plans.state; // 保持与真实前端一致的异步节奏
          context.harness.questions.answer(context.sessionId, pending.questionId, {
            answers: [{ id: first.id, selected: ['先不部署'], text: '下周再上' }],
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('提问没有按预期挂起');
    },
    async expect(context) {
      const plan = context.plans.state(context.sessionId);
      const step = context.tasks.get(plan.taskId).steps[0];
      return {
        pass:
          plan.status === 'completed' &&
          step.evidence?.summary?.includes('先不部署') === true &&
          context.seen.toolResults.some((result) => /先不部署/.test(result.text)),
        detail: `plan=${plan.status} step=${step.status} evidence=${step.evidence?.summary ?? 'none'}`,
      };
    },
  },
  {
    id: 'subagent-delegation',
    title: '委派：子会话跑完只回摘要，子 run 挂在父 run 下',
    mode: 'direct',
    script: () =>
      scriptedResponses({
        parent: [
          fauxAssistantMessage(
            [
              fauxToolCall('subagent', {
                preset: 'scout',
                task: '统计 node-pi/server/src/services 下的 .ts 文件数',
              }),
            ],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('共有 45 个 .ts 文件（来自子任务）。'),
        ],
        child: [
          fauxAssistantMessage(
            [fauxToolCall('bash', { command: 'ls node-pi/server/src/services | wc -l' })],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('共有 45 个 .ts 文件。'),
        ],
      }),
    setup: (harness) => harness.writePreset('scout', { tools: ['read', 'grep', 'find', 'ls'] }),
    async expect(context) {
      const { harness } = context;
      const delegated = harness.seen.toolResults.find((result) => result.toolName === 'subagent');
      const parentRunId = harness.ledger.lastRunId(context.sessionId);
      const runs = harness.store.traces.listRuns({ limit: 50 }).runs;
      const childRun = runs.find((run) => run.meta?.preset === 'scout');
      const parentMessages = JSON.stringify(harness.session.messages ?? []);
      return {
        pass:
          delegated !== undefined &&
          !delegated.isError &&
          delegated.text.includes('子任务 完成') &&
          delegated.text.includes('45') &&
          childRun?.parentRunId === parentRunId &&
          // 父会话上下文里只有摘要，没有子会话的执行细节（隔离的意义就在这里）
          !parentMessages.includes('node-pi/server/src/services | wc -l'),
        detail: `status=${delegated?.isError ? 'error' : 'ok'} linked=${
          childRun?.parentRunId === parentRunId
        } child=${harness.children[0]?.session.sessionId.slice(0, 8) ?? 'none'}`,
      };
    },
  },
  {
    id: 'subagent-preset-isolation',
    title: '子会话隔离：工具集就是预设的、不能递归、落在私有目录',
    mode: 'direct',
    script: () =>
      scriptedResponses({
        parent: [
          fauxAssistantMessage(
            [fauxToolCall('subagent', { preset: 'scout', task: '读一下 services 目录' })],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('已委派完成。'),
        ],
        child: [fauxAssistantMessage('目录里都是 .ts 文件。')],
      }),
    setup: (harness) => harness.writePreset('scout', { tools: ['read', 'grep', 'find', 'ls'] }),
    async expect(context) {
      const child = context.harness.children[0];
      if (child === undefined) return { pass: false, detail: '没有创建子会话' };
      const tools = child.session.getActiveToolNames();
      return {
        pass:
          // 只读预设被完整继承，且**没有**被并入 MCP / 计划 / ask_user / subagent
          tools.every((tool) => ['read', 'grep', 'find', 'ls'].includes(tool)) &&
          !tools.includes('subagent') &&
          !tools.includes('ask_user') &&
          child.input.subagent.depth === 1 &&
          // 子会话落在本项目私有目录，不进共享的 ~/.pi/agent/sessions
          child.input.subagent.sessionDir.includes('subagents'),
        detail: `tools=${tools.join('|')} depth=${child.input.subagent.depth}`,
      };
    },
  },
  {
    id: 'subagent-budget',
    title: '预算硬约束：超轮数即中止，但仍把已产出的摘要带回来',
    mode: 'direct',
    script: () =>
      scriptedResponses({
        parent: [
          fauxAssistantMessage(
            [
              fauxToolCall('subagent', {
                preset: 'scout',
                task: '做一件很久的事',
                budget: { maxTurns: 1 },
              }),
            ],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('子任务超预算了，我自己来。'),
        ],
        child: [
          fauxAssistantMessage([fauxToolCall('bash', { command: 'ls' })], {
            stopReason: 'toolUse',
          }),
          // 第二轮就会撞上限（maxTurns=1）
          fauxAssistantMessage('我还在继续……'),
        ],
      }),
    setup: (harness) => harness.writePreset('scout', { tools: ['read', 'grep', 'find', 'ls'] }),
    async expect(context) {
      const delegated = context.harness.seen.toolResults.find(
        (result) => result.toolName === 'subagent',
      );
      return {
        pass:
          delegated !== undefined &&
          delegated.text.includes('超预算中止') &&
          delegated.text.includes('最大轮数 1') &&
          // 状态是「结果」而不是「异常」：父会话能自己决定怎么办
          !delegated.isError,
        detail: `error=${delegated?.isError} text=${delegated?.text.slice(0, 60) ?? 'none'}`,
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
  {
    id: 'propose-plan-accepted',
    title: '模型提议规划：用户点头 → 服务端开启只读规划期 → 模型提交计划',
    // 不走「评测器预先 startPlanning」：本例要验证的就是**模型自己提议**这条路。
    mode: 'direct',
    script: () => [
      fauxAssistantMessage(
        [fauxToolCall('propose_plan', { goal: '重构 Plan 的缓存策略', reason: '改动面大' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        [fauxToolCall('submit_plan', { title: '重构 Plan 的缓存策略', steps: [{ title: '一步就够' }] })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('计划已提交，等你确认。'),
    ],
    /** propose_plan 在首轮就挂起：像前端那样轮询到挂起问题并选「先规划」。 */
    async whilePrompt(context) {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const pending = context.harness.questions.pendingForSession(context.sessionId);
        if (pending !== undefined) {
          context.harness.questions.answer(context.sessionId, pending.questionId, {
            answers: [{ id: pending.questions[0].id, selected: ['先规划'] }],
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('propose_plan 没有按预期挂起');
    },
    async expect(context) {
      const plan = context.plans.state(context.sessionId);
      const writeBlocked =
        context.plans.session(context.sessionId)?.onToolCall({
          toolName: 'edit',
          toolCallId: 'eval-probe',
          input: {},
        })?.block === true;
      return {
        pass: plan.status === 'proposed' && plan.goal === '重构 Plan 的缓存策略' && writeBlocked,
        detail: `plan=${plan.status} goal=${plan.goal} readOnly=${writeBlocked}`,
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
    // direct 模式：不进入 Plan（M5 的委派评测本来就跟计划无关）。
    const direct = definition.mode === 'direct';
    if (!direct) harness.plans.startPlanning(harness.sessionId, `${definition.title}`);
    if (definition.setup !== undefined) definition.setup(harness);
    harness.faux.setResponses(direct ? definition.script() : definition.script(definition.steps));
    // whilePrompt：与**首轮 prompt** 并发的动作（例如模型自己提议规划时，首轮就会挂起等用户回答）。
    const prompting = harness.session.prompt(definition.title);
    const promptHook = definition.whilePrompt?.(context);
    await prompting;
    await promptHook;
    await harness.waitForSettle();

    // 提交计划后统一走「用户确认执行」——这正是 golden set 要覆盖的主路径。
    let plan = direct
      ? { status: 'n/a', taskId: undefined, steps: [] }
      : harness.plans.state(harness.sessionId);
    let planAccepted = true;
    if (!direct && plan.status === 'proposed') {
      // whileExecuting：与本次 run 并发的动作（例如模型提问挂起了 run，需要边跑边答）。
      const starting = harness.plans.command(harness.sessionId, 'execute');
      const hook = definition.whileExecuting?.(context);
      await starting;
      await harness.waitForSettle();
      if (hook !== undefined) await hook;
      plan = harness.plans.state(harness.sessionId);
    } else if (!direct && plan.status !== 'drafting') {
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
    const task = plan.taskId === undefined ? { steps: [] } : context.tasks.get(plan.taskId);
    // M5：子任务是否真的挂在父 run 下（执行树能不能看出来龙去脉）。
    const runs = harness.store.traces.listRuns({ limit: 50 }).runs;
    const childRuns = runs.filter((run) => run.meta?.preset !== undefined);
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
        delegations: childRuns.length,
        delegationsLinked: childRuns.filter((run) => run.parentRunId !== undefined).length,
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
        delegations: 0,
        delegationsLinked: 0,
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
  {
    // M5：委派出去的子任务必须都能在执行树里找到（parent_run_id 串起来）
    name: '子任务 trace 关联率',
    value: (() => {
      const total = results.reduce((sum, item) => sum + item.metrics.delegations, 0);
      if (total === 0) return 100;
      return (results.reduce((sum, item) => sum + item.metrics.delegationsLinked, 0) / total) * 100;
    })(),
    min: 100,
  },
];

console.log('=== golden set（M4 计划 + M5 委派；fauxProvider 离线，真实管线）===');
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
console.log(
  `  子任务数 / 已挂进执行树        : ${results.reduce(
    (sum, item) => sum + item.metrics.delegations,
    0,
  )} / ${results.reduce((sum, item) => sum + item.metrics.delegationsLinked, 0)}`,
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
