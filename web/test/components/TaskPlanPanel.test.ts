import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import TaskPlanPanel from '@/components/TaskPlanPanel.vue';
import type {
  PlanStatus,
  PlanStepView,
  PlanView,
  TaskRecoveryItem,
  TaskRecord,
  TaskStep,
} from '@/types';

function planStep(overrides: Partial<PlanStepView> & { id: string; title: string }): PlanStepView {
  return { status: 'pending', ...overrides };
}

function planView(overrides: Partial<PlanView> = {}): PlanView {
  return {
    planId: 'task-1',
    taskId: 'task-1',
    sessionId: 'session-1',
    status: 'drafting',
    revision: 1,
    title: '重构 Plan 模式',
    goal: '把正则解析换成结构化工具契约',
    steps: [],
    awaitingUserAction: false,
    updatedAt: '2026-08-21T10:00:00.000Z',
    ...overrides,
  };
}

function taskStep(overrides: Partial<TaskStep> = {}): TaskStep {
  return { id: 's1', title: '读现有实现', status: 'pending', position: 0, ...overrides };
}

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: '重构 Plan 模式',
    goal: '把正则解析换成结构化工具契约',
    status: 'in_progress',
    origin: 'user',
    sessionId: 'session-1',
    cwd: '/workspace',
    revision: 3,
    execution: { attempt: 1 },
    createdAt: '2026-08-21T10:00:00.000Z',
    updatedAt: '2026-08-21T10:05:00.000Z',
    steps: [
      taskStep({ id: 's1', title: '读现有实现', status: 'completed' }),
      taskStep({
        id: 's2',
        title: '设计工具契约',
        status: 'in_progress',
        position: 1,
        details: 'submit_plan / complete_step',
      }),
      taskStep({
        id: 's3',
        title: '写迁移',
        status: 'blocked',
        position: 2,
        blockedReason: '缺前置',
      }),
    ],
    ...overrides,
  };
}

type PanelProps = {
  plan?: PlanView | null;
  task?: TaskRecord | null;
  sessionId?: string | null;
  recovery?: TaskRecoveryItem[];
  busy?: boolean;
  error?: string | null;
};

function mountPanel(props: PanelProps = {}) {
  return mount(TaskPlanPanel, {
    props: { plan: null, task: null, sessionId: 'session-1', ...props },
  });
}

/** 按文案找步骤行里的按钮（比按下标稳）。 */
function stepButton(
  row: { findAll: (selector: string) => Array<{ text: () => string }> },
  label: string,
) {
  return row.findAll('.work-step-actions button').find((button) => button.text() === label);
}

