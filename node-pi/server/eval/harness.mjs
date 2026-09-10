// M4 评测/端到端公用的 harness：真实 SDK + 真实 AgentRegistry + 真实 PlanModeService/TaskRunner，
// 只把模型换成 fauxProvider（脚本化响应）。全程离线、临时目录，不碰真实 ~/.pi/agent。
//
// 中文说明：spike/07（端到端验收）与 eval/run.mjs（golden set 指标）共用同一套装配，
// 避免「评测里跑通的路径和真机不是同一条」这种最没意义的假绿。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import {
  ModelRuntime,
  createAgentSession,
  SessionManager,
  DefaultResourceLoader,
} from '@earendil-works/pi-coding-agent';

import {
  AgentRegistry,
  dropInlineOwnedExtensions,
  withInlineTools,
} from '../dist/services/agent-registry.js';
import { PlanModeService } from '../dist/services/plan-mode-service.js';
import { PLAN_TOOL_NAMES } from '../dist/services/plan-tools.js';
import { TaskService } from '../dist/services/task-service.js';
import { MemoryTaskRepository } from '../dist/services/platform/task-repository.js';
import { TaskRecoveryService } from '../dist/services/task-recovery.js';
import { TaskInFlightTracker } from '../dist/services/task-recovery-extension.js';
import { TaskRunner } from '../dist/services/task-runner.js';
import { ASK_USER_TOOL_NAME, QuestionBroker } from '../dist/services/user-question.js';

export { fauxAssistantMessage, fauxToolCall };

export const AGENT_TOOLS = ['read', 'write', 'edit', 'bash'];

/**
 * 启动一套完整的 M4 环境。
 * `toolNames` 传入时按预设白名单处理（SDK 的 `tools` 是可用工具白名单，
 * 因此必须并入内联扩展的工具名——与 AgentRegistry.create 的做法一致）。
 */
export async function startHarness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-m4-eval-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'ws');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, 'auth.json'), '{}\n');
  writeFileSync(join(agentDir, 'models.json'), '{ "providers": {} }\n');

  const faux = fauxProvider();
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const model = runtime.getModel(faux.provider.id, faux.getModel().id);

  // 提问通道（M4.1）：与 app.ts 同构地注入；评测里脚本化模型不会真的提问，
  // 但工具本身必须在场（否则「模型可见工具集」的断言就不是真实环境了）。
  const questions = new QuestionBroker({ timeoutMs: 60_000 });
  const tasks = new TaskService(new MemoryTaskRepository());
  const plans = new PlanModeService();
  plans.setTaskService(tasks);
  plans.setListener(() => undefined);
  const owner = options.owner ?? 'eval-owner';
  const recovery = new TaskRecoveryService(tasks, { owner });
  let sessionManager;
  let runner;
  const tracker = new TaskInFlightTracker(tasks, {
    lookupActiveTask: (sessionId) => registry.get(sessionId)?.activeTaskId,
    onSettled: (sessionId) => runner?.handleSettled(sessionId),
  });

  // 与 AgentRegistry.create 走同一个并入逻辑（预设白名单是「可用工具白名单」）。
  const toolList = withInlineTools(options.toolNames, [...PLAN_TOOL_NAMES, ASK_USER_TOOL_NAME]);

  const factory = {
    async create(input) {
      const loader = new DefaultResourceLoader({
        cwd: input.cwd,
        agentDir,
        extensionFactories: [
          plans.buildExtension(),
          tracker.buildExtension(),
          questions.buildExtension(),
        ],
        extensionsOverride: (base) => dropInlineOwnedExtensions(base).result,
      });
      await loader.reload();
      sessionManager = SessionManager.create(input.cwd, join(agentDir, 'sessions'));
      const { session } = await createAgentSession({
        cwd: input.cwd,
        agentDir,
        modelRuntime: runtime,
        model,
        sessionManager,
        resourceLoader: loader,
        ...(toolList === undefined ? {} : { tools: toolList }),
        thinkingLevel: 'off',
      });
      return session;
    },
  };

  const registry = new AgentRegistry(factory, undefined, plans);
  runner = new TaskRunner({ tasks, recovery, registry, tracker, owner });
  plans.setExecutor(runner);

  const entry = await registry.create({ cwd });
  const sessionId = entry.session.sessionId;

  /** 观测：工具结果（含错误）、助手文本、settle 计数。 */
  const seen = { toolResults: [], assistantText: [], settleCount: 0 };
  entry.session.subscribe((event) => {
    if (event.type === 'tool_execution_end') {
      seen.toolResults.push({
        toolName: event.toolName,
        isError: event.isError === true,
        text: JSON.stringify(event.result?.content ?? ''),
      });
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const text = (event.message.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (text.trim()) seen.assistantText.push(text);
    }
  });
  registry.subscribe(sessionId, 0, (event) => {
    if (event.payload?.type === 'agent_settled') seen.settleCount += 1;
  });

  let consumed = 0;
  /** 等一次 run 结算（registry.command 不 await 模型，与 HTTP 202 语义一致）。 */
  function waitForSettle(timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (seen.settleCount > consumed) {
          consumed += 1;
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error('run did not settle in time'));
        }
      }, 5);
      // 刻意不 unref：轮询本身就是「还在等 run」的唯一活跃句柄，
      // unref 掉会让事件循环空转结束、await 无声挂死（第一次就踩到了）。
    });
  }

  return {
    root,
    cwd,
    agentDir,
    faux,
    registry,
    tasks,
    plans,
    questions,
    runner,
    recovery,
    session: entry.session,
    sessionId,
    seen,
    waitForSettle,
    /** 直接写一个工作区文件（模拟「产物已生成」）。 */
    writeArtifact(relative, content = 'ok') {
      const target = join(cwd, relative);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, `${content}\n`);
      return target;
    },
    async cleanup() {
      try {
        await registry.close();
      } catch {
        // 关闭失败不影响评测结论。
      }
      plans.dispose();
      questions.dispose();
      tasks.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 助手文本里是否出现了 M4 之前依赖的标记（Plan: 标题 / [DONE:n]）。 */
export function hasLegacyMarkers(texts) {
  return texts.some(
    (text) =>
      /(^|\n)\s*#{0,6}\s*\**\s*(Plan|计划)\s*[:：]/i.test(text) || /\[DONE:\d+\]/i.test(text),
  );
}
