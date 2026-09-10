import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { MemoryTaskRepository } from '../../src/services/platform/task-repository.js';
import { buildPlanTools, MAX_PLAN_STEPS, PlanToolbox } from '../../src/services/plan-tools.js';
import { derivePlanStatus, toPlanView } from '../../src/services/platform/plan-model.js';
import { TaskService } from '../../src/services/task-service.js';

function makeToolbox(exists: (path: string) => boolean = () => false) {
  const repository = new MemoryTaskRepository();
  let serial = 0;
  const tasks = new TaskService(repository, {
    idFactory: () => `task-${(serial += 1)}`,
  });
  const toolbox = new PlanToolbox({ tasks, sessionId: 'session-1', exists });
  return { tasks, toolbox };
}

/** 建一个计划并绑定（模拟 plan_start）。 */
function withPlan(toolbox: PlanToolbox, tasks: TaskService) {
  const plan = tasks.createPlan({ title: '重构 Plan 模式', goal: 'G', sessionId: 'session-1' });
  toolbox.bind(plan.id);
  return plan;
}

/** 取某个工具并直接调用它的 execute（工具实现不依赖 Pi 会话）。 */
async function runTool(
  toolbox: PlanToolbox,
  name: string,
  params: Record<string, unknown>,
  cwd?: string,
) {
  const tool = buildPlanTools(toolbox).find((item) => item.name === name);
  if (tool === undefined) throw new Error(`tool ${name} not found`);
  return tool.execute('call-1', params as never, undefined, undefined, {
    cwd: cwd ?? '/workspace',
  } as never);
}

describe('buildPlanTools', () => {
  it('exposes the five plan tools with schemas', () => {
    const { toolbox } = makeToolbox();
    const tools = buildPlanTools(toolbox);
    expect(tools.map((tool) => tool.name)).toEqual([
      'submit_plan',
      'update_plan',
      'complete_step',
      'block_step',
      'ask_user',
    ]);
    for (const tool of tools) {
      expect(tool.parameters).toBeDefined();
      expect(tool.description.length).toBeGreaterThan(20);
      // 系统提示词靠 snippet 枚举自定义工具，缺了模型就发现不了。
      expect(tool.promptSnippet).toBeTruthy();
    }
  });
});

describe('submit_plan', () => {
  it('replaces steps and moves the plan to proposed', async () => {
    const { tasks, toolbox } = makeToolbox();
    const plan = withPlan(toolbox, tasks);
    const result = await runTool(toolbox, 'submit_plan', {
      title: '重构 Plan 模式',
      steps: [
        { title: '读现有实现' },
        { title: '写迁移', verification: { kind: 'file', path: 'dist/x.js' } },
      ],
    });
    expect(result.details).toMatchObject({ planId: plan.id, status: 'proposed' });
    const task = tasks.get(plan.id);
    expect(derivePlanStatus(task)).toBe('proposed');
    expect(task.steps.map((step) => step.title)).toEqual(['读现有实现', '写迁移']);
    expect(task.steps[1].verification).toMatchObject({ kind: 'file', path: 'dist/x.js' });
    expect(String(result.content[0] && 'text' in result.content[0])).toBeTruthy();
  });

  it('rejects empty / duplicate / oversized plans with actionable messages', async () => {
    const { tasks, toolbox } = makeToolbox();
    withPlan(toolbox, tasks);
    await expect(runTool(toolbox, 'submit_plan', { title: 'x', steps: [] })).rejects.toThrow(
      /至少要有一个步骤/,
    );
    await expect(
      runTool(toolbox, 'submit_plan', { title: 'x', steps: [{ title: 'a' }, { title: ' A ' }] }),
    ).rejects.toThrow(/重复/);
    await expect(
      runTool(toolbox, 'submit_plan', {
        title: 'x',
        steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, index) => ({ title: `s${index}` })),
      }),
    ).rejects.toThrow(/步骤过多/);
  });

  it('rejects malformed verification declarations', async () => {
    const { tasks, toolbox } = makeToolbox();
    withPlan(toolbox, tasks);
    await expect(
      runTool(toolbox, 'submit_plan', {
        title: 'x',
        steps: [{ title: 'a', verification: { kind: 'file' } }],
      }),
    ).rejects.toThrow(/kind=file 但没有给 path/);
    await expect(
      runTool(toolbox, 'submit_plan', {
        title: 'x',
        steps: [{ title: 'a', verification: { kind: 'command' } }],
      }),
    ).rejects.toThrow(/kind=command 但没有给 command/);
  });

  it('refuses to replace a plan that is already executing', async () => {
    const { tasks, toolbox } = makeToolbox();
    const plan = withPlan(toolbox, tasks);
    await runTool(toolbox, 'submit_plan', { title: 'x', steps: [{ title: 'a' }] });
    tasks.setPlanState(plan.id, { status: 'executing' });
    await expect(
      runTool(toolbox, 'submit_plan', { title: 'x', steps: [{ title: 'b' }] }),
    ).rejects.toThrow(/不能用 submit_plan 整体替换/);
  });

  it('explains how to start a plan when the session has none', async () => {
    const { toolbox } = makeToolbox();
    await expect(
      runTool(toolbox, 'submit_plan', { title: 'x', steps: [{ title: 'a' }] }),
    ).rejects.toThrow(/没有进行中的计划/);
  });
});