describe('TaskPlanPanel（计划与任务合并后的悬浮面板）', () => {
  const labels: Array<[PlanStatus, string]> = [
    ['drafting', '规划中'],
    ['proposed', '待确认'],
    ['executing', '执行中'],
    ['paused', '已暂停'],
    ['completed', '已完成'],
    ['abandoned', '已放弃'],
  ];
  it.each(labels)('shows the %s plan status as %s', (status, label) => {
    const wrapper = mountPanel({
      plan: planView({ status, steps: [planStep({ id: 's1', title: '第一步' })] }),
    });
    expect(wrapper.get('.work-badge').text()).toBe(label);
  });

  it('shows the plan steps with verification, evidence and progress', () => {
    const wrapper = mountPanel({
      plan: planView({
        status: 'executing',
        steps: [
          planStep({
            id: 's1',
            title: '跑测试',
            status: 'completed',
            verification: { kind: 'command', command: 'npm test' },
            evidence: { summary: '测试全绿', toolCallIds: [], filesTouched: [] },
          }),
          planStep({
            id: 's2',
            title: '产出迁移文件',
            status: 'in_progress',
            verification: { kind: 'file', path: 'migration.sql' },
          }),
          planStep({ id: 's3', title: '更新文档', status: 'blocked', blockedReason: '缺凭据' }),
        ],
      }),
    });

    const text = wrapper.text();
    expect(text).toContain('证据：测试全绿');
    expect(text).toContain('需产物：migration.sql');
    expect(text).toContain('已阻塞：缺凭据');
    expect(text).toContain('1/3 完成');

    const rows = wrapper.findAll('.work-steps li');
    expect(rows[0].classes()).toContain('work-step--completed');
    expect(rows[1].classes()).toContain('work-step--current');
    expect(rows[2].classes()).toContain('work-step--blocked');
  });

  it('renders steps only once when the plan is the session task', () => {
    const steps = [planStep({ id: 's1', title: '第一步' })];
    const plan = planView({ status: 'executing', steps });
    // 计划就是这条任务（taskId 相同）：不该出现第二份列表，也不该有任务区。
    const wrapper = mountPanel({
      plan,
      task: taskRecord({ id: 'task-1', origin: 'plan', steps: [{ ...steps[0], position: 0 }] }),
    });

    expect(wrapper.findAll('.work-steps li')).toHaveLength(1);
    expect(wrapper.find('.task-section').exists()).toBe(false);
  });

  it('keeps an unrelated session task visible next to the plan', () => {
    const wrapper = mountPanel({
      plan: planView({
        taskId: 'task-plan',
        planId: 'task-plan',
        steps: [planStep({ id: 's1', title: '计划步骤' })],
      }),
      task: taskRecord({ id: 'task-manual', title: '手工任务', origin: 'user' }),
    });

    expect(wrapper.find('.task-section').exists()).toBe(true);
    expect(wrapper.find('.work-section-head').text()).toContain('会话任务');
    const text = wrapper.text();
    expect(text).toContain('计划步骤');
    expect(text).toContain('手工任务');
    expect(text).toContain('设计工具契约');
    // 两条任务各有自己的列表，但每条只渲染一次。
    expect(wrapper.findAll('.work-steps')).toHaveLength(2);
  });

  it('emits plan execute / refine / abandon while awaiting confirmation', async () => {
    const wrapper = mountPanel({
      plan: planView({ status: 'proposed', steps: [planStep({ id: 's1', title: 'a' })] }),
    });

    await wrapper.get('.primary-action').trigger('click');
    expect(wrapper.emitted('planExecute')).toHaveLength(1);

    await wrapper.get('textarea').setValue(' 把第二步拆开 ');
    await wrapper.findAll('.plan-confirm-actions button')[1].trigger('click');
    expect(wrapper.emitted('planRefine')).toEqual([['把第二步拆开']]);
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('');

    await wrapper.findAll('.plan-confirm-actions button')[2].trigger('click');
    expect(wrapper.emitted('planAbandon')).toHaveLength(1);
  });

  it('emits pause while executing and resume while paused', async () => {
    const executing = mountPanel({
      plan: planView({ status: 'executing', steps: [planStep({ id: 's1', title: 'a' })] }),
    });
    const pauseButton = executing.findAll('.plan-actions button')[0];
    expect(pauseButton.text()).toBe('暂停');
    await pauseButton.trigger('click');
    expect(executing.emitted('planPause')).toHaveLength(1);

    const paused = mountPanel({
      plan: planView({ status: 'paused', steps: [planStep({ id: 's1', title: 'a' })] }),
    });
    const resumeButton = paused.findAll('.plan-actions button')[0];
    expect(resumeButton.text()).toBe('继续执行');
    await resumeButton.trigger('click');
    expect(paused.emitted('planResume')).toHaveLength(1);

    // 执行中/已暂停都能带要求让 Agent 修订计划。
    await paused.find('.plan-actions input').setValue('第二步拆开');
    await paused.findAll('.plan-actions button')[1].trigger('click');
    expect(paused.emitted('planRefine')).toEqual([['第二步拆开']]);
  });

  it('edits, skips, reopens and removes plan steps through task writes', async () => {
    const wrapper = mountPanel({
      plan: planView({
        status: 'executing',
        steps: [
          planStep({ id: 's1', title: '第一步' }),
          planStep({ id: 's2', title: '第二步', status: 'skipped' }),
        ],
      }),
    });
    const rows = wrapper.findAll('.work-steps li');

    // 改名：双击标题进入编辑，回车提交。
    await rows[0].get('strong').trigger('dblclick');
    const input = rows[0].get('input');
    await input.setValue('第一步（改名）');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('stepPatch')).toEqual([
      [{ stepId: 's1', patch: { title: '第一步（改名）' } }],
    ]);

    // 跳过 / 恢复。
    await stepButton(rows[0], '跳过')!.trigger('click');
    expect(wrapper.emitted('stepPatch')?.at(-1)).toEqual([
      { stepId: 's1', patch: { status: 'skipped' } },
    ]);
    await stepButton(rows[1], '恢复')!.trigger('click');
    expect(wrapper.emitted('stepPatch')?.at(-1)).toEqual([
      { stepId: 's2', patch: { status: 'pending' } },
    ]);

    // 删除：未完成的步骤直接删。
    await stepButton(rows[0], '删除')!.trigger('click');
    expect(wrapper.emitted('stepRemove')).toEqual([[{ stepId: 's1' }]]);
  });

  it('hides step editing on terminal plans but keeps the history visible', () => {
    const wrapper = mountPanel({
      plan: planView({
        status: 'completed',
        steps: [planStep({ id: 's1', title: '已完成的一步', status: 'completed' })],
      }),
    });
    expect(wrapper.text()).toContain('已完成的一步');
    expect(wrapper.find('.plan-step-actions').exists()).toBe(false);
    expect(wrapper.find('.plan-actions').exists()).toBe(false);
    expect(wrapper.find('.plan-confirm').exists()).toBe(false);
  });

  it('disables plan actions while busy', async () => {
    const wrapper = mountPanel({
      plan: planView({ status: 'proposed', steps: [planStep({ id: 's1', title: 'a' })] }),
      busy: true,
    });
    const primary = wrapper.get('.primary-action');
    expect(primary.attributes('disabled')).toBeDefined();
    await primary.trigger('click');
    expect(wrapper.emitted('planExecute')).toBeUndefined();
  });
});

