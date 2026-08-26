import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import PlanProgress from '@/components/PlanProgress.vue';
import type { PlanSnapshot } from '@/types';

function snapshot(overrides: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return {
    sessionId: 'session-1',
    mode: 'planning',
    todos: [],
    awaitingConfirmation: false,
    ...overrides,
  };
}

describe('PlanProgress', () => {
  it('renders nothing when plan is null or in normal mode', () => {
    const empty = mount(PlanProgress, {
      props: { plan: null, sessionId: 'session-1', busy: false },
    });
    expect(empty.find('.plan-progress').exists()).toBe(false);
    const normal = mount(PlanProgress, {
      props: { plan: snapshot({ mode: 'normal' }), sessionId: 'session-1', busy: false },
    });
    expect(normal.find('.plan-progress').exists()).toBe(false);
  });

  it('shows a generated plan and emits execute / refine / disable', async () => {
    const wrapper = mount(PlanProgress, {
      props: {
        plan: snapshot({
          mode: 'planning',
          awaitingConfirmation: true,
          todos: [{ step: 1, text: 'Add the server route', completed: false }],
        }),
        sessionId: 'session-1',
        busy: false,
      },
    });

    expect(wrapper.text()).toContain('Add the server route');

    await wrapper.find('.primary-action').trigger('click');
    expect(wrapper.emitted('execute')).toHaveLength(1);

    await wrapper.get('textarea').setValue('Keep the existing API style');
    await wrapper.findAll('.plan-confirm-actions button')[1].trigger('click');
    expect(wrapper.emitted('refine')).toEqual([['Keep the existing API style']]);

    await wrapper.findAll('.plan-confirm-actions button')[2].trigger('click');
    expect(wrapper.emitted('disable')).toHaveLength(1);
  });

  it('highlights the current unfinished step and can be disabled while executing', () => {
    const wrapper = mount(PlanProgress, {
      props: {
        plan: snapshot({
          mode: 'executing',
          awaitingConfirmation: false,
          todos: [
            { step: 1, text: 'Add the server route', completed: true },
            { step: 2, text: 'Implement the API', completed: false },
            { step: 3, text: 'Wire the panel', completed: false },
          ],
        }),
        sessionId: 'session-1',
        busy: false,
      },
    });

    const steps = wrapper.findAll('.plan-steps li');
    expect(steps).toHaveLength(3);
    expect(steps[0].classes()).toContain('plan-step--completed');
    expect(steps[1].classes()).toContain('plan-step--current');
    expect(steps[1].classes()).not.toContain('plan-step--completed');

    const exit = wrapper.findAll('.plan-progress-actions button');
    expect(exit).toHaveLength(1);
    exit[0].trigger('click');
    expect(wrapper.emitted('disable')).toHaveLength(1);
  });
});
