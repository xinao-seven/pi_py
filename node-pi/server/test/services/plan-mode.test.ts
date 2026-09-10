import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../src/errors.js';
import { MemoryTaskRepository } from '../../src/services/platform/task-repository.js';
import { TaskService } from '../../src/services/task-service.js';
import { PlanModeService } from '../../src/services/plan-mode-service.js';
import { DEFAULT_PLAN_POLICY } from '../../src/services/plan-policy.js';
import { derivePlanStatus, type PlanView } from '../../src/services/platform/plan-model.js';

/**
 * M4 的 Plan 测试：原来的正则用例被**重写**而不是删除——
 * 覆盖同样的用户旅程（只读规划 → 产出计划 → 确认执行 → 推进步骤），
 * 但断言对象从「解析出来的文本」换成「工具调用产生的结构化状态」。
 */

const ALL_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

function makeFakePi(active: string[] = [...ALL_TOOLS]) {
  const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  let activeTools = [...active];
  return {
    handlers,
    tools,
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    registerTool: (tool: { name: string } & Record<string, unknown>) => {
      tools.set(tool.name, tool as never);
    },
    on(name: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
      handlers.set(name, handler);
    },
    /** 测试便利：调用某个计划工具。 */
    callTool(name: string, params: Record<string, unknown>, cwd = '/workspace') {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`tool ${name} is not registered`);
      return tool.execute('call-1', params, undefined, undefined, { cwd });
    },
  };
}

function sessionContext(entries: unknown[] = [], sessionId = 'session-1') {
  return {
    cwd: '/workspace',
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
    },
  };
}

/** 装配一套：真实 TaskService（内存仓储）+ 假 Pi + 假执行器。 */
function makeHarness(options: { activeTools?: string[]; plans?: TaskService } = {}) {
  const repository = new MemoryTaskRepository();
  const tasks = options.plans ?? new TaskService(repository);
  const service = new PlanModeService();
  service.setTaskService(tasks);
  const started: Array<{ taskId: string; prompt: string }> = [];
  const stopped: string[] = [];
  service.setExecutor({
    start: async (taskId, prompt) => {
      started.push({ taskId, prompt });
      return tasks.get(taskId);
    },
    stop: (taskId) => {
      stopped.push(taskId);
    },
  });
  const pi = makeFakePi(options.activeTools);
  const views: PlanView[] = [];
  service.setListener((view) => views.push(view));
  service.buildExtension()(pi as never);
  pi.handlers.get('session_start')!({}, sessionContext());
  return { service, tasks, pi, views, started, stopped, repository };
}

describe('规划期只读（能力集，而不是白名单快照）', () => {
  it('blocks edit/write and MCP, allows read-only and verification commands', () => {
    const { service, pi } = makeHarness({
      activeTools: [...ALL_TOOLS, 'mcp__github__create_issue'],
    });
    service.startPlanning('session-1', '重构 Plan 模式');

    const blocked = (toolName: string, input: Record<string, unknown>) =>
      pi.handlers.get('tool_call')!({ toolName, toolCallId: 'c1', input });
    expect(blocked('edit', { path: 'a.ts' })).toMatchObject({ block: true });
    expect(blocked('write', { path: 'a.ts' })).toMatchObject({ block: true });
    expect(blocked('mcp__github__create_issue', { title: 'x' })).toMatchObject({ block: true });
    expect(blocked('bash', { command: 'rm -rf ./dist' })).toMatchObject({ block: true });
    expect(blocked('bash', { command: 'git commit -m x' })).toMatchObject({ block: true });
    // P6 的修复点：这三条以前被白名单拦掉，现在必须放行。
    expect(blocked('bash', { command: 'rg -n plan src' })).toBeUndefined();
    expect(blocked('bash', { command: 'pnpm test' })).toBeUndefined();
    expect(blocked('bash', { command: 'tsc --noEmit' })).toBeUndefined();
    expect(blocked('read', { path: 'a.ts' })).toBeUndefined();
  });

  it('registers the five plan tools and activates them only while planning', async () => {
    const { service, pi } = makeHarness();
    expect([...pi.tools.keys()]).toEqual([
      'submit_plan',
      'update_plan',
      'complete_step',
      'block_step',
      'ask_user',
    ]);
    // 普通会话里计划工具不激活（模型看不到，也就不会误造计划）。
    expect(pi.getActiveTools()).not.toContain('submit_plan');

    service.startPlanning('session-1', '重构 Plan 模式');
    expect(pi.getActiveTools()).toEqual(
      expect.arrayContaining([
        'submit_plan',
        'update_plan',
        'complete_step',
        'block_step',
        'ask_user',
      ]),
    );
    expect(pi.getActiveTools()).not.toContain('edit');
    expect(pi.getActiveTools()).not.toContain('write');

    // 执行期：写工具回来，计划工具仍在。
    await service.command('session-1', 'execute').catch(() => undefined); // 还没有步骤 → 409
    await pi.callTool('submit_plan', { title: 'T', steps: [{ title: 'a' }] });
    await service.command('session-1', 'execute');
    expect(pi.getActiveTools()).toEqual(expect.arrayContaining(['edit', 'write', 'complete_step']));
  });
});

