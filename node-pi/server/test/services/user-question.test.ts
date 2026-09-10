import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../src/errors.js';
import {
  ASK_USER_TOOL_NAME,
  DEFAULT_QUESTION_TIMEOUT_MS,
  normalizeQuestions,
  QuestionBroker,
  renderAnswers,
} from '../../src/services/user-question.js';

/** 可控时钟 + 固定 id 的 broker（超时用真实定时器但设成极小值）。 */
function makeBroker(options: { timeoutMs?: number } = {}) {
  let serial = 0;
  const broker = new QuestionBroker({
    timeoutMs: options.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS,
    idFactory: () => `question-${(serial += 1)}`,
    now: () => new Date(Date.UTC(2026, 7, 21, 10, 0, 0)),
  });
  return broker;
}

const QUESTIONS = normalizeQuestions([
  {
    question: '要兼容 CLI 的旧会话吗？',
    options: ['要（保留兼容层）', '不要（直接换新格式）'],
  },
  {
    id: 'platforms',
    question: '需要支持哪些平台？',
    options: ['Windows', 'macOS', 'Linux'],
    multiSelect: true,
  },
]);

describe('normalizeQuestions（工具参数规整）', () => {
  it('fills ids, keeps options and flags', () => {
    expect(QUESTIONS).toEqual([
      {
        id: 'q1',
        question: '要兼容 CLI 的旧会话吗？',
        options: ['要（保留兼容层）', '不要（直接换新格式）'],
      },
      {
        id: 'platforms',
        question: '需要支持哪些平台？',
        options: ['Windows', 'macOS', 'Linux'],
        multiSelect: true,
      },
    ]);
  });

  it('de-duplicates ids and trims option text', () => {
    const normalized = normalizeQuestions([
      { id: 'x', question: 'a', options: ['  A  ', '', 'B'] },
      { id: 'x', question: 'b' },
      { question: 'c' },
    ]);
    expect(normalized.map((item) => item.id)).toEqual(['x', 'x-2', 'q3']);
    expect(normalized[0].options).toEqual(['A', 'B']);
    // 没给选项 → 不设 options（前端只渲染自由输入）
    expect(normalized[2].options).toBeUndefined();
  });

  it('rejects empty / oversized / too many questions', () => {
    expect(() => normalizeQuestions([])).toThrow(/至少要问一个问题/);
    expect(() => normalizeQuestions([{ question: '   ' }])).toThrow(/第 1 个问题为空/);
    expect(() => normalizeQuestions([{ question: 'x'.repeat(501) }])).toThrow(/过长/);
    expect(() =>
      normalizeQuestions(Array.from({ length: 9 }, (_, index) => ({ question: `q${index}` }))),
    ).toThrow(/一次最多问 8 个问题/);
    expect(() => normalizeQuestions([{ question: 'q', options: ['x'.repeat(121)] }])).toThrow(
      /选项过长/,
    );
  });

  it('allowFreeText 只有显式 false 才关闭', () => {
    const normalized = normalizeQuestions([
      { question: 'a', allowFreeText: false },
      { question: 'b', allowFreeText: true },
    ]);
    expect(normalized[0].allowFreeText).toBe(false);
    expect(normalized[1].allowFreeText).toBeUndefined();
  });
});

