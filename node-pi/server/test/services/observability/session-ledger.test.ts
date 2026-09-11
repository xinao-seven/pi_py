import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SessionLedger,
  type LedgerEvent,
  type LedgerSessionContext,
} from '../../../src/services/observability/session-ledger.js';
import {
  digestOf,
  redactText,
  redactValue,
  summarize,
} from '../../../src/services/observability/redact.js';
import { openPlatformStore, type PlatformStore } from '../../../src/services/platform/store.js';

/** 事件构造：账本只关心少数字段，这里用宽松类型拼装。 */
function event(payload: Record<string, unknown>): LedgerEvent {
  return payload as unknown as LedgerEvent;
}

const context: LedgerSessionContext = {
  sessionId: 'session-1',
  cwd: '/workspace',
  provider: 'deepseek',
  model: 'deepseek-chat',
  thinkingLevel: 'medium',
};

/** 可控时钟的账本 + 内存存储。 */
function makeLedger(options: { content?: boolean } = {}) {
  let clock = 1_000_000;
  const warnings: string[] = [];
  const store: PlatformStore = openPlatformStore({ mode: 'memory' });
  const ledger = new SessionLedger(
    store.traces,
    {
      debug: () => undefined,
      info: () => undefined,
      warn: (_obj, msg) => warnings.push(msg ?? ''),
      error: () => undefined,
    },
    { content: options.content === true, now: () => clock, runIdFactory: () => 'run-1' },
  );
  return {
    ledger,
    store,
    warnings,
    tick: (ms: number) => {
      clock += ms;
    },
    close: () => store.close(),
  };
}

/** 一轮完整对话：turn → 模型响应 → 工具调用 → 结算。 */
function playTurn(harness: ReturnType<typeof makeLedger>, options: { toolError?: boolean } = {}) {
  const { ledger, tick } = harness;
  ledger.record(context, event({ type: 'agent_start' }));
  tick(100);
  ledger.record(context, event({ type: 'turn_start' }));
  tick(50);
  ledger.record(context, event({ type: 'message_update', message: { role: 'assistant' } }));
  tick(450);
  ledger.record(
    context,
    event({
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'deepseek',
        model: 'deepseek-chat',
        stopReason: 'toolUse',
        usage: { input: 1_000, output: 200, cacheRead: 50, cacheWrite: 10, cost: { total: 0.012 } },
      },
    }),
  );
  ledger.record(
    context,
    event({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'ls -la', apiKey: 'sk-should-not-be-stored' },
    }),
  );
  tick(90);
  ledger.record(
    context,
    event({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'total 0' }] },
      isError: options.toolError === true,
    }),
  );
  ledger.record(context, event({ type: 'agent_settled' }));
}

describe('redact', () => {
  it('replaces secret-keyed values and secret-shaped strings', () => {
    const redacted = redactValue({
      apiKey: 'plain-secret',
      Authorization: 'whatever',
      nested: { password: 'p', keep: 'sk-abcdefghijkl', note: 'Bearer abcdefghijklmnop' },
      list: [{ token: 'x' }, 'keep'],
    });

    expect(redacted).toEqual({
      apiKey: '[redacted]',
      Authorization: '[redacted]',
      nested: { password: '[redacted]', keep: '[redacted]', note: '[redacted]' },
      list: [{ token: '[redacted]' }, 'keep'],
    });
    expect(redactText('use sk-abcdefghijkl now')).toBe('use [redacted] now');
    // 普通文本不受影响（只有密钥形态会被替换）。
    expect(redactText('rm -rf ./build')).toBe('rm -rf ./build');
  });

  it('summarizes with a stable digest, byte size and bounded preview', () => {
    const first = summarize({ command: 'ls' });
    const second = summarize({ command: 'ls' });
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toHaveLength(12);
    expect(first.digest).toBe(digestOf('{"command":"ls"}'));
    expect(first.bytes).toBe(Buffer.byteLength('{"command":"ls"}', 'utf8'));
    expect(first.preview).toBe('{"command":"ls"}');
    expect(first.truncated).toBe(false);
    expect(first.text).toBeUndefined();

    const long = summarize('x'.repeat(300_000));
    expect(long.truncated).toBe(true);
    expect(long.preview).toHaveLength(120);
  });

  it('keeps redacted content only when explicitly enabled', () => {
    expect(summarize({ apiKey: 'sk-abcdefghijkl' }, { content: true }).text).toBe(
      '{"apiKey":"[redacted]"}',
    );
  });
});

