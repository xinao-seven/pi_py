// M4 评测/端到端公用的 harness：真实 SDK + 真实 AgentRegistry + 真实 PlanModeService/TaskRunner，
// 只把模型换成 fauxProvider（脚本化响应）。全程离线、临时目录，不碰真实 ~/.pi/agent。
//
// 中文说明：spike/07（端到端验收）与 eval/run.mjs（golden set 指标）共用同一套装配，
// 避免「评测里跑通的路径和真机不是同一条」这种最没意义的假绿。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { AgentRegistry, OriginalPiSessionFactory } from '../dist/services/agent-registry.js';
import { PlanModeService } from '../dist/services/plan-mode-service.js';
import { PLAN_TOOL_NAMES } from '../dist/services/plan-tools.js';
import { TaskService } from '../dist/services/task-service.js';
import { MemoryTaskRepository } from '../dist/services/platform/task-repository.js';
import { TaskRecoveryService } from '../dist/services/task-recovery.js';
import { TaskInFlightTracker } from '../dist/services/task-recovery-extension.js';
import { TaskRunner } from '../dist/services/task-runner.js';
import { QuestionBroker } from '../dist/services/user-question.js';
import { SubagentService } from '../dist/services/subagent-service.js';
import { SessionLedger } from '../dist/services/observability/session-ledger.js';
import { openPlatformStore } from '../dist/services/platform/store.js';

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
  // 账本（内存 trace 存储）：M5 的评测要断言子 run 真的挂在父 run 下。
  const store = openPlatformStore({ mode: 'memory' });
  const ledger = new SessionLedger(store.traces);
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

  // 用**真实**的 OriginalPiSessionFactory：工具白名单并入、子会话构造（落盘目录 /
  // parentSession 链 / 不递归）、扩展注入都是生产路径；只把模型换成 faux（注入 runtime）。
  // 子会话落盘到 <agentDir>/../agent-node-server/subagents（与生产一致）
  const subagents = new SubagentService({
    agentDir,
    // 评测里不需要真落盘：用临时目录即可（仍是"不碰真实 ~/.pi"）
    sessionDir: join(root, 'subagents'),
  });
  const factory = new OriginalPiSessionFactory(
    agentDir,
    undefined,
    undefined,
    plans,
    undefined,
    undefined,
    tracker,
    questions,
    subagents,
  );
  factory.useRuntime(async () => runtime);
  // 记录被创建的子会话：评测要断言「子会话的工具集 / 落盘目录 / 深度」这些结构性事实。
  const children = [];
  const createSession = factory.create.bind(factory);
  factory.create = async (input) => {
    const created = await createSession(input);
    if (input.subagent !== undefined) children.push({ session: created, input });
    return created;
  };

  const registry = new AgentRegistry(
    factory,
    undefined,
    plans,
    undefined,
    ledger,
    undefined,
    subagents,
  );
  subagents.attach({ registry, factory, ledger });
  plans.setReadOnlyAgentResolver((cwd, preset) => subagents.isReadOnlyPreset(cwd, preset));
  runner = new TaskRunner({ tasks, recovery, registry, tracker, owner, subagents });
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
    subagents,
    ledger,
    store,
    /** 本次评测里被创建的子会话（按创建顺序）。 */
    children,
    /** 写一个子 agent 预设（`<agentDir>/agents/<name>.md`）。 */
    writePreset(name, { tools, model, body } = {}) {
      const dir = join(agentDir, 'agents');
      mkdirSync(dir, { recursive: true });
      const lines = [
        '---',
        `name: ${name}`,
        `description: 评测预设 ${name}`,
        ...(tools === undefined ? [] : [`tools: ${tools.join(', ')}`]),
        ...(model === undefined ? [] : [`model: ${model}`]),
        '---',
        '',
        body ?? `SUBAGENT-PRESET:${name}`,
      ];
      const text = lines.join('\n') + '\n';
      writeFileSync(join(dir, `${name}.md`), text, 'utf8');
      return join(dir, `${name}.md`);
    },
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
      try {
        store.close();
      } catch {
        // 已关闭
      }
      plans.dispose();
      questions.dispose();
      tasks.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * 给「父会话 + 子会话」分别发脚本。
 * 中文说明：faux 的响应是**全局 FIFO**，父子会话会互相抢；这里用响应工厂按
 * 系统提示词区分（子会话的系统提示词里有预设正文的 `SUBAGENT-PRESET:` 标记），
 * 再各自从自己的队列里取——不然「委派的评测」根本没法脚本化。
 */
export function scriptedResponses({ parent, child, steps = 30 }) {
  const queues = { parent: [...(parent ?? [])], child: [...(child ?? [])] };
  const dispatch = (context) => {
    const isChild =
      typeof context.systemPrompt === 'string' && context.systemPrompt.includes('SUBAGENT-PRESET:');
    const queue = queues[isChild ? 'child' : 'parent'];
    const next = queue.shift();
    if (next === undefined) throw new Error(`faux 脚本已用尽（${isChild ? '子会话' : '父会话'}）`);
    return typeof next === 'function' ? next(context) : next;
  };
  // faux 的响应是「一步一条」地消耗，所以把同一个分发器铺成多步：
  // 每一步都会按「父/子」重新选队列，父子交替也就不会互相抢脚本。
  return Array.from({ length: steps }, () => dispatch);
}

/** 助手文本里是否出现了 M4 之前依赖的标记（Plan: 标题 / [DONE:n]）。 */
export function hasLegacyMarkers(texts) {
  return texts.some(
    (text) =>
      /(^|\n)\s*#{0,6}\s*\**\s*(Plan|计划)\s*[:：]/i.test(text) || /\[DONE:\d+\]/i.test(text),
  );
}