describe('QuestionBroker 挂起与结算', () => {
  it('resolves with the user answers and reports both listeners', async () => {
    const broker = makeBroker();
    const pendingEvents: unknown[] = [];
    const resolved: unknown[] = [];
    broker.setPendingListener((pending) => pendingEvents.push(pending));
    broker.setResolvedListener((sessionId, questionId) => resolved.push([sessionId, questionId]));

    const promise = broker.ask({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      questions: QUESTIONS,
    });
    // 挂起状态可查询（会话状态快照用它）
    const pending = broker.pendingForSession('session-1');
    expect(pending).toMatchObject({ questionId: 'question-1', toolCallId: 'call-1' });
    expect(pending?.questions).toHaveLength(2);
    expect(pendingEvents).toHaveLength(1);

    broker.answer('session-1', 'question-1', {
      answers: [
        { id: 'q1', selected: ['要（保留兼容层）'] },
        { id: 'platforms', selected: ['Windows', 'Linux'], text: '顺带也要 WSL' },
      ],
    });
    const { outcome } = await promise;
    expect(outcome).toMatchObject({ answered: true, reason: 'user' });
    expect(outcome.answers).toEqual([
      { id: 'q1', selected: ['要（保留兼容层）'] },
      { id: 'platforms', selected: ['Windows', 'Linux'], text: '顺带也要 WSL' },
    ]);
    expect(broker.pendingForSession('session-1')).toBeUndefined();
    expect(resolved).toEqual([['session-1', 'question-1']]);
  });

  it('fills unanswered ids as skipped (partial submissions are fine)', async () => {
    const broker = makeBroker();
    const promise = broker.ask({ sessionId: 's', toolCallId: 'c', questions: QUESTIONS });
    broker.answer('s', broker.pendingForSession('s')!.questionId, {
      answers: [{ id: 'q1', selected: [], text: '按你判断' }],
    });
    const { outcome } = await promise;
    expect(outcome.answers[0]).toEqual({ id: 'q1', selected: [], text: '按你判断' });
    expect(outcome.answers[1]).toEqual({ id: 'platforms', selected: [], skipped: true });
  });

  it('treats an empty answer as skipped', async () => {
    const broker = makeBroker();
    const promise = broker.ask({ sessionId: 's', toolCallId: 'c', questions: QUESTIONS });
    broker.answer('s', broker.pendingForSession('s')!.questionId, {
      answers: [{ id: 'q1', selected: [] }],
    });
    expect((await promise).outcome.answers[0]).toEqual({
      id: 'q1',
      selected: [],
      skipped: true,
    });
  });

  it('cancelled=true means "you decide" instead of an error', async () => {
    const broker = makeBroker();
    const promise = broker.ask({ sessionId: 's', toolCallId: 'c', questions: QUESTIONS });
    broker.answer('s', broker.pendingForSession('s')!.questionId, { cancelled: true });
    const { outcome } = await promise;
    expect(outcome).toMatchObject({ answered: false, reason: 'cancelled', answers: [] });
  });

  it('times out instead of hanging forever', async () => {
    const broker = makeBroker({ timeoutMs: 5 });
    const { outcome } = await broker.ask({
      sessionId: 's',
      toolCallId: 'c',
      questions: QUESTIONS,
    });
    expect(outcome).toMatchObject({ answered: false, reason: 'timeout' });
    expect(broker.pendingForSession('s')).toBeUndefined();
  });

  it('settles on abort (user pressed stop) and on session close', async () => {
    const broker = makeBroker();
    const controller = new AbortController();
    const aborted = broker.ask({
      sessionId: 's1',
      toolCallId: 'c1',
      questions: QUESTIONS,
      signal: controller.signal,
    });
    controller.abort();
    expect((await aborted).outcome).toMatchObject({ answered: false, reason: 'abort' });

    const closed = broker.ask({ sessionId: 's2', toolCallId: 'c2', questions: QUESTIONS });
    broker.cancelSession('s2');
    expect((await closed).outcome).toMatchObject({ answered: false, reason: 'session' });

    // 关闭服务时同样结算，不留挂着的工具调用。
    const disposed = broker.ask({ sessionId: 's3', toolCallId: 'c3', questions: QUESTIONS });
    broker.dispose();
    expect((await disposed).outcome).toMatchObject({ answered: false, reason: 'disposed' });

    // 已经 abort 过的 signal 直接结算，不再登记挂起项。
    const already = await broker.ask({
      sessionId: 's4',
      toolCallId: 'c4',
      questions: QUESTIONS,
      signal: controller.signal,
    });
    expect(already.outcome.reason).toBe('abort');
    expect(broker.pendingForSession('s4')).toBeUndefined();
  });

  it('rejects a second question while one is pending (no 连环追问)', async () => {
    const broker = makeBroker();
    const first = broker.ask({ sessionId: 's', toolCallId: 'c1', questions: QUESTIONS });
    await expect(
      broker.ask({ sessionId: 's', toolCallId: 'c2', questions: QUESTIONS }),
    ).rejects.toThrow(/已经有一个待回答的问题/);
    broker.answer('s', broker.pendingForSession('s')!.questionId, { cancelled: true });
    await first;
  });

  it('validates the answers payload', () => {
    const broker = makeBroker();
    void broker.ask({ sessionId: 's', toolCallId: 'c', questions: QUESTIONS });
    const questionId = broker.pendingForSession('s')!.questionId;

    expect(() => broker.answer('s', 'unknown-id', { answers: [] })).toThrow(ApiError);
    expect(() =>
      broker.answer('s', questionId, { answers: [{ id: 'nope', selected: [] }] }),
    ).toThrow(/must be one of/);
    expect(() =>
      broker.answer('s', questionId, {
        answers: [{ id: 'q1', selected: [1 as unknown as string] }],
      }),
    ).toThrow(/selected must be a string\[\]/);
    // 结算过的提问再回答 → 404（前端重复提交/过期弹窗）
    broker.answer('s', questionId, { answers: [{ id: 'q1', selected: ['要（保留兼容层）'] }] });
    expect(() =>
      broker.answer('s', questionId, { answers: [{ id: 'q1', selected: ['要（保留兼容层）'] }] }),
    ).toThrow(/no longer pending/);
  });
});

