import { describe, expect, it } from 'vitest';

import {
  derivePlanStatus,
  emptyPlanView,
  isActivePlanStatus,
  planAwaitingUserAction,
  planTitleFromMessage,
  toPlanView,
} from '../../../src/services/platform/plan-model.js';
import {
  newStep,
  type StepStatus,
  type StoredPlanStatus,
  type TaskRecord,
  type TaskStatus,
} from '../../../src/services/platform/task-model.js';

/** 造一个任务记录（只填本文件关心的字段）。 */
function makeTask(options: {
  status?: TaskStatus;
  plan?: StoredPlanStatus;
  steps?: Array<{ id: string; title: string; status: StepStatus }>;
  question?: string;
}): TaskRecord {
  const steps = (options.steps ?? [])
    .map((step, index) => newStep({ id: step.id, title: step.title, position: index }))
    .map((step, index) => ({ ...step, status: options.steps?.[index]?.status ?? 'pending' }));
  return {
    id: 'task-1',
    title: '重构 Plan 模式',
    goal: '把正则解析换成结构化工具契约',
    status: options.status ?? 'pending',
    steps,
    origin: 'plan',
    sessionId: 'session-1',
    revision: 3,
    execution: {
      attempt: 1,
      ...(options.plan === undefined
        ? {}
        : {
            plan: {
              status: options.plan,
              draftingSince: '2026-08-21T10:00:00.000Z',
              ...(options.question === undefined ? {} : { question: options.question }),
            },
          }),
    },
    createdAt: '2026-08-21T10:00:00.000Z',
    updatedAt: '2026-08-21T10:05:00.000Z',
  };
}

describe('derivePlanStatus', () => {
  it('maps the task terminal states to abandoned / completed', () => {
    expect(derivePlanStatus(makeTask({ status: 'cancelled', plan: 'executing' }))).toBe(
      'abandoned',
    );
    expect(derivePlanStatus(makeTask({ status: 'completed', plan: 'executing' }))).toBe(
      'completed',
    );
  });

  it('keeps the stored intent for drafting / proposed / executing', () => {
    expect(derivePlanStatus(makeTask({ plan: 'drafting' }))).toBe('drafting');
    expect(derivePlanStatus(makeTask({ plan: 'proposed' }))).toBe('proposed');
    expect(derivePlanStatus(makeTask({ status: 'in_progress', plan: 'executing' }))).toBe(
      'executing',
    );
  });

  it('treats blocked tasks as paused (needs a human) and honours explicit paused', () => {
    expect(derivePlanStatus(makeTask({ status: 'blocked', plan: 'executing' }))).toBe('paused');
    expect(derivePlanStatus(makeTask({ status: 'in_progress', plan: 'paused' }))).toBe('paused');
  });

  it('falls back to drafting when no plan state was written yet', () => {
    expect(derivePlanStatus(makeTask({}))).toBe('drafting');
  });
});

describe('planAwaitingUserAction', () => {
  it('is true for proposed / paused and for a pending question', () => {
    expect(planAwaitingUserAction('proposed')).toBe(true);
    expect(planAwaitingUserAction('paused')).toBe(true);
    expect(
      planAwaitingUserAction('drafting', { status: 'drafting', question: '要兼容 CLI 吗？' }),
    ).toBe(true);
  });

  it('is false while drafting / executing / finished', () => {
    expect(planAwaitingUserAction('drafting')).toBe(false);
    expect(planAwaitingUserAction('executing')).toBe(false);
    expect(planAwaitingUserAction('completed')).toBe(false);
    expect(planAwaitingUserAction('abandoned')).toBe(false);
  });
});

describe('toPlanView', () => {
  it('projects the task into a plan view with steps in order', () => {
    const view = toPlanView(
      makeTask({
        status: 'in_progress',
        plan: 'executing',
        steps: [
          { id: 's1', title: '读现有实现', status: 'completed' },
          { id: 's2', title: '写迁移', status: 'in_progress' },
        ],
      }),
    );
    expect(view).toMatchObject({
      planId: 'task-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      status: 'executing',
      revision: 3,
      title: '重构 Plan 模式',
      awaitingUserAction: false,
      draftingSince: '2026-08-21T10:00:00.000Z',
    });
    expect(view.steps.map((step) => [step.id, step.status])).toEqual([
      ['s1', 'completed'],
      ['s2', 'in_progress'],
    ]);
  });

  it('keeps planId/taskId identical so frontend never juggles two ids', () => {
    const view = toPlanView(makeTask({ plan: 'proposed' }));
    expect(view.planId).toBe(view.taskId);
    expect(view.awaitingUserAction).toBe(true);
  });

  it('emptyPlanView is inert and distinguishable from a real plan', () => {
    const view = emptyPlanView('session-9');
    expect(view.planId).toBe('');
    expect(isActivePlanStatus(view.status)).toBe(false);
  });
});

describe('planTitleFromMessage', () => {
  it('takes the first meaningful line and strips markdown noise', () => {
    expect(planTitleFromMessage('# 重构 Plan 模式\n\n细节…')).toBe('重构 Plan 模式');
    expect(planTitleFromMessage('\n\n- 帮我看看这个 bug')).toBe('帮我看看这个 bug');
  });

  it('truncates long titles and falls back when empty', () => {
    expect(planTitleFromMessage('x'.repeat(200))?.length).toBe(80);
    expect(planTitleFromMessage('   \n  ')).toBe('未命名计划');
  });
});

describe('isActivePlanStatus', () => {
  it('only completed / abandoned are inactive', () => {
    expect(['drafting', 'proposed', 'executing', 'paused'].map(isActivePlanStatus)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(isActivePlanStatus('completed')).toBe(false);
    expect(isActivePlanStatus('abandoned')).toBe(false);
  });
});
