import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import PlanProgress from '@/components/PlanProgress.vue';
import type { PlanStatus, PlanStepView, PlanView } from '@/types';

function step(overrides: Partial<PlanStepView> & { id: string; title: string }): PlanStepView {
  return { status: 'pending', ...overrides };
}

function view(overrides: Partial<PlanView> = {}): PlanView {
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

function mountPlan(plan: PlanView | null, busy = false) {
  return mount(PlanProgress, { props: { plan, sessionId: 'session-1', busy } });
}

describe('PlanProgress（M4：计划是任务的视图）', () => {
  it('renders nothing without a plan (empty planId means "no plan")', () => {
    expect(mountPlan(null).find('.plan-progress').exists()).toBe(false);
    const empty = mountPlan(view({ planId: '', taskId: '', status: 'abandoned' }));
    expect(empty.find('.plan-progress').exists()).toBe(false);
  });

  const labels: Array<[PlanStatus, string]> = [
    ['drafting', '规划中'],
    ['proposed', '待确认'],
    ['executing', '执行中'],
    ['paused', '已暂停'],
    ['completed', '已完成'],
    ['abandoned', '已放弃'],
  ];
  it.each(labels)('shows the %s status as %s', (status, label) => {
    const wrapper = mountPlan(view({ status, steps: [step({ id: 's1', title: '第一步' })] }));
    expect(wrapper.get('.plan-progress-badge').text()).toBe(label);
  });

  it('shows step status, verification requirement and evidence', () => {
    const wrapper = mountPlan(
      view({
        status: 'executing',
        steps: [
          step({
            id: 's1',
            title: '跑测试',
            status: 'completed',
            verification: { kind: 'command', command: 'npm test' },
            evidence: {
              command: undefined,
              summary: '测试全绿',
              toolCallIds: [],
              filesTouched: [],
            },
          }),
          step({
            id: 's2',
            title: '产出迁移文件',
            status: 'in_progress',
            verification: { kind: 'file', path: 'migration.sql' },
          }),
          step({ id: 's3', title: '更新文档', status: 'blocked', blockedReason: '缺凭据' }),
        ],
      }),
    );
    const text = wrapper.text();
    expect(text).toContain('证据：测试全绿');
    expect(text).toContain('需产物：migration.sql');
    expect(text).toContain('已阻塞：缺凭据');
    expect(text).toContain('1/3 完成');
    const steps = wrapper.findAll('.plan-steps li');
    expect(steps[0].classes()).toContain('plan-step--completed');
    expect(steps[1].classes()).toContain('plan-step--current');
    expect(steps[2].classes()).toContain('plan-step--blocked');
  });

  it('emits execute / refine / abandon while awaiting confirmation', async () => {
    const wrapper = mountPlan(
      view({ status: 'proposed', steps: [step({ id: 's1', title: 'a' })] }),
    );

    await wrapper.get('.primary-action').trigger('click');
    expect(wrapper.emitted('execute')).toHaveLength(1);

    await wrapper.get('textarea').setValue(' 把第二步拆开 ');
    await wrapper.findAll('.plan-confirm-actions button')[1].trigger('click');
    expect(wrapper.emitted('refine')).toEqual([['把第二步拆开']]);
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('');

    await wrapper.findAll('.plan-confirm-actions button')[2].trigger('click');
    expect(wrapper.emitted('abandon')).toHaveLength(1);
  });

  it('emits pause while executing and resume while paused', async () => {
    const executing = mountPlan(
      view({ status: 'executing', steps: [step({ id: 's1', title: 'a' })] }),
    );
    const pauseButton = executing.findAll('.plan-progress-actions button')[0];
    expect(pauseButton.text()).toBe('暂停');
    await pauseButton.trigger('click');
    expect(executing.emitted('pause')).toHaveLength(1);

    const paused = mountPlan(view({ status: 'paused', steps: [step({ id: 's1', title: 'a' })] }));
    const resumeButton = paused.findAll('.plan-progress-actions button')[0];
    expect(resumeButton.text()).toBe('继续执行');
    await resumeButton.trigger('click');
    expect(paused.emitted('resume')).toHaveLength(1);
  });

  it('edits, skips, reopens and removes steps through task writes', async () => {
    const wrapper = mountPlan(
      view({
        status: 'executing',
        steps: [
          step({ id: 's1', title: '第一步' }),
          step({ id: 's2', title: '第二步', status: 'skipped' }),
        ],
      }),
    );
    const rows = wrapper.findAll('.plan-steps li');

    // 改名：双击标题进入编辑，回车提交。
    await rows[0].get('strong').trigger('dblclick');
    const input = rows[0].get('input');
    await input.setValue('第一步（改名）');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('stepPatch')).toEqual([
      [{ stepId: 's1', patch: { title: '第一步（改名）' } }],
    ]);

    // 跳过 / 恢复。
    await rows[0].findAll('.plan-step-actions button')[1].trigger('click');
    expect(wrapper.emitted('stepPatch')?.at(-1)).toEqual([
      { stepId: 's1', patch: { status: 'skipped' } },
    ]);
    await rows[1].findAll('.plan-step-actions button')[1].trigger('click');
    expect(wrapper.emitted('stepPatch')?.at(-1)).toEqual([
      { stepId: 's2', patch: { status: 'pending' } },
    ]);

    // 删除。
    await rows[0].findAll('.plan-step-actions button')[2].trigger('click');
    expect(wrapper.emitted('stepRemove')).toEqual([[{ stepId: 's1' }]]);
  });

  it('hides step editing on terminal plans but keeps the history visible', () => {
    const wrapper = mountPlan(
      view({
        status: 'completed',
        steps: [step({ id: 's1', title: '已完成的一步', status: 'completed' })],
      }),
    );
    expect(wrapper.text()).toContain('已完成的一步');
    expect(wrapper.find('.plan-step-actions').exists()).toBe(false);
    expect(wrapper.find('.plan-progress-actions').exists()).toBe(false);
  });

  it('disables actions while busy', async () => {
    const wrapper = mountPlan(
      view({ status: 'proposed', steps: [step({ id: 's1', title: 'a' })] }),
      true,
    );
    const primary = wrapper.get('.primary-action');
    expect(primary.attributes('disabled')).toBeDefined();
    await primary.trigger('click');
    expect(wrapper.emitted('execute')).toBeUndefined();
  });
});