describe('renderAnswers（给模型看的文本）', () => {
  it('renders selections and free text per question', async () => {
    const broker = makeBroker();
    const promise = broker.ask({ sessionId: 's', toolCallId: 'c', questions: QUESTIONS });
    broker.answer('s', broker.pendingForSession('s')!.questionId, {
      answers: [
        { id: 'q1', selected: ['不要（直接换新格式）'] },
        { id: 'platforms', selected: ['Windows'], text: '另外 Linux 也要' },
      ],
    });
    const { pending, outcome } = await promise;
    const text = renderAnswers(pending, outcome);
    expect(text).toContain('[用户回答]');
    expect(text).toContain('1. 要兼容 CLI 的旧会话吗？');
    expect(text).toContain('→ 选中：不要（直接换新格式）');
    expect(text).toContain('→ 选中：Windows；补充：另外 Linux 也要');
  });

  it('tells the model what to do when the user did not answer', async () => {
    const broker = makeBroker();
    const promise = broker.ask({ sessionId: 's', toolCallId: 'c', questions: QUESTIONS });
    broker.answer('s', broker.pendingForSession('s')!.questionId, { cancelled: true });
    const { pending, outcome } = await promise;
    const text = renderAnswers(pending, outcome);
    expect(text).toContain('[用户未回答]');
    expect(text).toContain('让你自己决定');
    expect(text).toContain('明确写出你采用的假设');
  });

  it('marks skipped questions', async () => {
    const broker = makeBroker();
    const promise = broker.ask({ sessionId: 's', toolCallId: 'c', questions: QUESTIONS });
    broker.answer('s', broker.pendingForSession('s')!.questionId, { answers: [] });
    const { pending, outcome } = await promise;
    const text = renderAnswers(pending, outcome);
    expect(text.match(/（用户跳过，未回答）/g) ?? []).toHaveLength(2);
  });
});

describe('buildExtension（ask_user 工具）', () => {
  function makeFakePi(active: string[] = ['read', 'bash', 'edit', 'write']) {
    const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    let activeTools = [...active];
    return {
      handlers,
      tools,
      getActiveTools: () => [...activeTools],
      setActiveTools: (names: string[]) => {
        activeTools = [...names];
      },
      registerTool: (tool: { name: string } & Record<string, unknown>) => {
        tools.set(tool.name, tool as never);
      },
      on(name: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
        handlers.set(name, handler);
      },
    };
  }

  it('registers ask_user and activates it on session start (plan or not)', () => {
    const broker = makeBroker();
    const pi = makeFakePi();
    broker.buildExtension()(pi as never);
    expect([...pi.tools.keys()]).toEqual([ASK_USER_TOOL_NAME]);
    expect(pi.getActiveTools()).not.toContain(ASK_USER_TOOL_NAME);

    pi.handlers.get('session_start')!({}, {});
    expect(pi.getActiveTools()).toContain(ASK_USER_TOOL_NAME);
    // 再次触发不会重复添加（幂等）。
    pi.handlers.get('session_start')!({}, {});
    expect(pi.getActiveTools().filter((name) => name === ASK_USER_TOOL_NAME)).toHaveLength(1);
  });

  it('returns the answers as the tool result and exposes details for the UI', async () => {
    const broker = makeBroker();
    const pi = makeFakePi();
    broker.buildExtension()(pi as never);
    const ctx = { sessionManager: { getSessionId: () => 'session-1' } };

    const executing = pi.tools
      .get(ASK_USER_TOOL_NAME)!
      .execute(
        'call-9',
        { questions: [{ question: '继续吗？', options: ['继续', '停'] }] },
        undefined,
        undefined,
        ctx,
      );
    await Promise.resolve();
    const pending = broker.pendingForSession('session-1')!;
    broker.answer('session-1', pending.questionId, {
      answers: [{ id: 'q1', selected: ['继续'] }],
    });

    const result = (await executing) as {
      content: Array<{ text: string }>;
      details: Record<string, unknown>;
    };
    expect(result.content[0].text).toContain('→ 选中：继续');
    expect(result.details).toMatchObject({ answered: true, questionId: pending.questionId });
  });

  it('surfaces validation errors to the model (isError by throwing)', async () => {
    const broker = makeBroker();
    const pi = makeFakePi();
    broker.buildExtension()(pi as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      pi.tools.get(ASK_USER_TOOL_NAME)!.execute('call-1', { questions: [] }, undefined, undefined, {
        sessionManager: { getSessionId: () => 's' },
      }),
    ).rejects.toThrow(/至少要问一个问题/);
    error.mockRestore();
  });
});
