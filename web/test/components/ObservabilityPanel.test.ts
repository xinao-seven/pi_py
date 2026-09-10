import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, vi } from 'vitest';

import ObservabilityPanel from '@/components/ObservabilityPanel.vue';
import { getObservabilityRun, getObservabilitySummary, listObservabilityRuns } from '@/lib/api';
import type { ObservabilityRunDetail, ObservabilitySummary } from '@/types';

vi.mock('@/lib/api', () => ({
  getObservabilitySummary: vi.fn(),
  listObservabilityRuns: vi.fn(),
  getObservabilityRun: vi.fn(),
}));

function summary(overrides: Partial<ObservabilitySummary> = {}): ObservabilitySummary {
  return {
    totals: {
      runs: 4,
      turns: 9,
      inputTokens: 150_000,
      outputTokens: 20_000,
      cacheReadTokens: 5_000,
      costUsd: 0.0123,
      p50DurationMs: 5_100,
      p95DurationMs: 21_000,
      p50TtftMs: 320,
      errorRate: 0.25,
    },
    byModel: [
      {
        provider: 'deepseek',
        model: 'deepseek-chat',
        runs: 4,
        costUsd: 0.0123,
        tokens: 170_000,
        p95DurationMs: 21_000,
      },
    ],
    byTool: [
      {
        toolName: 'bash',
        calls: 10,
        errors: 3,
        blocked: 2,
        errorRate: 0.3,
        p50DurationMs: 120,
        p95DurationMs: 480,
      },
    ],
    byApproval: [
      {
        rule: 'recursive-delete',
        risk: 'critical',
        approved: 1,
        denied: 1,
        timedOut: 1,
        p50WaitMs: 900,
      },
    ],
    daily: [
      { date: '2026-08-19', runs: 1, costUsd: 0.002, inputTokens: 10_000, outputTokens: 1_000 },
      { date: '2026-08-20', runs: 3, costUsd: 0.0103, inputTokens: 140_000, outputTokens: 19_000 },
    ],
    store: { mode: 'sqlite', degraded: false, pending: 0, dropped: 0 },
    ...overrides,
  };
}

