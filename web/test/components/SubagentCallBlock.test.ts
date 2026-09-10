import { mount } from '@vue/test-utils';

import SubagentCallBlock from '@/components/SubagentCallBlock.vue';
import ToolCallBlock from '@/components/ToolCallBlock.vue';
import type { SubagentToolDetails } from '@/types';

function details(overrides: Partial<SubagentToolDetails> = {}): SubagentToolDetails {
  return {
    status: 'completed',
    preset: 'scout',
    depth: 1,
    subagentSessionId: '01a08b97-eac8-7a0e-a094-90ac8facfe64',
    runId: '88b89910-0f81-4345-93ef-f6d7953791fe',
    model: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
    usage: { turns: 3, inputTokens: 743, outputTokens: 193, cacheReadTokens: 0, costUsd: 0 },
    durationMs: 3870,
    trajectory: [
      { tool: 'bash', ok: true },
      { tool: 'bash', ok: true },
      { tool: 'read', ok: true },
    ],
    maxDepth: 1,
    ...overrides,
  };
}

function subagentCall() {
  return {
    id: 'call-1',
    type: 'toolCall' as const,
    name: 'subagent',
    arguments: { preset: 'scout', task: '统计文件数' },
  };
}

describe('SubagentCallBlock（M5 委派卡片）', () => {
  it('shows preset, depth, usage, trajectory and the summary', () => {
    const wrapper = mount(SubagentCallBlock, {
      props: { details: details(), resultText: 'count=45' },
    });

    expect(wrapper.get('.subagent-preset').text()).toBe('scout');
    expect(wrapper.get('.subagent-depth').text()).toBe('子任务 · 深度 1');
    expect(wrapper.get('.subagent-status').text()).toBe('完成');
    expect(wrapper.get('.subagent-line').text()).toBe(
      'deepseek/deepseek-v4-flash · 3 轮 · ↑743 ↓193 · 3.9s',
    );
    expect(wrapper.get('.subagent-trajectory').text()).toBe('轨迹：bash×2, read×1');
    expect(wrapper.get('.subagent-summary').text()).toBe('count=45');
    expect(wrapper.get('.subagent-meta').text()).toBe('子会话 01a08b97');
  });

  it('surfaces the model-fallback note and the failure reason', () => {
    const wrapper = mount(SubagentCallBlock, {
      props: {
        details: details({
          status: 'budget_exceeded',
          note: '预设模型「claude-haiku-4-5」在本机不可用，改用父会话模型',
          reason: '超过最大轮数 12',
        }),
        resultText: '部分结果',
      },
    });

    expect(wrapper.classes()).toContain('subagent--failed');
    expect(wrapper.get('.subagent-status').text()).toBe('超预算中止');
    expect(wrapper.get('.subagent-note').text()).toContain('claude-haiku-4-5');
    expect(wrapper.get('.subagent-reason').text()).toBe('原因：超过最大轮数 12');
  });

  it('marks failed tool calls inside the trajectory', () => {
    const wrapper = mount(SubagentCallBlock, {
      props: {
        details: details({
          trajectory: [
            { tool: 'bash', ok: false },
            { tool: 'bash', ok: true },
          ],
        }),
        resultText: '',
      },
    });
    expect(wrapper.get('.subagent-trajectory').text()).toBe('轨迹：bash×2（1 失败）');
  });

  it('omits cost when the provider does not report it', () => {
    const wrapper = mount(SubagentCallBlock, {
      props: {
        details: details({
          usage: {
            turns: 1,
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 0,
            costUsd: 0.0125,
          },
        }),
        resultText: '',
      },
    });
    expect(wrapper.get('.subagent-line').text()).toContain('$0.0125');
  });
});

describe('ToolCallBlock 分流到委派卡片', () => {
  it('renders the subagent card when the result carries subagent details', () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        call: subagentCall(),
        result: { role: 'toolResult', content: 'count=45', details: details() },
      },
    });
    expect(wrapper.find('.subagent').exists()).toBe(true);
    expect(wrapper.find('.tool-call').exists()).toBe(false);
  });

  it('keeps the generic rendering for other tools and for results without details', () => {
    const generic = mount(ToolCallBlock, {
      props: {
        call: { id: 'c2', type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
        result: { role: 'toolResult', content: 'ok', details: details() },
      },
    });
    expect(generic.find('.subagent').exists()).toBe(false);
    expect(generic.find('.tool-call').exists()).toBe(true);

    // subagent 但结果没有 details（老会话）：退回通用视图，不报错
    const legacy = mount(ToolCallBlock, {
      props: {
        call: subagentCall(),
        result: { role: 'toolResult', content: '旧格式结果' },
      },
    });
    expect(legacy.find('.subagent').exists()).toBe(false);
    expect(legacy.find('.tool-call').exists()).toBe(true);
    expect(legacy.text()).toContain('旧格式结果');
  });
});
