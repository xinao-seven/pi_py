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
      p95ActiveDurationMs: 9_000,
      p50WaitMs: 1_200,
      humanWaitMs: 36_000,
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
      waitMs: 1_500,
      activeMs: 3_500,
      stopReason: 'endTurn',
      errorType: null,
      errorMessage: null,
      meta: {
        retries: 2,
        retriesSucceeded: 1,
        retriesFailed: 1,
        summaryRetries: 1,
        maxSteerQueue: 1,
        contextInjections: 2,
        promptShapeChanges: 1,
        entries: 24,
        preset: 'scout',
      },
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
        meta: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          promptMessages: 12,
          promptTools: 3,
          promptToolNames: ['bash', 'edit', 'read'],
          promptSystemChars: 4_000,
          toolsChanged: true,
          systemChanged: false,
          cacheHitRate: 0.25,
        },
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
        meta: { firstOutputMs: 250, progressUpdates: 3 },
      },
      {
        kind: 'context_injection',
        turnIndex: 1,
        toolName: null,
        toolCallId: null,
        startedAt: '2026-08-20T10:00:03.000Z',
        endedAt: '2026-08-20T10:00:03.000Z',
        durationMs: 0,
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
        meta: { customType: 'web-plan-context', chars: 120 },
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
    expect(text).toContain('9.0 s'); // p95 机器耗时（扣掉等人）
    expect(text).toContain('1.2 s'); // 等人 p50
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
    // 非工具步骤（上下文注入）从 meta 里取标签，而不是一律显示「—」。
    expect(wrapper.find('.run-detail').text()).toContain('web-plan-context');

    // 等真人 / 机器耗时的拆分：列表行与详情头部都要看得到。
    expect(wrapper.find('.run-row').text()).toContain('+等人 1.5 s');
    expect(wrapper.find('.run-split').text()).toContain('机器 3.5 s');
    expect(wrapper.find('.run-split').text()).toContain('等人 1.5 s');

    // run.meta 的运行期计数器 → 详情头部的 chips。
    const chips = wrapper.find('.run-meta').text();
    expect(chips).toContain('重试成功');
    expect(chips).toContain('steer 峰值');
    expect(chips).toContain('请求形状变');
    expect(chips).toContain('子预设');
    expect(chips).toContain('scout');
    // 只渲染「有值的键」：fixture 里 run.meta 给了 9 个可展示的键。
    expect(wrapper.findAll('.run-meta li')).toHaveLength(9);
    // 没给的键（如 toolResults）不渲染空 chip。
    expect(chips).not.toContain('工具结果');

    // 步骤表新增「详情」列：请求形状（P1）与工具首字节。
    const rows = wrapper.findAll('.observability-table--steps tbody tr');
    const llmRow = rows[0];
    expect(llmRow.text()).toContain('12 条消息 / 3 工具');
    expect(llmRow.text()).toContain('工具集变');
    expect(llmRow.text()).toContain('缓存命中 25.0%');
    expect(llmRow.find('.step-detail').attributes('title')).toBe('bash, edit, read');
    const toolRow = rows[1];
    expect(toolRow.text()).toContain('首字节 250 ms');
    expect(toolRow.text()).toContain('3 次进度');
    // 没有形状/首字节信息的步骤（上下文注入）显示占位符，而不是空白。
    expect(rows[2].text()).toContain('—');

    // 再次点击收起详情
    await wrapper.find('.run-row').trigger('click');
    expect(wrapper.find('.run-detail').exists()).toBe(false);
  });

  it('hides the wait split for legacy runs without waitMs', async () => {
    vi.mocked(getObservabilitySummary).mockResolvedValue(summary());
    vi.mocked(listObservabilityRuns).mockResolvedValue({
      runs: [run({ waitMs: null, activeMs: null, meta: null })],
      nextCursor: null,
    });
    vi.mocked(getObservabilityRun).mockResolvedValue({
      ...runDetail(),
      run: { ...runDetail().run, waitMs: null, activeMs: null, meta: null },
    });

    const wrapper = mount(ObservabilityPanel, { props: { cwd: null } });
    await flushPromises();
    await wrapper.find('.run-row').trigger('click');
    await flushPromises();

    // 老记录没有 wait/active：列表行不显示「+等人」，详情头部的拆分用占位符。
    expect(wrapper.find('.run-row').text()).not.toContain('等人');
    expect(wrapper.find('.run-split').text()).toContain('等人 —');
    // 没有 run.meta 就不渲染 chips 容器。
    expect(wrapper.find('.run-meta').exists()).toBe(false);
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