describe('update_plan', () => {
  it('applies a revision-matched update', async () => {
    const { tasks, toolbox } = makeToolbox();
    const plan = withPlan(toolbox, tasks);
    await runTool(toolbox, 'submit_plan', { title: 'x', steps: [{ title: 'a' }, { title: 'b' }] });
    const current = tasks.get(plan.id);
    const result = await runTool(toolbox, 'update_plan', {
      revision: current.revision,
      title: '新标题',
      steps: [{ title: 'a' }, { title: 'c' }],
    });
    expect(result.details).toMatchObject({ status: 'proposed' });
    const updated = tasks.get(plan.id);
    expect(updated.title).toBe('新标题');
    expect(updated.steps.map((step) => step.title)).toEqual(['a', 'c']);
  });

  it('tells the model the current revision when it passes a stale one', async () => {
    const { tasks, toolbox } = makeToolbox();
    const plan = withPlan(toolbox, tasks);
    await runTool(toolbox, 'submit_plan', { title: 'x', steps: [{ title: 'a' }] });
    const current = tasks.get(plan.id);
    await expect(
      runTool(toolbox, 'update_plan', { revision: current.revision - 1, title: 'y' }),
    ).rejects.toThrow(new RegExp(`revision=${current.revision}`));
  });

  it('allows revising future steps while executing but protects started ones', async () => {
    const { tasks, toolbox } = makeToolbox();
    const plan = withPlan(toolbox, tasks);
    await runTool(toolbox, 'submit_plan', {
      title: 'x',
      steps: [{ title: 'a' }, { title: '旧 b' }],
    });
    tasks.setPlanState(plan.id, { status: 'executing' });
    const executing = tasks.get(plan.id);
    tasks.updateStep(plan.id, executing.steps[0].id, {
      status: 'completed',
      ifRevision: executing.revision,
    });

    // 保留已完成步骤的标题 → 允许（只改还没开始的第二步）。
    const revised = await runTool(toolbox, 'update_plan', {
      revision: tasks.get(plan.id).revision,
      steps: [{ title: 'a' }, { title: '新 b' }],
    });
    expect((revised.details as { status: string }).status).toBe('executing');
    const after = tasks.get(plan.id);
    expect(after.steps.map((step) => [step.title, step.status])).toEqual([
      ['a', 'completed'],
      ['新 b', 'pending'],
    ]);

    // 删掉/改名已完成步骤 → 拒绝（否则会静默丢掉已完成的工作）。
    await expect(
      runTool(toolbox, 'update_plan', {
        revision: tasks.get(plan.id).revision,
        steps: [{ title: 'b 改个名' }],
      }),
    ).rejects.toThrow(/不能删除或重命名已经开始\/已完成的步骤/);
  });

  it('refuses after the plan is finished', async () => {
    const { tasks, toolbox } = makeToolbox();
    const plan = withPlan(toolbox, tasks);
    await runTool(toolbox, 'submit_plan', { title: 'x', steps: [{ title: 'a' }] });
    tasks.abandonPlan(plan.id);
    await expect(
      runTool(toolbox, 'update_plan', { revision: tasks.get(plan.id).revision, title: 'y' }),
    ).rejects.toThrow(/无法再修改/);
  });
});