describe('计划上下文注入', () => {
  it('injects a planning context that tells the model to use tools', () => {
    const { service, pi } = makeHarness();
    service.startPlanning('session-1', '重构 Plan 模式');
    const injected = pi.handlers.get('before_agent_start')!() as {
      message: { customType: string; content: string; display: boolean };
    };
    expect(injected.message).toMatchObject({ customType: 'web-plan-context', display: false });
    expect(injected.message.content).toContain('[PLAN MODE ACTIVE]');
    expect(injected.message.content).toContain('submit_plan');
    // 不再要求模型写任何标记。
    expect(injected.message.content).not.toContain('[DONE:');
  });

  it('injects an executing context with the live step list', async () => {
    const { service, pi } = makeHarness();
    service.startPlanning('session-1', '重构 Plan 模式');
    await pi.callTool('submit_plan', {
      title: 'T',
      steps: [{ title: '第一步' }, { title: '第二步' }],
    });
    await service.command('session-1', 'execute');
    const injected = pi.handlers.get('before_agent_start')!() as {
      message: { customType: string; content: string };
    };
    expect(injected.message.customType).toBe('web-plan-execution-context');
    expect(injected.message.content).toContain('[PLAN EXECUTING]');
    expect(injected.message.content).toContain('第一步');
    expect(injected.message.content).toContain('complete_step');
  });

  it('keeps only the latest context per type and drops legacy injections', () => {
    const { service, pi } = makeHarness();
    service.startPlanning('session-1', '重构 Plan 模式');
    const onContext = pi.handlers.get('context')! as (event: {
      messages: unknown[];
    }) => { messages: Array<{ customType?: string }> } | undefined;

    const result = onContext({
      messages: [
        { role: 'user', content: 'hi' },
        { customType: 'web-plan-context', content: 'old' },
        { customType: 'web-plan-execution-context', content: 'stale' },
        { customType: 'web-plan-execute', content: 'legacy' },
        { customType: 'web-plan-context', content: 'new' },
      ],
    });
    expect(result?.messages.map((message) => message.customType ?? 'user')).toEqual([
      'user',
      'web-plan-context',
    ]);
    expect(result?.messages.at(-1)).toMatchObject({ content: 'new' });

    // 无变化时不无谓替换数组。
    expect(
      onContext({
        messages: [{ role: 'user', content: 'hi' }, { customType: 'web-plan-context' }],
      }),
    ).toBeUndefined();
  });
});

