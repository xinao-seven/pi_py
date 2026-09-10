import { describe, expect, it, vi } from 'vitest';

import { PlanModeService } from '../../src/services/plan-mode-service.js';

function makeFakePi() {
  const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  return {
    handlers,
    appendEntry: vi.fn(),
    getActiveTools: vi.fn(() => ['read', 'bash', 'edit', 'write']),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    on(name: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
      handlers.set(name, handler);
    },
  };
}

function sessionContext(entries: unknown[] = []) {
  return {
    sessionManager: {
      getSessionId: () => 'session-1',
      getEntries: () => entries,
    },
  };
}

describe('PlanModeService + buildExtension', () => {
  it('enforces read-only planning, parses a Plan, then advances execution from DONE markers', () => {
    const service = new PlanModeService();
    const pi = makeFakePi();
    const snapshots: unknown[] = [];
    service.setListener((state) => snapshots.push(state));
    service.buildExtension()(pi as never);

    pi.handlers.get('session_start')!({}, sessionContext());
    service.command('session-1', 'enable');
    expect(pi.setActiveTools).toHaveBeenLastCalledWith(
      expect.not.arrayContaining(['edit', 'write']),
    );

    const blocked = pi.handlers.get('tool_call')!({
      toolName: 'bash',
      input: { command: 'rm -rf ./dist' },
    });
    expect(blocked).toMatchObject({ block: true });
    expect(
      pi.handlers.get('tool_call')!({ toolName: 'bash', input: { command: 'rg Plan src' } }),
    ).toBeUndefined();
    expect(pi.handlers.get('before_agent_start')!()).toMatchObject({
      message: { customType: 'web-plan-context' },
    });

    pi.handlers.get('agent_end')!({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '## Plan:\n1. Inspect the backend protocol\n2. Implement the API\n',
            },
          ],
        },
      ],
    });
    expect(snapshots.at(-1)).toMatchObject({
      mode: 'planning',
      awaitingConfirmation: true,
      todos: [{ step: 1 }, { step: 2 }],
    });

    service.command('session-1', 'execute');
    expect(snapshots.at(-1)).toMatchObject({ mode: 'executing', awaitingConfirmation: false });
    expect(pi.setActiveTools).toHaveBeenLastCalledWith(['read', 'bash', 'edit', 'write']);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: 'web-plan-execute' }),
      expect.objectContaining({ triggerTurn: true }),
    );

    pi.handlers.get('turn_end')!({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'API has been verified. [DONE:1]' }],
      },
    });
    expect(snapshots.at(-1)).toMatchObject({
      mode: 'executing',
      todos: [
        { step: 1, completed: true },
        { step: 2, completed: false },
      ],
    });
  });

  it('blocks MCP tools during planning and allows them after disable', () => {
    const service = new PlanModeService();
    const pi = makeFakePi();
    service.buildExtension()(pi as never);

    pi.handlers.get('session_start')!({}, sessionContext());
    service.command('session-1', 'enable');

    const mcpTool = { toolName: 'mcp__github__create_issue', input: { title: 'x' } };
    expect(pi.handlers.get('tool_call')!(mcpTool)).toMatchObject({ block: true });

    service.command('session-1', 'disable');
    expect(pi.handlers.get('tool_call')!(mcpTool)).toBeUndefined();
  });

  it('parses bullet/Chinese plans and finds the plan on a non-final assistant message', () => {
    const service = new PlanModeService();
    const pi = makeFakePi();
    const snapshots: unknown[] = [];
    service.setListener((state) => snapshots.push(state));
    service.buildExtension()(pi as never);

    pi.handlers.get('session_start')!({}, sessionContext());
    service.command('session-1', 'enable');

    pi.handlers.get('agent_end')!({
      messages: [
        { role: 'user', content: [{ type: 'text', text: '请实现登录' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '## 计划\n- 设计 API\n- 实现路由\n- 联调验证' }],
        },
        { role: 'assistant', content: [{ type: 'text', text: '以上就是完整方案，请确认。' }] },
      ],
    });
    expect(snapshots.at(-1)).toMatchObject({
      mode: 'planning',
      awaitingConfirmation: true,
      todos: [
        { step: 1, text: '设计 API' },
        { step: 2, text: '实现路由' },
        { step: 3, text: '联调验证' },
      ],
    });
  });

  it('restores mode, todos and tool restrictions from the session JSONL entry', () => {
    const service = new PlanModeService();
    const pi = makeFakePi();
    service.buildExtension()(pi as never);

    pi.handlers.get('session_start')!(
      {},
      sessionContext([
        {
          type: 'custom',
          customType: 'web-plan-mode',
          data: {
            enabled: true,
            executing: false,
            todos: [{ step: 1, text: '恢复的步骤', completed: false }],
            toolsBeforePlanMode: ['read', 'bash', 'edit', 'write'],
            awaitingConfirmation: false,
          },
        },
      ]),
    );

    expect(service.state('session-1')).toMatchObject({
      mode: 'planning',
      todos: [{ step: 1, text: '恢复的步骤', completed: false }],
    });
    expect(pi.setActiveTools).toHaveBeenCalledWith(expect.not.arrayContaining(['edit', 'write']));
  });

  it('rejects execute/refine before a plan is awaiting confirmation', () => {
    const service = new PlanModeService();
    const pi = makeFakePi();
    service.buildExtension()(pi as never);

    pi.handlers.get('session_start')!({}, sessionContext());
    expect(() => service.command('session-1', 'execute')).toThrow(/awaiting confirmation/);
    // 未处于等待确认时 refine 先报"需要修改意见"，语义上与 execute 不同。
    expect(() => service.command('session-1', 'refine', 'x')).toThrow(
      /refinement message is required/,
    );
  });

  it('returns the default normal snapshot for sessions without a machine', () => {
    const service = new PlanModeService();
    expect(service.state('session-1')).toEqual({
      sessionId: 'session-1',
      mode: 'normal',
      todos: [],
      awaitingConfirmation: false,
    });
    expect(() => service.command('session-1', 'enable')).toThrow(/unavailable/);
  });

  describe('context 钩子：清理陈旧 plan 上下文（修复 D2）', () => {
    const planningMessage = { role: 'custom', customType: 'web-plan-context' };
    const executionMessage = { role: 'custom', customType: 'web-plan-execution-context' };
    const executeMessage = { role: 'custom', customType: 'web-plan-execute' };
    const plainMessage = { role: 'user', content: '你好' };

    function makeMachine() {
      const service = new PlanModeService();
      const pi = makeFakePi();
      service.buildExtension()(pi as never);
      pi.handlers.get('session_start')!({}, sessionContext());
      return { service, pi, context: pi.handlers.get('context')! };
    }

    it('普通模式：两组注入消息都被清掉，普通消息保留', () => {
      const { context } = makeMachine();
      const result = context({
        messages: [planningMessage, executionMessage, executeMessage, plainMessage],
      }) as { messages: unknown[] };
      expect(result.messages).toEqual([plainMessage]);
    });

    it('规划中：保留规划上下文，丢掉执行期上下文', () => {
      const { service, context } = makeMachine();
      service.command('session-1', 'enable');
      const result = context({
        messages: [planningMessage, executionMessage, executeMessage, plainMessage],
      }) as { messages: unknown[] };
      expect(result.messages).toEqual([planningMessage, plainMessage]);
    });

    it('规划期多轮注入只保留最后一条（防止随轮数线性膨胀）', () => {
      const { service, context } = makeMachine();
      service.command('session-1', 'enable');
      // 模拟 3 轮规划：before_agent_start 每轮都注入一条
      const first = { role: 'custom', customType: 'web-plan-context', details: { turn: 1 } };
      const second = { role: 'custom', customType: 'web-plan-context', details: { turn: 2 } };
      const third = { role: 'custom', customType: 'web-plan-context', details: { turn: 3 } };
      const result = context({
        messages: [first, plainMessage, second, third],
      }) as { messages: unknown[] };
      expect(result.messages).toEqual([plainMessage, third]);
    });

    it('执行中：保留执行上下文，丢掉规划期上下文', () => {
      const { service, pi, context } = makeMachine();
      service.command('session-1', 'enable');
      pi.handlers.get('agent_end')!({
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. 做 A' }] }],
      });
      service.command('session-1', 'execute');
      const result = context({
        messages: [planningMessage, executionMessage, executeMessage, plainMessage],
      }) as { messages: unknown[] };
      expect(result.messages).toEqual([executionMessage, executeMessage, plainMessage]);
    });

    it('无需清理时返回 undefined（不无谓替换消息数组）', () => {
      const { context } = makeMachine();
      expect(context({ messages: [plainMessage] })).toBeUndefined();
    });

    it('退出规划后历史不再残留任何 plan 注入（反复切换不累积）', () => {
      const { service, pi, context } = makeMachine();
      // 模拟三轮“开启 → 注入 → 关闭”后累积下来的消息
      const accumulated = [planningMessage, executionMessage, planningMessage, executeMessage];
      service.command('session-1', 'enable');
      service.command('session-1', 'disable');
      const result = context({ messages: [...accumulated, plainMessage] }) as {
        messages: unknown[];
      };
      expect(result.messages).toEqual([plainMessage]);
      expect(pi.appendEntry).toHaveBeenCalled();
    });
  });
});