describe('complete_step', () => {
  async function executing() {
    const harness = makeToolbox();
    const { tasks, toolbox } = harness;
    const plan = withPlan(toolbox, tasks);
    await runTool(toolbox, 'submit_plan', {
      title: 'x',
      steps: [
        { title: '跑测试', verification: { kind: 'command', command: 'npm test' } },
        { title: '写文件', verification: { kind: 'file', path: 'dist/out.js' } },
        { title: '随便一步' },
      ],
    });
    tasks.setPlanState(plan.id, { status: 'executing' });
    return { ...harness, plan };
  }

  it('accepts evidence that satisfies the declared command verification', async () => {
    const { tasks, toolbox, plan } = await executing();
    const result = await runTool(toolbox, 'complete_step', {
      stepId: 's1',
      evidence: { summary: '测试全绿', commands: [{ command: 'npm test', exitCode: 0 }] },
    });
    expect(result.details).toMatchObject({ status: 'executing', stepId: 's1' });
    const step = tasks.get(plan.id).steps[0];
    expect(step).toMatchObject({ status: 'completed' });
    expect(step.evidence?.toolCallIds).toEqual(['call-1']);
    expect(step.evidence?.commands).toEqual([{ command: 'npm test', exitCode: 0 }]);
  });

  it('rejects completion without the declared proof', async () => {
    const { tasks, toolbox, plan } = await executing();
    await expect(
      runTool(toolbox, 'complete_step', { stepId: 's1', evidence: { summary: 'done' } }),
    ).rejects.toThrow(/证据不足/);
    await expect(
      runTool(toolbox, 'complete_step', {
        stepId: 's1',
        evidence: { summary: 'done', commands: [{ command: 'npm test', exitCode: 1 }] },
      }),
    ).rejects.toThrow(/期望 0/);
    expect(tasks.get(plan.id).steps[0].status).toBe('pending');
  });

  it('resolves file artifacts against the tool cwd', async () => {
    const here = resolve('/workspace', 'dist/out.js');
    /** 造一个「一步、需产物」的执行中计划。 */
    async function executable(fileExists: (path: string) => boolean) {
      const harness = makeToolbox(fileExists);
      const plan = withPlan(harness.toolbox, harness.tasks);
      await runTool(harness.toolbox, 'submit_plan', {
        title: 'x',
        steps: [
          { title: '写文件', verification: { kind: 'file', path: 'dist/out.js' } },
          { title: '收尾' },
        ],
      });
      harness.tasks.setPlanState(plan.id, { status: 'executing' });
      return harness;
    }

    // 产物在 cwd 下存在 → 通过。
    const ok = await executable((path) => path === here);
    await expect(
      runTool(ok.toolbox, 'complete_step', { stepId: 's1', evidence: { summary: '产物已生成' } }),
    ).resolves.toBeDefined();

    // 同一个声明换个 cwd 就找不到产物 → 拒绝（相对路径按工具 cwd 解析）。
    const missing = await executable((path) => path === here);
    await expect(
      runTool(
        missing.toolbox,
        'complete_step',
        { stepId: 's1', evidence: { summary: '产物已生成' } },
        '/other',
      ),
    ).rejects.toThrow(/产物不存在/);
  });

  it('refuses to advance before the user confirms execution', async () => {
    const { tasks, toolbox } = makeToolbox();
    const plan = withPlan(toolbox, tasks);
    await runTool(toolbox, 'submit_plan', { title: 'x', steps: [{ title: 'a' }] });
    const view = toPlanView(tasks.get(plan.id));
    expect(view.status).toBe('proposed');
    await expect(
      runTool(toolbox, 'complete_step', { stepId: 's1', evidence: { summary: '偷偷完成' } }),
    ).rejects.toThrow(/计划当前状态是 proposed/);
  });

  it('lists the available steps when the id is unknown', async () => {
    const { toolbox } = await executing();
    await expect(
      runTool(toolbox, 'complete_step', { stepId: 's9', evidence: { summary: 'x' } }),
    ).rejects.toThrow(/找不到步骤 s9/);
  });

  it('reports the remaining steps in the tool result', async () => {
    const { toolbox } = await executing();
    const result = await runTool(toolbox, 'complete_step', {
      stepId: 's3',
      evidence: { summary: '没有声明验证，随便一步' },
    });
    expect(JSON.stringify(result.content)).toContain('剩余 2 步');
  });
});

describe('block_step / ask_user', () => {
  it('blocks a step with a reason and pauses the plan', async () => {
    const { tasks, toolbox } = makeToolbox();
    const plan = withPlan(toolbox, tasks);
    await runTool(toolbox, 'submit_plan', { title: 'x', steps: [{ title: 'a' }] });
    tasks.setPlanState(plan.id, { status: 'executing' });
    const result = await runTool(toolbox, 'block_step', {
      stepId: 's1',
      reason: '缺少生产环境凭据',
    });
    expect(result.details).toMatchObject({ status: 'paused' });
    const task = tasks.get(plan.id);
    expect(task.status).toBe('blocked');
    expect(task.steps[0]).toMatchObject({ status: 'blocked', blockedReason: '缺少生产环境凭据' });
  });

  it('records a clarification question and clears it on answer', async () => {
    const { tasks, toolbox } = makeToolbox();
    const plan = withPlan(toolbox, tasks);
    const result = await runTool(toolbox, 'ask_user', {
      question: '要兼容 CLI 吗？',
      options: ['要', '不要'],
    });
    expect(result.details).toMatchObject({ status: 'drafting' });
    expect(JSON.stringify(result.content)).toContain('要兼容 CLI 吗？');
    let task = tasks.get(plan.id);
    expect(toPlanView(task)).toMatchObject({
      awaitingUserAction: true,
      question: '要兼容 CLI 吗？',
      questionOptions: ['要', '不要'],
    });
    // 用户回答后清空问题，等待重新提交计划。
    tasks.setPlanState(plan.id, { question: null });
    task = tasks.get(plan.id);
    expect(toPlanView(task).question).toBeUndefined();
  });
});
