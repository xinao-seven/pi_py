import { mount } from '@vue/test-utils';

import type { SessionTreeNode } from '@/types';
import BranchNavigator from '@/components/BranchNavigator.vue';

const tree: SessionTreeNode[] = [
  {
    entry: {
      type: 'message',
      id: 'user-1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: '先检查实现' },
    },
    children: [
      {
        entry: {
          type: 'message',
          id: 'assistant-1',
          parentId: 'user-1',
          timestamp: '2026-01-01T00:00:01Z',
          message: { role: 'assistant', content: [{ type: 'text', text: '检查完成' }] },
        },
        children: [],
      },
    ],
  },
];

describe('BranchNavigator', () => {
  it('navigates entries, forks assistant leaves, and emits merge sources', async () => {
    const wrapper = mount(BranchNavigator, {
      props: {
        tree,
        leafId: 'assistant-1',
        currentSessionId: 'current',
        sessions: [
          {
            id: 'current',
            path: null,
            cwd: 'C:/work',
            name: '当前',
            created: '2026-01-01',
            modified: '2026-01-01',
            messageCount: 2,
            firstMessage: '当前',
            parentSessionId: null,
            parentSessionPath: null,
          },
          {
            id: 'source',
            path: null,
            cwd: 'C:/work',
            name: '来源',
            created: '2026-01-01',
            modified: '2026-01-01',
            messageCount: 2,
            firstMessage: '来源',
            parentSessionId: null,
            parentSessionPath: null,
          },
        ],
      },
    });

    const branchSelect = wrapper.find('.branch-field select');
    await branchSelect.setValue('user-1');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '定位')!
      .trigger('click');
    expect(wrapper.emitted('navigate')).toEqual([['user-1']]);

    await branchSelect.setValue('assistant-1');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Fork')!
      .trigger('click');
    expect(wrapper.emitted('fork')).toEqual([['assistant-1']]);

    await wrapper.find('.merge-popover select').setValue('source');
    await wrapper.find('.merge-popover button').trigger('click');
    expect(wrapper.emitted('merge')).toEqual([['source']]);
  });
});
