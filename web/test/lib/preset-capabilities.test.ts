import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CAPABILITIES,
  capabilitiesToExtensions,
  shouldShowWorkPanel,
  summarizeCapabilities,
} from '@/lib/preset-capabilities';

describe('preset capabilities', () => {
  it('maps preset capabilities onto the session extension switches', () => {
    expect(capabilitiesToExtensions(DEFAULT_CAPABILITIES)).toEqual({
      planMode: true,
      approval: true,
      questions: true,
      subagents: true,
      tasks: true,
      observability: true,
      fileExtensions: true,
    });
  });

  it('keeps every field independent when a capability is off', () => {
    const extensions = capabilitiesToExtensions({
      ...DEFAULT_CAPABILITIES,
      plan: false,
      subagent: false,
      fileExtensions: false,
    });

    expect(extensions).toEqual({
      planMode: false,
      approval: true,
      questions: true,
      subagents: false,
      tasks: true,
      observability: true,
      fileExtensions: false,
    });
  });

  it('summarizes the disabled capabilities (and says so when nothing is off)', () => {
    expect(summarizeCapabilities(DEFAULT_CAPABILITIES)).toBe('能力全开');
    expect(summarizeCapabilities({ ...DEFAULT_CAPABILITIES, plan: false, tasks: false })).toBe(
      '关闭：Plan 模式、任务面板',
    );
    expect(
      summarizeCapabilities({
        plan: false,
        approval: false,
        questions: false,
        subagent: false,
        tasks: false,
        observability: false,
        fileExtensions: false,
      }),
    ).toBe(
      '关闭：Plan 模式、危险命令审批、向用户提问、子 agent 委派、任务面板、观测钩子、加载用户扩展',
    );
  });

  it('hides the plan/task panel only when the task domain is explicitly off', () => {
    const capabilities = { ...DEFAULT_CAPABILITIES, mcp: true };
    // 未知（历史会话 / 刷新后）→ 显示；能力位开着 → 显示。
    expect(shouldShowWorkPanel(null)).toBe(true);
    expect(shouldShowWorkPanel(capabilities)).toBe(true);
    // 关掉任务域（极简模式）→ 连入口都不出现。
    expect(shouldShowWorkPanel({ ...capabilities, tasks: false, plan: false, mcp: false })).toBe(
      false,
    );
  });
});
