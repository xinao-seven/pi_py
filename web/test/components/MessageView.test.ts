import { mount } from '@vue/test-utils';

import MessageView from '@/components/MessageView.vue';

describe('MessageView', () => {
  it('renders a user message only once', () => {
    const wrapper = mount(MessageView, {
      props: { message: { role: 'user', content: '只显示一次' } },
    });

    expect(wrapper.findAll('.message-text')).toHaveLength(1);
    expect(wrapper.get('.message-text').text()).toBe('只显示一次');
    expect(wrapper.find('.markdown-content').exists()).toBe(false);
  });

  it('keeps Markdown rendering for assistant messages', () => {
    const wrapper = mount(MessageView, {
      props: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '**清晰回复**' }],
        },
      },
    });

    expect(wrapper.find('.message-text').exists()).toBe(false);
    expect(wrapper.get('.markdown-content strong').text()).toBe('清晰回复');
  });
});
