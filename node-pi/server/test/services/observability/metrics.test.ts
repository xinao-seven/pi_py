import { describe, expect, it } from 'vitest';

import {
  buildSummary,
  percentile,
  serializeRun,
  serializeStep,
} from '../../../src/services/observability/metrics.js';
import { emptySummary } from '../../../src/services/platform/trace-repository.js';
import type { RunRow, StepRow } from '../../../src/services/platform/trace-model.js';

const run: RunRow = {
  id: 'run-1',
  sessionId: 'session-1',
  cwd: '/workspace',
  provider: 'deepseek',
  model: 'deepseek-chat',
  thinkingLevel: 'medium',
  startedAt: 1_000,
  endedAt: 2_000,
  status: 'completed',
  turns: 2,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheWriteTokens: 1,
  costUsd: 0.0123456,
  ttftMs: 300,
  durationMs: 1_000,
};

const step: StepRow = {
  runId: 'run-1',
  sessionId: 'session-1',
  turnIndex: 1,
  kind: 'tool_call',
  toolName: 'bash',
  toolCallId: 'call-1',
  startedAt: 1_100,
  endedAt: 1_200,
  durationMs: 100,
  isError: true,
  blockedBy: 'approval',
  argsDigest: 'abc',
  argsBytes: 10,
};

describe('percentile', () => {
  it('handles empty, single and multi sample inputs', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([30, 10, 20], 0.5)).toBe(20); // 内部会排序，调用方不必预排序
  });
});

describe('buildSummary', () => {
  it('rounds money, rates and percentiles', () => {
    const summary = buildSummary({
      totals: {
        runs: 4,
        errorRuns: 1,
        turns: 6,
        inputTokens: 400,
        outputTokens: 80,
        cacheReadTokens: 20,
        costUsd: 0.0500001,
        durationSamples: [1_000, 2_000, 3_000, 4_000],
        ttftSamples: [100, 200, 300, 400],
      },
      byModel: [
        {
          provider: 'deepseek',
          model: 'deepseek-chat',
          runs: 4,
          costUsd: 0.0500001,
          tokens: 480,
          durationSamples: [1_000, 2_000, 3_000, 4_000],
        },
      ],
      byTool: [
        {
          toolName: 'bash',
          calls: 10,
          errors: 3,
          blocked: 2,
          durationMsSum: 1_000,
          durationSamples: [10, 20, 30, 40],
        },
      ],
      byApproval: [
        {
          rule: 'recursive-delete',
          risk: 'critical',
          approved: 1,
          denied: 1,
          timedOut: 2,
          waitMsSum: 4_000,
          waitSamples: [1_000, 2_000, 3_000, 4_000],
        },
      ],
      daily: [
        { date: '2026-08-20', runs: 4, costUsd: 0.0500001, inputTokens: 400, outputTokens: 80 },
      ],
    });

    expect(summary.totals).toEqual({
      runs: 4,
      turns: 6,
      inputTokens: 400,
      outputTokens: 80,
      cacheReadTokens: 20,
      costUsd: 0.05,
      p50DurationMs: 2_000,
      p95DurationMs: 4_000,
      p50TtftMs: 200,
      errorRate: 0.25,
    });
    expect(summary.byModel[0]).toMatchObject({ costUsd: 0.05, p95DurationMs: 4_000 });
    expect(summary.byTool[0]).toMatchObject({
      calls: 10,
      errors: 3,
      blocked: 2,
      errorRate: 0.3,
      p50DurationMs: 20,
      p95DurationMs: 40,
    });
    expect(summary.byApproval[0]).toMatchObject({ timedOut: 2, p50WaitMs: 2_000 });
    expect(summary.daily[0]).toMatchObject({ date: '2026-08-20', costUsd: 0.05 });
    expect(summary.store).toBeUndefined();
  });

  it('returns zeros for an empty window and exposes store health when provided', () => {
    const summary = buildSummary(emptySummary(), {
      mode: 'sqlite',
      pending: 3,
      recorded: 10,
      flushed: 7,
      dropped: 1,
      failedFlushes: 0,
      degraded: true,
      lastFlushMs: 1.5,
    });

    expect(summary.totals).toMatchObject({ runs: 0, errorRate: 0, p50DurationMs: 0, p50TtftMs: 0 });
    expect(summary.byTool).toEqual([]);
    expect(summary.store).toEqual({ mode: 'sqlite', degraded: true, pending: 3, dropped: 1 });
  });
});

describe('serialization', () => {
  it('normalizes run and step payloads for the frontend', () => {
    expect(serializeRun(run)).toMatchObject({
      id: 'run-1',
      startedAt: new Date(1_000).toISOString(),
      endedAt: new Date(2_000).toISOString(),
      costUsd: 0.012346,
      parentRunId: null,
      errorMessage: null,
      ttftMs: 300,
    });

    const payload = serializeStep(step);
    expect(payload).toMatchObject({
      kind: 'tool_call',
      toolName: 'bash',
      isError: true,
      blockedBy: 'approval',
      startedAt: new Date(1_100).toISOString(),
      approvalRule: null,
      meta: null,
    });
  });
});