describe('SessionLedger', () => {
  it('turns an event sequence into one run with llm and tool steps', () => {
    const harness = makeLedger();
    try {
      playTurn(harness);
      const detail = harness.store.traces.getRun('run-1');

      expect(detail?.run).toMatchObject({
        sessionId: 'session-1',
        cwd: '/workspace',
        provider: 'deepseek',
        model: 'deepseek-chat',
        thinkingLevel: 'medium',
        status: 'completed',
        turns: 1,
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        costUsd: 0.012,
        ttftMs: 50,
        durationMs: 690,
        stopReason: 'toolUse',
      });
      // 参数与结果只留 digest/字节数/预览，正文不落库。
      const tool = detail?.steps.find((step) => step.kind === 'tool_call');
      expect(tool).toMatchObject({ toolName: 'bash', durationMs: 90, isError: false });
      expect(tool?.argsDigest).toHaveLength(12);
      expect(tool?.argsBytes).toBeGreaterThan(0);
      expect(tool?.meta).toMatchObject({
        argsPreview: '{"command":"ls -la","apiKey":"[redacted]"}',
      });
      expect(JSON.stringify(tool)).not.toContain('should-not-be-stored');

      const llm = detail?.steps.find((step) => step.kind === 'llm_call');
      expect(llm).toMatchObject({ durationMs: 500, isError: false });
      expect(llm?.meta).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });

      expect(harness.store.traces.summary({}).totals).toMatchObject({
        runs: 1,
        turns: 1,
        errorRuns: 0,
        inputTokens: 1_000,
        costUsd: 0.012,
        durationSamples: [690],
        ttftSamples: [50],
      });
    } finally {
      harness.close();
    }
  });

  it('starts a new run after the previous one settled', () => {
    const harness = makeLedger();
    try {
      playTurn(harness);
      let second = 0;
      const ledger = new SessionLedger(harness.store.traces, undefined, {
        now: () => 2_000_000,
        runIdFactory: () => `run-2-${(second += 1)}`,
      });
      ledger.record(context, event({ type: 'agent_start' }));
      ledger.record(context, event({ type: 'agent_settled' }));

      expect(harness.store.traces.listRuns({ limit: 10 }).runs.map((run) => run.id)).toEqual([
        'run-2-1',
        'run-1',
      ]);
    } finally {
      harness.close();
    }
  });

  it('records approval decisions and does not count a denied call as a tool error', () => {
    const harness = makeLedger();
    const { ledger, tick } = harness;
    try {
      ledger.record(context, event({ type: 'agent_start' }));
      ledger.record(context, event({ type: 'turn_start' }));
      ledger.noteApprovalStart({
        sessionId: 'session-1',
        toolCallId: 'call-9',
        toolName: 'bash',
        rule: 'recursive-delete',
        risk: 'critical',
      });
      ledger.record(
        context,
        event({
          type: 'tool_execution_start',
          toolCallId: 'call-9',
          toolName: 'bash',
          args: { command: 'rm -rf ./build' },
        }),
      );
      tick(2_000);
      ledger.noteApprovalDecision({
        sessionId: 'session-1',
        toolCallId: 'call-9',
        decision: 'timed_out',
        decidedBy: 'timeout',
      });
      ledger.record(
        context,
        event({
          type: 'tool_execution_end',
          toolCallId: 'call-9',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'Tool execution was not approved' }] },
          isError: true,
        }),
      );
      ledger.record(context, event({ type: 'agent_settled' }));

      const tool = harness.store.traces
        .getRun('run-1')
        ?.steps.find((step) => step.kind === 'tool_call');
      expect(tool).toMatchObject({ isError: true, blockedBy: 'approval' });

      const approval = harness.store.traces
        .getRun('run-1')
        ?.steps.find((step) => step.kind === 'approval');
      expect(approval).toMatchObject({
        approvalRule: 'recursive-delete',
        approvalRisk: 'critical',
        approvalDecision: 'timed_out',
        approvalWaitMs: 2_000,
        decidedBy: 'timeout',
      });

      const summary = harness.store.traces.summary({});
      // 被正确拦下的调用既不算工具失败，也不算审批“命中率”里的放行。
      expect(summary.byTool[0]).toMatchObject({
        toolName: 'bash',
        calls: 1,
        errors: 0,
        blocked: 1,
      });
      expect(summary.byApproval[0]).toMatchObject({
        rule: 'recursive-delete',
        approved: 0,
        denied: 0,
        timedOut: 1,
        waitMsSum: 2_000,
      });
    } finally {
      harness.close();
    }
  });

  it('attributes plan-mode blocks from the explicit note, and falls back to result text', () => {
    const harness = makeLedger();
    const { ledger, tick } = harness;
    try {
      ledger.record(context, event({ type: 'agent_start' }));
      ledger.record(context, event({ type: 'turn_start' }));
      ledger.record(
        context,
        event({ type: 'tool_execution_start', toolCallId: 'call-a', toolName: 'edit', args: {} }),
      );
      ledger.noteToolBlock({
        sessionId: 'session-1',
        toolCallId: 'call-a',
        blockedBy: 'plan_mode',
        reason: 'Plan mode is read-only.',
      });
      tick(10);
      ledger.record(
        context,
        event({
          type: 'tool_execution_end',
          toolCallId: 'call-a',
          toolName: 'edit',
          result: { content: [{ type: 'text', text: 'Plan mode is read-only.' }] },
          isError: true,
        }),
      );
      // 没有被登记过的拦截：靠结果文案兜底识别（第二个扩展/未来策略）。
      ledger.record(
        context,
        event({ type: 'tool_execution_start', toolCallId: 'call-b', toolName: 'write', args: {} }),
      );
      tick(10);
      ledger.record(
        context,
        event({
          type: 'tool_execution_end',
          toolCallId: 'call-b',
          toolName: 'write',
          result: { content: [{ type: 'text', text: 'Tool execution was not approved' }] },
          isError: true,
        }),
      );
      ledger.record(context, event({ type: 'agent_settled' }));

      const steps = harness.store.traces.getRun('run-1')?.steps ?? [];
      expect(steps.find((step) => step.toolCallId === 'call-a')?.blockedBy).toBe('plan_mode');
      expect(steps.find((step) => step.toolCallId === 'call-b')?.blockedBy).toBe('policy');
      expect(harness.store.traces.summary({}).byTool).toEqual([
        {
          toolName: 'edit',
          calls: 1,
          errors: 0,
          blocked: 1,
          durationMsSum: 10,
          durationSamples: [10],
        },
        {
          toolName: 'write',
          calls: 1,
          errors: 0,
          blocked: 1,
          durationMsSum: 10,
          durationSamples: [10],
        },
      ]);
    } finally {
      harness.close();
    }
  });

  it('captures provider HTTP status and header latency on the llm step', () => {
    const harness = makeLedger();
    const { ledger, tick } = harness;
    try {
      ledger.record(context, event({ type: 'agent_start' }));
      ledger.record(context, event({ type: 'turn_start' }));
      ledger.noteProviderRequestStart('session-1');
      tick(30);
      ledger.noteProviderResponse('session-1', 429);
      ledger.record(
        context,
        event({
          type: 'message_end',
          message: {
            role: 'assistant',
            provider: 'deepseek',
            model: 'deepseek-chat',
            stopReason: 'error',
            errorMessage: 'rate limited',
          },
        }),
      );
      ledger.record(context, event({ type: 'agent_settled' }));

      const detail = harness.store.traces.getRun('run-1');
      expect(detail?.steps[0].meta).toMatchObject({ httpStatus: 429, httpLatencyMs: 30 });
      expect(detail?.run).toMatchObject({
        status: 'error',
        errorType: 'model_error',
        errorMessage: 'rate limited',
      });
      expect(harness.store.traces.summary({}).totals.errorRuns).toBe(1);
    } finally {
      harness.close();
    }
  });

  it('counts automatic retries into run meta', () => {
    const harness = makeLedger();
    const { ledger, tick } = harness;
    try {
      ledger.record(context, event({ type: 'agent_start' }));
      ledger.record(context, event({ type: 'turn_start' }));
      tick(10);
      ledger.record(context, event({ type: 'auto_retry_start', attempt: 1, errorMessage: 'boom' }));
      tick(10);
      ledger.record(context, event({ type: 'auto_retry_start', attempt: 2, errorMessage: 'boom' }));
      tick(10);
      ledger.record(context, event({ type: 'compaction_start', reason: 'threshold' }));
      tick(20);
      ledger.record(
        context,
        event({ type: 'compaction_end', reason: 'threshold', aborted: false, result: undefined }),
      );
      ledger.record(context, event({ type: 'agent_settled' }));

      const detail = harness.store.traces.getRun('run-1');
      expect(detail?.run.meta).toEqual({ retries: 2 });
      expect(detail?.steps.map((step) => step.kind)).toEqual(['llm_call', 'compaction']);
      expect(detail?.steps[1]).toMatchObject({ kind: 'compaction', durationMs: 20 });
    } finally {
      harness.close();
    }
  });

  it('finishes an unfinished run as aborted when the session goes away', () => {
    const harness = makeLedger();
    const { ledger } = harness;
    try {
      ledger.record(context, event({ type: 'agent_start' }));
      ledger.record(context, event({ type: 'turn_start' }));
      ledger.finalizeSession('session-1');

      const run = harness.store.traces.getRun('run-1')?.run;
      expect(run?.status).toBe('aborted');
      expect(run?.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      harness.close();
    }
  });

  it('records a failed run when prompt() rejects before the agent loop starts', () => {
    const harness = makeLedger();
    const { ledger } = harness;
    try {
      ledger.noteCommandFailure(context, new Error('no model selected'));

      const run = harness.store.traces.getRun('run-1')?.run;
      expect(run).toMatchObject({
        status: 'error',
        errorType: 'command_error',
        errorMessage: 'no model selected',
        turns: 0,
      });
    } finally {
      harness.close();
    }
  });

  it('never throws and logs a warning when the sink fails', () => {
    const warnings: string[] = [];
    const broken = {
      startRun: () => {
        throw new Error('disk on fire');
      },
      finishRun: () => undefined,
      addStep: () => undefined,
      flush: () => undefined,
      close: () => undefined,
      summary: () => {
        throw new Error('unused');
      },
      listRuns: () => ({ runs: [] }),
      getRun: () => undefined,
      prune: () => 0,
      stats: () => ({
        mode: 'sqlite' as const,
        pending: 0,
        recorded: 0,
        flushed: 0,
        dropped: 0,
        failedFlushes: 0,
        degraded: false,
        lastFlushMs: 0,
      }),
    };
    const ledger = new SessionLedger(broken, {
      debug: () => undefined,
      info: () => undefined,
      warn: (_obj, msg) => warnings.push(msg ?? ''),
      error: () => undefined,
    });

    expect(() => ledger.record(context, event({ type: 'agent_start' }))).not.toThrow();
    expect(() => ledger.finalizeSession('session-1')).not.toThrow();
    expect(warnings.every((line) => line === 'trace record skipped')).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

/**
 * 成本兜底：models.json 重复定义同名模型会把内置 cost 归零（provider-composer 的行为），
 * 账本要按内置目录价格重算，且显式非零 cost 不能被覆盖。
 */
describe('cost fallback for models shadowed by models.json', () => {
  function recordAssistant(ledger: SessionLedger, message: Record<string, unknown>): void {
    ledger.record(context, event({ type: 'agent_start' }));
    ledger.record(context, event({ type: 'turn_start' }));
    ledger.record(context, event({ type: 'message_end', message }));
    ledger.record(context, event({ type: 'agent_settled' }));
  }

  it('recomputes cost from the built-in catalog when the SDK reports $0', () => {
    const harness = makeLedger();
    try {
      recordAssistant(
        harness.ledger,
        {
          role: 'assistant',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          stopReason: 'stop',
          usage: { input: 1_000, output: 200, cacheRead: 50, cacheWrite: 10, cost: { total: 0 } },
        },
      );

      // flash: 0.14/0.28/0.0028/0 美元每百万 token。
      expect(harness.store.traces.getRun('run-1')?.run.costUsd).toBeCloseTo(0.00019614, 9);
    } finally {
      harness.close();
    }
  });

  it('keeps an explicit non-zero cost even for built-in model ids', () => {
    const harness = makeLedger();
    try {
      recordAssistant(
        harness.ledger,
        {
          role: 'assistant',
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          stopReason: 'stop',
          usage: { input: 1_000, output: 200, cost: { total: 0.5 } },
        },
      );

      expect(harness.store.traces.getRun('run-1')?.run.costUsd).toBe(0.5);
    } finally {
      harness.close();
    }
  });

  it('leaves cost at 0 when the model is absent from the built-in catalog', () => {
    const harness = makeLedger();
    try {
      recordAssistant(
        harness.ledger,
        {
          role: 'assistant',
          provider: 'deepseek',
          model: 'deepseek-v4.1-flash-expires-on-0910',
          stopReason: 'stop',
          usage: { input: 1_000, output: 200, cost: { total: 0 } },
        },
      );

      expect(harness.store.traces.getRun('run-1')?.run.costUsd).toBe(0);
    } finally {
      harness.close();
    }
  });
});

/**
 * DoD 门禁：`record()` 在事件回调里同步执行，单次开销必须足够小。
 * 中文说明：这条用例守住「写入不能阻塞事件循环」——入队是 O(1)，每 200 条触发一次
 * 批量 flush（SQLite 单事务），所以只有极少数调用的开销包含落库时间。
 */
describe('record() synchronous cost', () => {
  it('keeps p95 of 1000 record() calls under 5ms with the sqlite backend', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-trace-perf-'));
    const store: PlatformStore = openPlatformStore({
      mode: 'sqlite',
      dbPath: join(dir, 'platform.db'),
    });
    const ledger = new SessionLedger(store.traces, undefined, { runIdFactory: () => 'perf-run' });
    try {
      ledger.record(context, event({ type: 'agent_start' }));
      const samples: number[] = [];
      for (let index = 0; index < 1_000; index += 1) {
        const toolCallId = `call-${index}`;
        ledger.record(
          context,
          event({ type: 'tool_execution_start', toolCallId, toolName: 'bash' }),
        );
        const started = performance.now();
        ledger.record(
          context,
          event({
            type: 'tool_execution_end',
            toolCallId,
            toolName: 'bash',
            result: { content: [{ type: 'text', text: 'ok' }] },
            isError: false,
          }),
        );
        samples.push(performance.now() - started);
      }
      samples.sort((left, right) => left - right);
      const p95 = samples[Math.floor(samples.length * 0.95)];
      const max = samples.at(-1) ?? 0;
      expect(p95).toBeLessThan(5);
      // 单次最坏开销也应有界（p95 会掩盖个别含 flush 的调用）。
      expect(max).toBeLessThan(50);
      // 断言真的落库了（不是只入队就完事）。
      expect(store.stats().flushed).toBe(1_000);
      expect(store.traces.getRun('perf-run')?.steps).toHaveLength(1_000);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