describe('TaskPlanPanel 任务视角', () => {
  it('renders task steps with status, details, evidence and verification', () => {
    const wrapper = mountPanel({
      task: taskRecord({
        steps: [
          taskStep({
            id: 's1',
            title: '跑构建',
            status: 'completed',
            evidence: { summary: '构建通过', toolCallIds: [], filesTouched: [] },
          }),
          taskStep({
            id: 's2',
            title: '设计工具契约',
            status: 'in_progress',
            position: 1,
            verification: { kind: 'command', command: 'npm run typecheck' },
          }),
        ],
      }),
    });

    const text = wrapper.text();
    expect(text).toContain('重构 Plan 模式');
    expect(text).toContain('1/2 完成');
    expect(text).toContain('证据：构建通过');
    expect(text).toContain('需命令：npm run typecheck（退出码 0）');
    expect(wrapper.findAll('.work-steps li')).toHaveLength(2);
  });

  it('emits step commands with the current step and status', async () => {
    const wrapper = mountPanel({ task: taskRecord() });
    const rows = wrapper.findAll('.work-steps li');

    // 第一行已完成：只能重开/删除；第二行进行中：完成/阻塞/删除。
    expect(rows[0].findAll('.work-step-actions button').map((button) => button.text())).toEqual([
      '重开',
      '删除',
    ]);
    expect(rows[1].findAll('.work-step-actions button').map((button) => button.text())).toEqual([
      '完成',
      '阻塞',
      '删除',
    ]);
    await stepButton(rows[1], '完成')!.trigger('click');
    expect(wrapper.emitted('setStepStatus')).toEqual([
      [{ step: expect.objectContaining({ id: 's2' }), status: 'completed' }],
    ]);

    // 第三行已阻塞：解除 → pending。
    await stepButton(rows[2], '解除')!.trigger('click');
    expect(wrapper.emitted('setStepStatus')?.at(-1)).toEqual([
      { step: expect.objectContaining({ id: 's3' }), status: 'pending' },
    ]);
  });

  it('requires a reason before blocking a step', async () => {
    const wrapper = mountPanel({ task: taskRecord() });
    const runningRow = wrapper.findAll('.work-steps li')[1];

    await stepButton(runningRow, '阻塞')!.trigger('click');
    expect(wrapper.find('.work-block-form').exists()).toBe(true);

    // 空原因不可提交。
    await wrapper.find('.work-block-form').trigger('submit');
    expect(wrapper.emitted('setStepStatus')).toBeUndefined();

    await wrapper.find('.work-block-form input').setValue('缺前置');
    await wrapper.find('.work-block-form').trigger('submit');
    expect(wrapper.emitted('setStepStatus')).toEqual([
      [{ step: expect.objectContaining({ id: 's2' }), status: 'blocked', reason: '缺前置' }],
    ]);
  });

  it('adds steps and refreshes on demand', async () => {
    const wrapper = mountPanel({ task: taskRecord() });

    await wrapper.find('.task-add-step input').setValue('补一个回归测试');
    await wrapper.find('.task-add-step').trigger('submit');
    expect(wrapper.emitted('addStep')).toEqual([[{ title: '补一个回归测试' }]]);

    await wrapper.find('.work-panel-tools button[title="重新加载"]').trigger('click');
    expect(wrapper.emitted('refresh')).toHaveLength(1);
  });

  it('confirms before force-deleting a completed step', async () => {
    const wrapper = mountPanel({ task: taskRecord() });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      const row = () => wrapper.findAll('.work-steps li')[0];
      await stepButton(row(), '删除')!.trigger('click');
      expect(wrapper.emitted('removeStep')).toBeUndefined(); // 用户取消 → 不发删除

      confirm.mockReturnValue(true);
      await stepButton(row(), '删除')!.trigger('click');
      expect(wrapper.emitted('removeStep')).toEqual([
        [{ step: expect.objectContaining({ id: 's1' }), force: true }],
      ]);
    } finally {
      confirm.mockRestore();
    }
  });

  it('emits cancel and hides edit controls for terminal tasks', async () => {
    const cancelled = mountPanel({ task: taskRecord({ status: 'cancelled' }) });
    expect(cancelled.get('.work-badge').text()).toBe('已取消');
    expect(cancelled.find('.task-cancel').exists()).toBe(false);
    expect(cancelled.find('.task-add-step').exists()).toBe(false);
    expect(cancelled.find('.task-step-actions').text()).toBe(''); // 终态隐藏所有步骤操作

    const active = mountPanel({ task: taskRecord() });
    await active.find('.task-cancel').trigger('click');
    expect(active.emitted('cancelTask')).toHaveLength(1);
  });

  it('offers to create a task when the session has none', async () => {
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain('未创建任务');

    await wrapper.find('.work-panel-tools button').trigger('click');
    const inputs = wrapper.findAll('.task-draft input');
    await inputs[0].setValue('重构 Plan 模式');
    await inputs[1].setValue('把正则解析换成结构化工具契约');
    await wrapper.find('.task-draft').trigger('submit');

    expect(wrapper.emitted('create')).toEqual([
      [{ title: '重构 Plan 模式', goal: '把正则解析换成结构化工具契约' }],
    ]);
  });

  it('surfaces write errors, closes on demand and disables writes while busy', async () => {
    const wrapper = mountPanel({
      task: taskRecord(),
      busy: true,
      error: '任务已被其它窗口修改',
    });
    expect(wrapper.find('.work-error').text()).toContain('任务已被其它窗口修改');
    expect(wrapper.find('.task-add-step button').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.task-cancel').attributes('disabled')).toBeDefined();
    await wrapper.find('.work-panel-tools button[title="收起面板"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});

describe('TaskPlanPanel 恢复与提问入口（M3）', () => {
  function recoveryItem(overrides: Partial<TaskRecoveryItem> = {}): TaskRecoveryItem {
    return {
      taskId: 'task-1',
      title: '重构 Plan 模式',
      goal: 'g',
      status: 'in_progress',
      sessionId: 'session-1',
      origin: 'user',
      attempt: 2,
      updatedAt: '2026-08-21T10:05:00.000Z',
      lease: { active: false, heldByOther: false },
      step: { id: 's2', title: '设计工具契约', status: 'in_progress' },
      sideEffect: 'none',
      action: 'auto_resume',
      reason: '中断发生在两次动作之间（没有未决副作用），可安全继续。',
      requiresConfirmation: false,
      ...overrides,
    };
  }

  it('shows the interruption and emits resume / retry commands', async () => {
    const wrapper = mountPanel({ task: taskRecord(), recovery: [recoveryItem()] });

    expect(wrapper.find('.work-recovery').text()).toContain('上次运行被中断');
    expect(wrapper.find('.work-recovery').text()).toContain('[s2] 设计工具契约');
    expect(wrapper.find('.work-recovery').text()).toContain('可安全继续');

    const buttons = wrapper.findAll('.work-recovery-actions button');
    expect(buttons.map((button) => button.text())).toEqual(['继续执行', '重试当前步骤']);
    await buttons[0].trigger('click');
    expect(wrapper.emitted('resumeTask')).toEqual([[{ mode: 'continue' }]]);
    await buttons[1].trigger('click');
    expect(wrapper.emitted('resumeTask')?.at(-1)).toEqual([{ mode: 'retry_step' }]);
  });

  it('warns about side effects and shows the artifact to verify', () => {
    const wrapper = mountPanel({
      task: taskRecord(),
      recovery: [
        recoveryItem({
          sideEffect: 'write',
          action: 'verify_then_resume',
          requiresConfirmation: true,
          inFlightTool: 'write',
          artifact: { path: '/workspace/db/migration.sql', exists: false },
          reason: '中断时正在执行写操作（write）；将先验证产物，存在则补记为已完成，不重跑。',
        }),
      ],
    });

    const text = wrapper.find('.work-recovery').text();
    expect(text).toContain('需要你确认副作用风险');
    expect(text).toContain('待验证产物：/workspace/db/migration.sql（未找到）');
  });

  it('offers resume for a blocked task even without a recovery entry', async () => {
    const wrapper = mountPanel({
      task: taskRecord({ status: 'blocked', blockedReason: '上次执行中断，产物状态需人工确认' }),
      recovery: [],
    });

    const block = wrapper.find('.work-recovery');
    expect(block.text()).toContain('任务被阻塞');
    expect(block.text()).toContain('产物状态需人工确认');
    await block.findAll('button')[0].trigger('click');
    expect(wrapper.emitted('resumeTask')).toEqual([[{ mode: 'continue' }]]);
  });

  it('ignores recovery entries of other tasks and sessions', () => {
    const wrapper = mountPanel({
      task: taskRecord(),
      recovery: [recoveryItem({ taskId: 'other-task' })],
    });
    expect(wrapper.find('.work-recovery').exists()).toBe(false);
  });
});
