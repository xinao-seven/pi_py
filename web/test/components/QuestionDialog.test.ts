import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import QuestionDialog from '@/components/QuestionDialog.vue';
import type { PendingQuestion } from '@/types';

function pending(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    sessionId: 'session-1',
    questionId: 'question-1',
    toolCallId: 'call-1',
    createdAt: '2026-08-21T10:00:00.000Z',
    questions: [
      {
        id: 'q1',
        question: '要兼容 CLI 的旧会话吗？',
        options: ['要（保留兼容层）', '不要（直接换新格式）'],
      },
    ],
    ...overrides,
  };
}

describe('QuestionDialog（M4.1 提问弹窗）', () => {
  it('renders the question with its options and a free-text box', () => {
    const wrapper = mount(QuestionDialog, { props: { pending: pending() } });
    expect(wrapper.text()).toContain('要兼容 CLI 的旧会话吗？');
    const labels = wrapper.findAll('.question-option').map((item) => item.text());
    expect(labels).toEqual(['要（保留兼容层）', '不要（直接换新格式）']);
    expect(wrapper.find('.question-text').exists()).toBe(true);
    expect(wrapper.text()).toContain('0/1 已答');
    expect(wrapper.text()).toContain('Agent 提问');
  });

  it('submits the selected option', async () => {
    const wrapper = mount(QuestionDialog, { props: { pending: pending() } });
    await wrapper.findAll('.question-option')[1].trigger('click');
    expect(wrapper.findAll('.question-option')[1].classes()).toContain('question-option--selected');

    await wrapper.get('.question-submit').trigger('click');
    expect(wrapper.emitted('submit')).toEqual([
      [[{ id: 'q1', selected: ['不要（直接换新格式）'] }]],
    ]);
  });

  it('supports free-text answers (with or without options)', async () => {
    const withText = mount(QuestionDialog, { props: { pending: pending() } });
    await withText.get('.question-text').setValue('  按你判断就行  ');
    await withText.get('.question-submit').trigger('click');
    expect(withText.emitted('submit')).toEqual([
      [[{ id: 'q1', selected: [], text: '按你判断就行' }]],
    ]);

    const textOnly = mount(QuestionDialog, {
      props: {
        pending: pending({ questions: [{ id: 'q1', question: '生产环境地址是什么？' }] }),
      },
    });
    expect(textOnly.find('.question-options').exists()).toBe(false);
    await textOnly.get('.question-text').setValue('https://example.com');
    await textOnly.get('.question-submit').trigger('click');
    expect(textOnly.emitted('submit')).toEqual([
      [[{ id: 'q1', selected: [], text: 'https://example.com' }]],
    ]);
  });

  it('collects multiple questions at once (single + multi select + text)', async () => {
    const wrapper = mount(QuestionDialog, {
      props: {
        pending: pending({
          questions: [
            { id: 'q1', question: '继续吗？', options: ['继续', '停'] },
            {
              id: 'platforms',
              question: '需要支持哪些平台？',
              options: ['Windows', 'macOS', 'Linux'],
              multiSelect: true,
            },
            { id: 'q3', question: '备注？', allowFreeText: true },
          ],
        }),
      },
    });
    expect(wrapper.text()).toContain('0/3 已答');
    expect(wrapper.text()).toContain('可多选');

    const items = wrapper.findAll('.question-item');
    // 第一题单选
    await items[0].findAll('.question-option')[0].trigger('click');
    // 第二题多选
    await items[1].findAll('.question-option')[0].trigger('click');
    await items[1].findAll('.question-option')[2].trigger('click');
    // 第三题自由输入
    await items[2].get('.question-text').setValue('顺带兼容 WSL');
    expect(wrapper.text()).toContain('3/3 已答');

    await wrapper.get('.question-submit').trigger('click');
    expect(wrapper.emitted('submit')).toEqual([
      [
        [
          { id: 'q1', selected: ['继续'] },
          { id: 'platforms', selected: ['Windows', 'Linux'] },
          { id: 'q3', selected: [], text: '顺带兼容 WSL' },
        ],
      ],
    ]);
  });

  it('marks unanswered questions as skipped instead of blocking submit', async () => {
    const wrapper = mount(QuestionDialog, {
      props: {
        pending: pending({
          questions: [
            { id: 'q1', question: '一', options: ['a'] },
            { id: 'q2', question: '二', options: ['b'] },
          ],
        }),
      },
    });
    await wrapper.findAll('.question-option')[0].trigger('click');
    expect(wrapper.text()).toContain('还有 1 题没答');

    await wrapper.get('.question-submit').trigger('click');
    expect(wrapper.emitted('submit')).toEqual([
      [[{ id: 'q1', selected: ['a'] }, { id: 'q2', selected: [], skipped: true }]],
    ]);
  });

  it('lets the user re-click a radio option to clear it', async () => {
    const wrapper = mount(QuestionDialog, { props: { pending: pending() } });
    const option = wrapper.findAll('.question-option')[0];
    await option.trigger('click');
    expect(option.classes()).toContain('question-option--selected');
    await option.trigger('click');
    expect(option.classes()).not.toContain('question-option--selected');
  });

  it('hides the text box when allowFreeText is false', () => {
    const wrapper = mount(QuestionDialog, {
      props: {
        pending: pending({
          questions: [
            { id: 'q1', question: '选一个', options: ['a', 'b'], allowFreeText: false },
          ],
        }),
      },
    });
    expect(wrapper.find('.question-text').exists()).toBe(false);
    expect(wrapper.text()).toContain('只能从上面的选项中选择');
  });

  it('emits cancel for "let the AI decide"', async () => {
    const wrapper = mount(QuestionDialog, { props: { pending: pending() } });
    await wrapper.get('.question-cancel').trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  it('clears the draft when a new question arrives', async () => {
    const wrapper = mount(QuestionDialog, { props: { pending: pending() } });
    await wrapper.get('.question-text').setValue('写了一半');
    await wrapper.setProps({
      pending: pending({
        questionId: 'question-2',
        questions: [{ id: 'q1', question: '另一个问题？' }],
      }),
    });
    expect((wrapper.get('.question-text').element as HTMLTextAreaElement).value).toBe('');
    expect(wrapper.text()).toContain('另一个问题？');
  });

  it('disables the actions while submitting', async () => {
    const wrapper = mount(QuestionDialog, { props: { pending: pending(), busy: true } });
    expect(wrapper.get('.question-submit').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.question-cancel').attributes('disabled')).toBeDefined();
    await wrapper.get('.question-submit').trigger('click');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });
});
