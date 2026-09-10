import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

import { AgentRegistry, type PiSession } from '../../../src/services/agent-registry.js';
import { SessionLedger } from '../../../src/services/observability/session-ledger.js';
import { openPlatformStore, type PlatformStore } from '../../../src/services/platform/store.js';

/**
 * M1 的端到端验证：**真实 SDK + 离线 fauxProvider** 驱动一次完整 agent loop，
 * 事件经 AgentRegistry.publish() → SessionLedger → 存储层落库。
 *
 * 中文说明：单元测试用的是假会话，只能证明账本自身逻辑；本用例补齐了真实事件形状、
 * 真实扩展加载器（observability 扩展的 provider 钩子注册不报错）与真实 run 生命周期
 * （agent_start → turn → tool → agent_settled）这一段，属于 M1 DoD 的证据。
 * 全程离线、不访问网络，目录落在临时目录。
 */

interface Harness {
  registry: AgentRegistry;
  store: PlatformStore;
  session: PiSession;
  sessionId: string;
  /** 与 harness 内部同一个 fauxProvider 句柄（脚本化模型响应必须用它）。 */
  faux: ReturnType<typeof fauxProvider>;
  cleanup: () => void;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      // 清理失败不影响断言结果
    }
  }
});

async function startHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'pi-ledger-e2e-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'workspace');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, 'auth.json'), '{}\n', 'utf8');
  writeFileSync(join(agentDir, 'models.json'), '{ "providers": {} }\n', 'utf8');
  writeFileSync(join(cwd, 'notes.md'), '# notes\nhello from faux\n', 'utf8');

  const faux = fauxProvider();
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const model = runtime.getModel(faux.provider.id, faux.getModel().id);

  const store = openPlatformStore({ mode: 'memory' });
  const ledger = new SessionLedger(store.traces, undefined, {
    runIdFactory: () => 'e2e-run-1',
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    // 真实扩展加载路径：仅注入可观测性扩展（观测钩子在这里被注册）。
    extensionFactories: [ledger.buildExtension()],
  });
  await loader.reload();

  const sessionManager = SessionManager.create(cwd, join(agentDir, 'sessions'));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager,
    resourceLoader: loader,
    thinkingLevel: 'off',
  });

  const facade = session as unknown as PiSession;
  // 第 5 个参数才是账本（publish() 的唯一插桩点）。
  const registry = new AgentRegistry(
    { create: async () => facade },
    undefined,
    undefined,
    undefined,
    ledger,
  );
  const entry = await registry.create({ cwd });
  cleanups.push(() => {
    void registry.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    registry,
    store,
    session: facade,
    sessionId: entry.session.sessionId,
    faux,
    cleanup: () => undefined,
  };
}

describe('SessionLedger end to end (real SDK + fauxProvider)', () => {
  it('records a real agent loop run with its tool call step', async () => {
    const harness = await startHarness();
    const faux = harness.faux;
    // 真实会话的工具集由 resourceLoader 决定：取第一个可用工具发起一次调用。
    const toolName = harness.session.getActiveToolNames().includes('read')
      ? 'read'
      : harness.session.getActiveToolNames()[0];
    expect(toolName).toBeDefined();
    const args = toolName === 'read' ? { path: 'notes.md' } : { command: 'echo hi' };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(toolName, args)], { stopReason: 'toolUse' }),
      fauxAssistantMessage('done'),
    ]);

    await harness.session.prompt('look at the notes');

    const detail = harness.store.traces.getRun('e2e-run-1');
    expect(detail?.run).toMatchObject({
      sessionId: harness.sessionId,
      cwd: expect.stringContaining('workspace'),
      status: 'completed',
      turns: 2,
    });
    // TTFT 与 run 耗时都来自真实事件时间戳。
    expect(detail?.run.ttftMs).toBeGreaterThanOrEqual(0);
    expect(detail?.run.durationMs).toBeGreaterThanOrEqual(0);

    const kinds = detail?.steps.map((step) => step.kind) ?? [];
    expect(kinds.filter((kind) => kind === 'llm_call')).toHaveLength(2);
    // provider 层观测：HTTP 200 与首字节耗时都落在 llm_call 的 meta 上
    // （fauxProvider 也走真实的 provider 钩子链，见 spike 输出）。
    const llm = detail?.steps.find((step) => step.kind === 'llm_call');
    expect(llm?.meta).toMatchObject({ httpStatus: 200 });
    expect(typeof (llm?.meta as { httpLatencyMs?: number })?.httpLatencyMs).toBe('number');
    // 真实 usage 落库（成本账本的数据源）。
    expect(detail?.run.inputTokens).toBeGreaterThan(0);

    const tool = detail?.steps.find((step) => step.kind === 'tool_call');
    expect(tool?.toolName).toBe(toolName);
    expect(tool?.argsDigest).toBeTruthy();
    expect(tool?.isError).toBe(false);

    // 聚合读路径也要有数（Dashboard 就是读这些）。
    const summary = harness.store.traces.summary({});
    expect(summary.totals.runs).toBe(1);
    expect(summary.totals.turns).toBe(2);
    expect(summary.byTool[0]).toMatchObject({ toolName, calls: 1 });
    expect(summary.daily).toHaveLength(1);
  }, 30_000);
});
