import { flushPromises, mount } from '@vue/test-utils';
import { vi } from 'vitest';

import ChatInput from '@/components/ChatInput.vue';

describe('ChatInput', () => {
  it('submits trimmed text with Enter', async () => {
    const wrapper = mount(ChatInput, { props: { running: false } });
    const input = wrapper.get('textarea');
    await input.setValue('  inspect the project  ');
    await input.trigger('keydown', { key: 'Enter' });

    // 第三参是发送方式（M4）：默认 direct。
    expect(wrapper.emitted('send')).toEqual([['inspect the project', undefined, 'direct']]);
    expect((input.element as HTMLTextAreaElement).value).toBe('');
  });

  it('shows abort while the agent is running', async () => {
    const wrapper = mount(ChatInput, { props: { running: true } });

    await wrapper.get('button.abort-button').trigger('click');

    expect(wrapper.emitted('abort')).toHaveLength(1);
    expect(wrapper.find('button.send-button').exists()).toBe(false);
  });

  it('can steer or queue a follow-up while running', async () => {
    const wrapper = mount(ChatInput, { props: { running: true } });
    const input = wrapper.get('textarea');
    await input.setValue('change direction');
    await wrapper.get('button.queue-button').trigger('click');
    await input.setValue('next request');
    await wrapper.findAll('button.queue-button')[1].trigger('click');

    expect(wrapper.emitted('steer')).toEqual([['change direction']]);
    expect(wrapper.emitted('followUp')).toEqual([['next request']]);
  });

  it('accepts an image-only message', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:preview',
      revokeObjectURL: vi.fn(),
    });
    const wrapper = mount(ChatInput, { props: { running: false } });
    const input = wrapper.get('input[type="file"]');
    const file = new File([new Uint8Array([1, 2, 3])], 'pixel.png', { type: 'image/png' });
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('.image-attachment').exists()).toBe(true));
    await wrapper.get('form').trigger('submit');

    const emitted = wrapper.emitted('send')?.[0];
    expect(emitted?.[0]).toBe('');
    expect(emitted?.[1]).toEqual([
      expect.objectContaining({ mimeType: 'image/png', name: 'pixel.png' }),
    ]);
    vi.unstubAllGlobals();
  });
});

describe('ChatInput 发送方式（M4）', () => {
  // 发送方式是「记忆上次选择」的（localStorage），测试之间必须清干净，
  // 否则用例顺序会互相影响。
  beforeEach(() => localStorage.clear());

  it('sends with mode=plan when 先规划 is selected', async () => {
    const wrapper = mount(ChatInput, { props: { running: false, planAvailable: true } });
    const options = wrapper.findAll('.send-mode-option');
    expect(options.map((option) => option.text())).toEqual(['直接执行', '先规划']);

    await options[1].trigger('click');
    expect(options[1].classes()).toContain('send-mode-option--active');

    await wrapper.get('textarea').setValue('重构 Plan 模式');
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('send')).toEqual([['重构 Plan 模式', undefined, 'plan']]);
  });

  it('honours a one-off /plan prefix without changing the remembered mode', async () => {
    const wrapper = mount(ChatInput, { props: { running: false, planAvailable: true } });
    await wrapper.get('textarea').setValue('/plan 先看看代码结构');
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('send')).toEqual([['先看看代码结构', undefined, 'plan']]);
    // 默认选择没有被改掉（下一次还是直接执行）。
    expect(wrapper.findAll('.send-mode-option')[0].classes()).toContain('send-mode-option--active');
  });

  it('disables 先规划 when no session/workspace is ready', () => {
    const wrapper = mount(ChatInput, { props: { running: false, planAvailable: false } });
    const planOption = wrapper.findAll('.send-mode-option')[1];
    expect(planOption.attributes('disabled')).toBeDefined();
    // 规划中不显示选择器（运行中只保留插入/排队/停止）。
    const running = mount(ChatInput, { props: { running: true } });
    expect(running.find('.send-mode').exists()).toBe(false);
  });
});