function runDetail(): ObservabilityRunDetail {
  return {
    run: {
      id: 'run-1',
      sessionId: 'session-1',
      parentRunId: null,
      taskId: null,
      cwd: '/workspace',
      provider: 'deepseek',
      model: 'deepseek-chat',
      thinkingLevel: 'medium',
      startedAt: '2026-08-20T10:00:00.000Z',
      endedAt: '2026-08-20T10:00:05.000Z',
      status: 'completed',
      turns: 2,
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.002,
      ttftMs: 300,
      durationMs: 5_000,
      stopReason: 'endTurn',
      errorType: null,
      errorMessage: null,
      meta: null,
    },
    steps: [
      {
        kind: 'llm_call',
        turnIndex: 1,
        toolName: null,
        toolCallId: null,
        startedAt: '2026-08-20T10:00:00.000Z',
        endedAt: '2026-08-20T10:00:02.000Z',
        durationMs: 2_000,
        isError: false,
        blockedBy: null,
        errorType: null,
        errorMessage: null,
        argsDigest: null,
        argsBytes: null,
        resultDigest: null,
        resultBytes: null,
        approvalRule: null,
        approvalRisk: null,
        approvalDecision: null,
        approvalWaitMs: null,
        decidedBy: null,
        meta: null,
      },
      {
        kind: 'tool_call',
        turnIndex: 1,
        toolName: 'bash',
        toolCallId: 'call-1',
        startedAt: '2026-08-20T10:00:02.000Z',
        endedAt: '2026-08-20T10:00:03.000Z',
        durationMs: 1_000,
        isError: true,
        blockedBy: 'approval',
        errorType: null,
        errorMessage: null,
        argsDigest: 'abc',
        argsBytes: 20,
        resultDigest: null,
        resultBytes: null,
        approvalRule: null,
        approvalRisk: null,
        approvalDecision: null,
        approvalWaitMs: null,
        decidedBy: null,
        meta: null,
      },
    ],
    children: [],
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return { ...runDetail().run, ...overrides };
}

describe('ObservabilityPanel', () => {
  // 每次用例前清空调用记录：下面的断言依赖「第几次请求」的序号。
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders cost, latency, tool and approval metrics from the summary', async () => {
    vi.mocked(getObservabilitySummary).mockResolvedValue(summary());
    vi.mocked(listObservabilityRuns).mockResolvedValue({ runs: [run()], nextCursor: null });

    const wrapper = mount(ObservabilityPanel, { props: { cwd: '/workspace' } });
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('$0.0123'); // 累计成本
    expect(text).toContain('21.0 s'); // p95 运行耗时
    expect(text).toContain('320 ms'); // 首 token p50
    expect(text).toContain('25.0%'); // 失败率
    expect(text).toContain('bash');
    expect(text).toContain('30.0%'); // 工具失败率
    expect(text).toContain('recursive-delete');
    expect(text).toContain('被策略拦下的调用');
    // 缓存命中：5000 / (150000 + 5000) = 3.2%（工具列表/上下文注入是否破坏前缀缓存的直接证据）
    expect(text).toContain('缓存命中');
    expect(text).toContain('3.2%');
    expect(text).toContain('5.0k');
    expect(wrapper.findAll('.observability-bar')).toHaveLength(2);
    expect(wrapper.find('.observability-notice').exists()).toBe(false);
  });

  it('reloads with the selected range and workspace scope', async () => {
    vi.mocked(getObservabilitySummary).mockResolvedValue(summary());
    vi.mocked(listObservabilityRuns).mockResolvedValue({ runs: [], nextCursor: null });

    const wrapper = mount(ObservabilityPanel, { props: { cwd: '/workspace' } });
    await flushPromises();
    expect(vi.mocked(getObservabilitySummary).mock.calls[0][0]?.cwd).toBeUndefined();

    await wrapper.find('select').setValue('24h');
    await flushPromises();
    expect(vi.mocked(getObservabilitySummary).mock.calls[1][0]?.from).toBeDefined();

    await wrapper.find('.observability-toggle input').setValue(true);
    await flushPromises();
    expect(vi.mocked(getObservabilitySummary).mock.calls[2][0]?.cwd).toBe('/workspace');
  });

  it('loads run detail on demand and shows blocked steps', async () => {
    vi.mocked(getObservabilitySummary).mockResolvedValue(summary());
    vi.mocked(listObservabilityRuns).mockResolvedValue({ runs: [run()], nextCursor: null });
    vi.mocked(getObservabilityRun).mockResolvedValue(runDetail());

    const wrapper = mount(ObservabilityPanel, { props: { cwd: null } });
    await flushPromises();

    await wrapper.find('.run-row').trigger('click');
    await flushPromises();

    expect(vi.mocked(getObservabilityRun)).toHaveBeenCalledWith('run-1');
    expect(wrapper.find('.run-detail').text()).toContain('已拦截（approval）');
    expect(wrapper.find('.run-detail').text()).toContain('llm_call');

    // 再次点击收起详情
    await wrapper.find('.run-row').trigger('click');
    expect(wrapper.find('.run-detail').exists()).toBe(false);
  });

  it('explains when tracing is disabled', async () => {
    vi.mocked(getObservabilitySummary).mockResolvedValue(
      summary({
        store: { mode: 'off', degraded: false, pending: 0, dropped: 0 },
        byModel: [],
        byTool: [],
        byApproval: [],
        daily: [],
      }),
    );
    vi.mocked(listObservabilityRuns).mockResolvedValue({ runs: [], nextCursor: null });

    const wrapper = mount(ObservabilityPanel, { props: { cwd: null } });
    await flushPromises();

    expect(wrapper.find('.observability-notice').text()).toContain('未开启可观测性');
    expect(wrapper.findAll('.observability-empty').length).toBeGreaterThan(0);
  });

  it('shows no cache hit rate when nothing was sent yet', async () => {
    vi.mocked(getObservabilitySummary).mockResolvedValue(
      summary({
        totals: {
          ...summary().totals,
          runs: 0,
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0,
        },
      }),
    );
    vi.mocked(listObservabilityRuns).mockResolvedValue({ runs: [], nextCursor: null });

    const wrapper = mount(ObservabilityPanel, { props: { cwd: null } });
    await flushPromises();

    // 分子分母都为 0 → 显示占位符，而不是 NaN% 或 100%。
    const cacheKpi = wrapper.findAll('.kpi').find((item) => item.text().includes('缓存命中'));
    expect(cacheKpi?.text()).toContain('—');
  });

  it('surfaces load errors', async () => {
    vi.mocked(getObservabilitySummary).mockRejectedValue(new Error('后端未就绪'));
    vi.mocked(listObservabilityRuns).mockResolvedValue({ runs: [], nextCursor: null });

    const wrapper = mount(ObservabilityPanel, { props: { cwd: null } });
    await flushPromises();

    expect(wrapper.find('.observability-error').text()).toContain('后端未就绪');
  });

  /**
   * 布局契约：面板必须自己吃掉父级（设置弹窗 .settings-content）的定高并内部滚动。
   * 中文说明：jsdom 没有布局引擎，滚不动这类缺陷跑不出来，所以只能守住 CSS 契约——
   * 曾经因为没有 height，面板被内容撑高后又被父级 overflow:hidden 裁掉，下半部分永远看不到。
   */
  it('fills its container and scrolls internally when embedded', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/ObservabilityPanel.vue'),
      'utf8',
    );
    const rule = /\.observability-panel\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';

    expect(rule).toContain('height: 100%');
    expect(rule).toContain('overflow-y: auto');
    expect(rule).toContain('min-height: 0');
  });
});
