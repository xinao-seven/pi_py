import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import TaskPanel from '@/components/TaskPanel.vue';
import type { TaskRecoveryItem, TaskRecord, TaskStep } from '@/types';

function step(overrides: Partial<TaskStep> = {}): TaskStep {
  return {
    id: 's1',
    title: '读现有实现',
    status: 'pending',
    position: 0,
    ...overrides,
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
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
      step({
        id: 's1',
        title: '读现有实现',
        status: 'completed',
        completedAt: '2026-08-21T10:01:00.000Z',
      }),
      step({
        id: 's2',
        title: '设计工具契约',
        status: 'in_progress',
        position: 1,
        details: 'submit_plan / complete_step',
        verification: { kind: 'command', command: 'npm run typecheck' },
      }),
      step({ id: 's3', title: '写迁移', status: 'blocked', position: 2, blockedReason: '缺前置' }),
    ],
    ...overrides,
  };
}

/** 按文案找步骤行里的按钮（比按下标稳）。 */
function stepButton(
  row: { findAll: (selector: string) => Array<{ text: () => string }> },
  label: string,
) {
  return row.findAll('.task-step-actions button').find((button) => button.text() === label);
}

describe('TaskPanel', () => {
  it('offers to create a task when the session has none', async () => {
    const wrapper = mount(TaskPanel, { props: { task: null, sessionId: 'session-1' } });
    expect(wrapper.text()).toContain('未创建任务');

    await wrapper.findAll('.task-panel-tools button')[1].trigger('click');
    const inputs = wrapper.findAll('.task-draft input');
    await inputs[0].setValue('重构 Plan 模式');
    await inputs[1].setValue('把正则解析换成结构化工具契约');
    await wrapper.find('.task-draft').trigger('submit');

    expect(wrapper.emitted('create')).toEqual([
      [{ title: '重构 Plan 模式', goal: '把正则解析换成结构化工具契约' }],
    ]);
  });

  it('renders steps with status, evidence and verification', () => {
    const wrapper = mount(TaskPanel, {
      props: {
        task: task({
          steps: [
            step({
              id: 's1',
              title: '跑构建',
              status: 'completed',
              evidence: { summary: '构建通过', toolCallIds: [], filesTouched: [] },
            }),
            step({
              id: 's2',
              title: '设计工具契约',
              status: 'in_progress',
              position: 1,
              verification: { kind: 'command', command: 'npm run typecheck' },
            }),
          ],
        }),
        sessionId: 'session-1',
      },
    });

    const text = wrapper.text();
    expect(text).toContain('重构 Plan 模式');
    expect(text).toContain('1/2 完成');
    expect(text).toContain('进行中');
    expect(text).toContain('证据：构建通过');
    expect(text).toContain('验证：npm run typecheck');
    expect(wrapper.findAll('.task-steps li')).toHaveLength(2);
  });

  it('emits step commands with the current step and status', async () => {
    const wrapper = mount(TaskPanel, { props: { task: task(), sessionId: 'session-1' } });
    const rows = wrapper.findAll('.task-steps li');

    // 第一行已完成：只能重开/删除；第二行进行中：完成/阻塞/删除。
    expect(rows[0].findAll('.task-step-actions button').map((button) => button.text())).toEqual([
      '重开',
      '删除',
    ]);
    expect(rows[1].findAll('.task-step-actions button').map((button) => button.text())).toEqual([
      '完成',
      '阻塞',
      '删除',
    ]);
    await stepButton(rows[1], '完成')!.trigger('click');
    expect(wrapper.emitted('set-step-status')).toEqual([
      [{ step: expect.objectContaining({ id: 's2' }), status: 'completed' }],
    ]);

    // 第三行已阻塞：解除 → pending。
    await stepButton(rows[2], '解除')!.trigger('click');
    expect(wrapper.emitted('set-step-status')?.at(-1)).toEqual([
      { step: expect.objectContaining({ id: 's3' }), status: 'pending' },
    ]);
  });

  it('requires a reason before blocking a step', async () => {
    const wrapper = mount(TaskPanel, { props: { task: task(), sessionId: 'session-1' } });
    const runningRow = wrapper.findAll('.task-steps li')[1];

    await stepButton(runningRow, '阻塞')!.trigger('click');
    expect(wrapper.find('.task-block-form').exists()).toBe(true);

    // 空原因不可提交。
    await wrapper.find('.task-block-form').trigger('submit');
    expect(wrapper.emitted('set-step-status')).toBeUndefined();

    await wrapper.find('.task-block-form input').setValue('缺前置');
    await wrapper.find('.task-block-form').trigger('submit');
    expect(wrapper.emitted('set-step-status')).toEqual([
      [{ step: expect.objectContaining({ id: 's2' }), status: 'blocked', reason: '缺前置' }],
    ]);
  });

  it('adds steps and refreshes on demand', async () => {
    const wrapper = mount(TaskPanel, { props: { task: task(), sessionId: 'session-1' } });

    await wrapper.find('.task-add-step input').setValue('补一个回归测试');
    await wrapper.find('.task-add-step').trigger('submit');
    expect(wrapper.emitted('add-step')).toEqual([[{ title: '补一个回归测试' }]]);

    await wrapper.findAll('.task-panel-tools button')[0].trigger('click');
    expect(wrapper.emitted('refresh')).toHaveLength(1);
  });

  it('confirms before force-deleting a completed step', async () => {
    const wrapper = mount(TaskPanel, { props: { task: task(), sessionId: 'session-1' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      const row = () => wrapper.findAll('.task-steps li')[0];
      await stepButton(row(), '删除')!.trigger('click');
      expect(wrapper.emitted('remove-step')).toBeUndefined(); // 用户取消 → 不发删除

      confirm.mockReturnValue(true);
      await stepButton(row(), '删除')!.trigger('click');
      expect(wrapper.emitted('remove-step')).toEqual([
        [{ step: expect.objectContaining({ id: 's1' }), force: true }],
      ]);
    } finally {
      confirm.mockRestore();
    }
  });

  it('emits cancel and hides edit controls for terminal tasks', async () => {
    const wrapper = mount(TaskPanel, {
      props: { task: task({ status: 'cancelled' }), sessionId: 'session-1' },
    });
    expect(wrapper.text()).toContain('已取消');
    expect(wrapper.find('.task-cancel').exists()).toBe(false);
    expect(wrapper.find('.task-add-step').exists()).toBe(false);
    expect(wrapper.find('.task-step-actions').text()).toBe(''); // 终态隐藏所有步骤操作

    const active = mount(TaskPanel, { props: { task: task(), sessionId: 'session-1' } });
    await active.find('.task-cancel').trigger('click');
    expect(active.emitted('cancel')).toHaveLength(1);
  });

  it('surfaces write errors and busy state', () => {
    const wrapper = mount(TaskPanel, {
      props: { task: task(), sessionId: 'session-1', busy: true, error: '任务已被其它窗口修改' },
    });
    expect(wrapper.find('.task-error').text()).toContain('任务已被其它窗口修改');
    expect(wrapper.find('.task-add-step button').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.task-cancel').attributes('disabled')).toBeDefined();
  });

  it('collapses to a one-line summary', async () => {
    const wrapper = mount(TaskPanel, { props: { task: task(), sessionId: 'session-1' } });
    await wrapper.find('.task-panel-toggle').trigger('click');
    expect(wrapper.find('.task-panel-body').exists()).toBe(false);
    expect(wrapper.text()).toContain('重构 Plan 模式');
  });
});

describe('TaskPanel recovery (M3)', () => {
  function recoveryItem(overrides: Partial<TaskRecoveryItem> = {}): TaskRecoveryItem {
    return {
      taskId: 'task-1',
      title: '重构 Plan 模式',
      goal: 'g',
      status: 'in_progress',
      sessionId: 'session-1',
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
    const wrapper = mount(TaskPanel, {
      props: { task: task(), sessionId: 'session-1', recovery: [recoveryItem()] },
    });

    expect(wrapper.find('.task-recovery').text()).toContain('上次运行被中断');
    expect(wrapper.find('.task-recovery').text()).toContain('[s2] 设计工具契约');
    expect(wrapper.find('.task-recovery').text()).toContain('可安全继续');

    const buttons = wrapper.findAll('.task-recovery-actions button');
    expect(buttons.map((button) => button.text())).toEqual(['继续执行', '重试当前步骤']);
    await buttons[0].trigger('click');
    expect(wrapper.emitted('resume')).toEqual([[{ mode: 'continue' }]]);
    await buttons[1].trigger('click');
    expect(wrapper.emitted('resume')?.at(-1)).toEqual([{ mode: 'retry_step' }]);
  });

  it('warns about side effects and shows the artifact to verify', () => {
    const wrapper = mount(TaskPanel, {
      props: {
        task: task(),
        sessionId: 'session-1',
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
      },
    });

    const text = wrapper.find('.task-recovery').text();
    expect(text).toContain('需要你确认副作用风险');
    expect(text).toContain('待验证产物：/workspace/db/migration.sql（未找到）');
    // 头部工具条也有一个「继续执行」，方便一眼看到。
    expect(wrapper.find('.task-resume').exists()).toBe(true);
  });

  it('offers resume for a blocked task even without a recovery entry', async () => {
    const wrapper = mount(TaskPanel, {
      props: {
        task: task({ status: 'blocked', blockedReason: '上次执行中断，产物状态需人工确认' }),
        sessionId: 'session-1',
        recovery: [],
      },
    });

    const block = wrapper.find('.task-recovery');
    expect(block.text()).toContain('任务被阻塞');
    expect(block.text()).toContain('产物状态需人工确认');
    await block.findAll('button')[0].trigger('click');
    expect(wrapper.emitted('resume')).toEqual([[{ mode: 'continue' }]]);
  });

  it('ignores recovery entries of other tasks and sessions', () => {
    const wrapper = mount(TaskPanel, {
      props: {
        task: task(),
        sessionId: 'session-1',
        recovery: [recoveryItem({ taskId: 'other-task' })],
      },
    });
    expect(wrapper.find('.task-recovery').exists()).toBe(false);
    expect(wrapper.find('.task-resume').exists()).toBe(false);
  });
});