describe('计划生命周期（命令驱动，零文本解析）', () => {
  it('start → submit → execute → complete_step walks the whole journey', async () => {
    const { service, tasks, pi, views, started } = makeHarness();
    const planning = service.startPlanning('session-1', '重构 Plan 模式');
    expect(planning).toMatchObject({ status: 'drafting', sessionId: 'session-1' });
    expect(planning.title).toBe('重构 Plan 模式');
    expect(derivePlanStatus(tasks.get(planning.taskId))).toBe('drafting');

    await pi.callTool('submit_plan', {
      title: '重构 Plan 模式',
      steps: [{ title: '读现有实现' }, { title: '写迁移' }],
    });
    expect(service.view('session-1')).toMatchObject({
      status: 'proposed',
      awaitingUserAction: true,
    });
    expect(views.at(-1)?.status).toBe('proposed');

    await service.command('session-1', 'execute');
    expect(service.view('session-1').status).toBe('executing');
    expect(started).toHaveLength(1);
    expect(started[0].prompt).toContain('开始执行计划');

    const result = (await pi.callTool('complete_step', {
      stepId: 's1',
      evidence: { summary: '读完了', files: ['src/plan-mode-service.ts'] },
    })) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain('剩余 1 步');
    expect(service.view('session-1').steps[0]).toMatchObject({ status: 'completed' });

    await pi.callTool('complete_step', { stepId: 's2', evidence: { summary: '写完并验证' } });
    expect(service.view('session-1').status).toBe('completed');
  });

  it('pause stops the executor and resume starts it again', async () => {
    const { service, pi, started, stopped } = makeHarness();
    service.startPlanning('session-1', 'P');
    await pi.callTool('submit_plan', { title: 'P', steps: [{ title: 'a' }] });
    await service.command('session-1', 'execute');
    const paused = await service.command('session-1', 'pause');
    expect(paused.status).toBe('paused');
    expect(stopped).toEqual([service.view('session-1').taskId]);

    const resumed = await service.command('session-1', 'resume');
    expect(resumed.status).toBe('executing');
    expect(started).toHaveLength(2);
  });

  it('abandon cancels the task but keeps the record and restores tools', async () => {
    const { service, tasks, pi } = makeHarness();
    service.startPlanning('session-1', 'P');
    await pi.callTool('submit_plan', { title: 'P', steps: [{ title: 'a' }] });
    await service.command('session-1', 'abandon');
    const view = service.view('session-1');
    expect(view.status).toBe('abandoned');
    expect(tasks.get(view.taskId).status).toBe('cancelled');
    // 放弃后计划工具收回、写工具恢复（只撤销自己的差集）。
    expect(pi.getActiveTools()).not.toContain('submit_plan');
    expect(pi.getActiveTools()).toEqual(expect.arrayContaining(['edit', 'write']));
  });

  it('rejects execute/refine when there is nothing to work with', async () => {
    const { service } = makeHarness();
    await expect(service.command('session-1', 'execute')).rejects.toMatchObject({
      code: 'plan_unavailable',
    });
    const { service: started } = makeHarness();
    started.startPlanning('session-1', 'P');
    await expect(started.command('session-1', 'execute')).rejects.toMatchObject({
      code: 'plan_not_ready',
    });
    await expect(started.command('session-1', 'start')).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('re-plans an existing plan instead of creating a second one', async () => {
    const { service, tasks, pi } = makeHarness();
    const first = service.startPlanning('session-1', 'P');
    await pi.callTool('submit_plan', { title: 'P', steps: [{ title: 'a' }] });
    const again = service.startPlanning('session-1', '再想想');
    expect(again.taskId).toBe(first.taskId);
    expect(again.status).toBe('drafting');
    expect(tasks.list({ sessionId: 'session-1' })).toHaveLength(1);
  });

  it('allows refining a proposed plan and keeps it proposed', async () => {
    const { service, pi } = makeHarness();
    service.startPlanning('session-1', 'P');
    await pi.callTool('submit_plan', { title: 'P', steps: [{ title: 'a' }] });
    await service.command('session-1', 'refine', '把第二步拆开');
    expect(service.view('session-1').status).toBe('drafting');
    await expect(service.command('session-1', 'refine', '  ')).rejects.toMatchObject({
      code: 'validation_error',
    });
  });
});

describe('工具差集恢复（P6）', () => {
  it('restores only its own delta, keeping user changes during the plan', async () => {
    const { service, pi } = makeHarness();
    service.startPlanning('session-1', 'P');
    // 规划期间用户手动关掉 grep（模拟 set_tools），并打开了一个计划期没碰过的工具。
    pi.setActiveTools([...pi.getActiveTools().filter((name) => name !== 'grep'), 'find']);
    await service.command('session-1', 'abandon');
    const active = pi.getActiveTools();
    expect(active).not.toContain('grep'); // 用户的改动被保留
    expect(active).toEqual(expect.arrayContaining(['edit', 'write', 'find']));
    expect(active).not.toContain('submit_plan');
  });

  it('keeps the exact tool set (plan tools on, write tools off) while planning', () => {
    const { service, pi } = makeHarness();
    expect(pi.getActiveTools()).toEqual(ALL_TOOLS);
    service.startPlanning('session-1', 'P');
    expect([...pi.getActiveTools()].sort()).toEqual(
      [
        'read',
        'bash',
        'grep',
        'find',
        'ls',
        'submit_plan',
        'update_plan',
        'complete_step',
        'block_step',
        'ask_user',
      ].sort(),
    );
  });
});

describe('计划结束时收回计划工具', () => {
  it('withdraws the plan tools once the plan completes (no lingering submit_plan)', async () => {
    const { service, pi } = makeHarness();
    service.startPlanning('session-1', 'P');
    await pi.callTool('submit_plan', { title: 'P', steps: [{ title: 'a' }] });
    await service.command('session-1', 'execute');
    expect(pi.getActiveTools()).toContain('complete_step');

    await pi.callTool('complete_step', { stepId: 's1', evidence: { summary: '做完了' } });
    // 全部步骤完成后计划终态：计划工具收回，写工具保留。
    expect(pi.getActiveTools()).not.toContain('complete_step');
    expect(pi.getActiveTools()).not.toContain('submit_plan');
    expect(pi.getActiveTools()).toEqual(expect.arrayContaining(['edit', 'write', 'read']));
  });
});

describe('重启后接管（P8）', () => {
  it('adopts an unfinished plan from the store when the session reopens', async () => {
    const repository = new MemoryTaskRepository();
    const tasks = new TaskService(repository);
    const plan = tasks.createPlan({
      title: '重构 Plan 模式',
      goal: 'G',
      sessionId: 'session-1',
      cwd: '/workspace',
    });
    tasks.replacePlanSteps(plan.id, [{ title: 'a' }, { title: 'b' }]);
    tasks.setPlanState(plan.id, { status: 'executing' });

    // 新的服务实例 + 新的会话（模拟服务重启）。
    const service = new PlanModeService();
    service.setTaskService(tasks);
    const pi = makeFakePi();
    service.buildExtension()(pi as never);
    pi.handlers.get('session_start')!({}, sessionContext());

    const view = service.view('session-1');
    expect(view).toMatchObject({ planId: plan.id, status: 'executing' });
    expect(view.steps).toHaveLength(2);
    // 执行态：不注入规划上下文，注入执行上下文。
    const injected = pi.handlers.get('before_agent_start')!() as {
      message: { customType: string };
    };
    expect(injected.message.customType).toBe('web-plan-execution-context');
    // 待确认的计划则恢复成规划期（只读 + 计划工具）。
    tasks.setPlanState(plan.id, { status: 'proposed' });
    const second = new PlanModeService();
    second.setTaskService(tasks);
    const pi2 = makeFakePi();
    second.buildExtension()(pi2 as never);
    pi2.handlers.get('session_start')!({}, sessionContext());
    expect(second.view('session-1').status).toBe('proposed');
    expect(pi2.getActiveTools()).not.toContain('edit');
  });

  it('returns an empty view for sessions without plans (even without an active machine)', () => {
    const service = new PlanModeService();
    expect(service.view('session-x')).toMatchObject({ planId: '', sessionId: 'session-x' });
  });
});

describe('策略与观测', () => {
  it('honours a custom policy (bash: none)', () => {
    const service = new PlanModeService({ policy: { ...DEFAULT_PLAN_POLICY, bash: 'none' } });
    service.setTaskService(new TaskService(new MemoryTaskRepository()));
    const pi = makeFakePi();
    service.buildExtension()(pi as never);
    pi.handlers.get('session_start')!({}, sessionContext());
    service.startPlanning('session-1', 'P');
    expect(
      pi.handlers.get('tool_call')!({
        toolName: 'bash',
        toolCallId: 'c',
        input: { command: 'cat a' },
      }),
    ).toMatchObject({
      block: true,
    });
  });

  it('reports blocked tool calls to the trace sink and swallows sink failures', () => {
    const { service, pi } = makeHarness();
    const sink = vi.fn();
    service.setTraceSink({ noteToolBlock: sink });
    service.startPlanning('session-1', 'P');
    pi.handlers.get('tool_call')!({ toolName: 'edit', toolCallId: 'c9', input: {} });
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', toolCallId: 'c9', blockedBy: 'plan_mode' }),
    );
    service.setTraceSink({
      noteToolBlock: () => {
        throw new Error('ledger down');
      },
    });
    expect(() =>
      pi.handlers.get('tool_call')!({ toolName: 'edit', toolCallId: 'c10', input: {} }),
    ).not.toThrow();
  });

  it('throws ApiError when the session was never opened', async () => {
    const service = new PlanModeService();
    service.setTaskService(new TaskService(new MemoryTaskRepository()));
    await expect(service.command('ghost', 'execute')).rejects.toBeInstanceOf(ApiError);
  });
});
