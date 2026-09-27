import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import ToolCallBlock from '@/components/ToolCallBlock.vue';

/** 折叠状态（summary）的文本。 */
function summaryOf(props: {
  name?: string;
  arguments?: Record<string, unknown>;
  result?: { role: string; content?: string; isError?: boolean };
  streaming?: boolean;
}): string {
  const wrapper = mount(ToolCallBlock, {
    props: {
      call: { id: 'call-1', type: 'toolCall', name: props.name, arguments: props.arguments },
      ...(props.result === undefined ? {} : { result: props.result }),
      ...(props.streaming === undefined ? {} : { streaming: props.streaming }),
    },
  });
  return wrapper.get('summary').text();
}

describe('ToolCallBlock 折叠摘要', () => {
  it('shows the bash command in the collapsed summary', () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        call: {
          id: 'call-1',
          type: 'toolCall',
          name: 'bash',
          arguments: { command: 'npm run typecheck', timeout: 60 },
        },
      },
    });

    const summary = wrapper.get('summary');
    expect(summary.text()).toContain('bash');
    expect(summary.text()).toContain('npm run typecheck');
    // 完整命令同时进 title：折叠时被省略的部分鼠标一悬停就能看全。
    expect(wrapper.get('.tool-hint').attributes('title')).toBe('npm run typecheck');
    // 折叠不等于丢信息：展开区里仍然是完整参数。
    expect(wrapper.get('.tool-section pre').text()).toContain('"timeout": 60');
  });

  it('summarizes file and search tools too, but stays silent for unknown ones', () => {
    expect(summaryOf({ name: 'read', arguments: { path: 'src/main.ts' } })).toContain(
      'src/main.ts',
    );
    expect(summaryOf({ name: 'edit', arguments: { path: 'a.txt', oldText: 'x' } })).toContain(
      'a.txt',
    );
    expect(summaryOf({ name: 'grep', arguments: { pattern: 'TODO' } })).toContain('TODO');

    // 不认识的工具（MCP 等）没有摘要行，不会出现空标签或猜测出来的参数。
    const unknown = mount(ToolCallBlock, {
      props: {
        call: { id: 'c', type: 'toolCall', name: 'mcp__files__search', arguments: { q: 'x' } },
      },
    });
    expect(unknown.find('.tool-hint').exists()).toBe(false);
    expect(unknown.get('summary').text()).toContain('mcp__files__search');
  });

  it('keeps the tool name and status visible while running', () => {
    expect(summaryOf({ name: 'bash', arguments: { command: 'ls' }, streaming: true })).toContain(
      '运行中',
    );
    expect(summaryOf({ name: 'bash', arguments: { command: 'ls' } })).toContain('等待结果');
    expect(
      summaryOf({
        name: 'bash',
        arguments: { command: 'ls' },
        result: { role: 'toolResult', content: 'ok' },
      }),
    ).toContain('完成');
    expect(
      summaryOf({
        name: 'bash',
        arguments: { command: 'ls' },
        result: { role: 'toolResult', content: 'boom', isError: true },
      }),
    ).toContain('失败');
  });

  it('falls back to the plain summary when arguments are missing', () => {
    const wrapper = mount(ToolCallBlock, {
      props: { call: { id: 'c', type: 'toolCall', name: 'bash' }, streaming: true },
    });
    expect(wrapper.find('.tool-hint').exists()).toBe(false);
    expect(wrapper.get('summary').text()).toContain('bash');
  });
});
