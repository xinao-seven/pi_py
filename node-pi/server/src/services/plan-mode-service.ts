/**
 * Web Plan 模式：按会话的状态机 + 内联扩展。
 *
 * 中文说明：Plan 的工具限制、文本解析、JSONL 持久化与 REST 命令校验都收敛到本模块。
 * buildExtension() 为每个会话注册 Pi 生命周期钩子（工具权限的最终约束点），钩子委托给
 * 按会话隔离的 PlanMachine；服务层负责按 sessionId 找到状态机、下发 enable/disable/
 * execute/refine 命令，并把状态快照转发给注册表（SSE 推给前端）。
 */

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

import { ApiError } from '../errors.js';

export type PlanMode = 'normal' | 'planning' | 'executing';
export interface PlanTodo {
  step: number;
  text: string;
  completed: boolean;
}
export interface PlanSnapshot {
  sessionId: string;
  mode: PlanMode;
  todos: PlanTodo[];
  awaitingConfirmation: boolean;
}

const PLAN_TOOLS = ['read', 'bash', 'grep', 'find', 'ls', 'questionnaire'];
const PLAN_DISABLED_TOOLS = new Set(['edit', 'write']);
// MCP 工具统一前缀（与 src/services/mcp/mcp-tools.ts 的命名约定一致）。
// 规划期无法证明 MCP 工具只读，保守全部拦截。
const MCP_TOOL_PREFIX = 'mcp__';
const CUSTOM_TYPE = 'web-plan-mode';

interface Todo {
  step: number;
  text: string;
  completed: boolean;
}
interface StoredState {
  enabled: boolean;
  executing: boolean;
  todos: Todo[];
  toolsBeforePlanMode?: string[];
  awaitingConfirmation?: boolean;
}
interface AssistantLike {
  role: 'assistant';
  content: Array<{ type?: unknown; text?: unknown }>;
}
interface SessionContext {
  sessionManager: {
    getSessionId(): string;
    getEntries(): unknown[];
  };
}

function isAssistant(value: unknown): value is AssistantLike {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { role?: unknown }).role === 'assistant' &&
    Array.isArray((value as { content?: unknown }).content)
  );
}
function assistantText(message: AssistantLike): string {
  return message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}
// 计划头兼容 Plan: / **Plan:** / ## Plan / ### 计划： 等常见变体（大小写、中英文、冒号可选）。
function extractPlan(message: string): Todo[] {
  const header = message.match(
    /^\s*(?:#{1,6}\s*)?\*{0,2}(?:[Pp]lan|计划)\s*[:：]?\s*\*{0,2}\s*$/im,
  );
  if (!header) return [];
  // 逐行解析编号/无序列表：比跨行 matchAll 的锚定更稳，避免 \s* 吞掉换行导致漏项。
  const items: Array<{ step?: number; text: string }> = [];
  for (const line of message.slice((header.index ?? 0) + header[0].length).split(/\r?\n/)) {
    const trimmed = line.trim();
    const numbered = trimmed.match(/^(\d+)\s*[.)、:]\s+(.+)$/);
    if (numbered) {
      items.push({ step: Number(numbered[1]), text: numbered[2].trim() });
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) items.push({ text: bullet[1].trim() });
  }
  const todos: Todo[] = [];
  const numberedOnly = items.some((item) => item.step !== undefined);
  for (const [index, item] of items.entries()) {
    const text = item.text.replace(/\*{1,2}/g, '').trim();
    if (!text) continue;
    const step = numberedOnly ? item.step : index + 1;
    if (step === undefined || todos.some((todo) => todo.step === step)) continue;
    todos.push({ step, text, completed: false });
  }
  return todos;
}
function markDone(message: string, todos: Todo[]): boolean {
  let changed = false;
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const todo = todos.find((item) => item.step === Number(match[1]));
    if (todo && !todo.completed) {
      todo.completed = true;
      changed = true;
    }
  }
  return changed;
}
function isSafePlanCommand(command: string): boolean {
  const sideEffect =
    /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|tee|dd|shred|sudo|kill|reboot|shutdown|curl|wget)\b|(^|[^<])>(?!>)|>>|\b(npm|pnpm|yarn|pip)\s+(install|add|remove|uninstall|update|publish)\b|\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash)\b/i;
  const readOnly =
    /^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|type|env|printenv|uname|whoami|id|date|uptime|ps|git\s+(status|log|diff|show|branch|remote|config\s+--get)|npm\s+(list|ls|view|info|search|outdated|audit)|rg|fd|sed\s+-n|awk)/i;
  return !sideEffect.test(command) && readOnly.test(command);
}

/**
 * 一个会话的 Plan 状态机：持有模式/待办/工具快照，并通过 ExtensionAPI 限制工具、
 * 注入上下文、发送执行指令、把状态写入会话 JSONL。
 */
class PlanMachine {
  private sessionId = '';
  private planning = false;
  private executing = false;
  private awaitingConfirmation = false;
  private todos: Todo[] = [];
  private toolsBeforePlanMode: string[] | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly service: PlanModeService,
  ) {}

  /** session_start：绑定 sessionId、从 JSONL 恢复模式，并把本状态机登记给服务。 */
  attach(ctx: SessionContext): void {
    this.sessionId = ctx.sessionManager.getSessionId();
    const entry = ctx.sessionManager
      .getEntries()
      .filter((item) => {
        const entry = item as { type?: string; customType?: string };
        return entry.type === 'custom' && entry.customType === CUSTOM_TYPE;
      })
      .pop() as { data?: StoredState } | undefined;
    if (entry?.data) {
      this.planning = entry.data.enabled;
      this.executing = entry.data.executing;
      this.todos = entry.data.todos ?? [];
      this.toolsBeforePlanMode = entry.data.toolsBeforePlanMode;
      this.awaitingConfirmation = entry.data.awaitingConfirmation === true;
    }
    if (this.planning) this.restrictTools();
    else if (this.executing) this.restoreTools();
    this.service.attach(this, this.sessionId);
    this.publish();
  }

  /** tool_call：规划期只允许白名单只读 bash，拦截 edit/write 与全部 MCP 工具。 */
  onToolCall(event: {
    toolName: string;
    toolCallId: string;
    input: unknown;
  }): { block: true; reason: string } | undefined {
    if (!this.planning) return undefined;
    if (event.toolName === 'edit' || event.toolName === 'write')
      return {
        block: true,
        reason:
          'Plan mode is read-only. Confirm execution or disable Plan mode before editing files.',
      };
    // MCP 工具可能修改外部状态，无法证明只读，规划期一律拦截。
    if (event.toolName.startsWith(MCP_TOOL_PREFIX))
      return {
        block: true,
        reason:
          'Plan mode is read-only. MCP tools may modify external state; confirm execution or disable Plan mode before calling them.',
      };
    if (event.toolName === 'bash') {
      const command = (event.input as { command?: unknown }).command;
      if (typeof command !== 'string' || !isSafePlanCommand(command))
        return {
          block: true,
          reason: 'Plan mode only permits allowlisted local read-only bash commands.',
        };
    }
    return undefined;
  }

  /** before_agent_start：把当前模式/待办作为隐藏上下文注入。 */
  beforeAgentStart():
    { message: { customType: string; content: string; display: boolean } } | undefined {
    if (this.planning)
      return {
        message: {
          customType: 'web-plan-context',
          display: false,
          content:
            '[PLAN MODE ACTIVE]\nYou are in read-only planning mode. Discuss and inspect first, then present a detailed numbered plan under a `Plan:` header. Do not make changes.',
        },
      };
    if (this.executing && this.todos.length)
      return {
        message: {
          customType: 'web-plan-execution-context',
          display: false,
          content: `[EXECUTING PLAN]\nComplete remaining steps in order and write [DONE:n] only after verification.\n${this.todos
            .filter((todo) => !todo.completed)
            .map((todo) => `${todo.step}. ${todo.text}`)
            .join('\n')}`,
        },
      };
    return undefined;
  }

  /** turn_end：执行期从 [DONE:n] 更新步骤完成状态。 */
  onTurnEnd(event: { message: unknown }): void {
    if (
      this.executing &&
      isAssistant(event.message) &&
      markDone(assistantText(event.message), this.todos)
    )
      this.publish();
  }

  /** agent_end：规划期从消息里提取第一条可解析的 Plan，进入等待确认。 */
  onAgentEnd(event: { messages: unknown[] }): void {
    if (this.executing && this.todos.length && this.todos.every((todo) => todo.completed)) {
      this.executing = false;
      this.todos = [];
      this.publish();
      return;
    }
    if (!this.planning) return;
    // 计划可能出现在中间某条 assistant 消息（末条只是收尾话），反向取第一条可解析的计划。
    let proposal: Todo[] = [];
    for (const message of [...event.messages].reverse()) {
      if (!isAssistant(message)) continue;
      const found = extractPlan(assistantText(message));
      if (found.length) {
        proposal = found;
        break;
      }
    }
    if (proposal.length) {
      this.todos = proposal;
      this.awaitingConfirmation = true;
      this.publish();
    }
  }

  enable(): void {
    this.planning = true;
    this.executing = false;
    this.awaitingConfirmation = false;
    this.todos = [];
    this.restrictTools();
    this.publish();
  }
  disable(): void {
    this.planning = false;
    this.executing = false;
    this.awaitingConfirmation = false;
    this.todos = [];
    this.restoreTools();
    this.publish();
  }
  /** refine：用户给出修改意见，恢复规划并让 Agent 重新产出计划。 */
  refine(message: string): void {
    this.awaitingConfirmation = false;
    this.publish();
    this.pi.sendUserMessage(message, { deliverAs: 'followUp' });
  }
  execute(): void {
    this.planning = false;
    this.executing = true;
    this.awaitingConfirmation = false;
    this.restoreTools();
    this.publish();
    const remaining = this.todos
      .filter((todo) => !todo.completed)
      .map((todo) => `${todo.step}. ${todo.text}`)
      .join('\n');
    this.pi.sendMessage(
      {
        customType: 'web-plan-execute',
        content: `[EXECUTING PLAN]\n\nRemaining steps:\n${remaining}\n\nExecute in order. Only write [DONE:n] after a completed, verified step.`,
        display: false,
      },
      { triggerTurn: true, deliverAs: 'followUp' },
    );
  }

  snapshot(): PlanSnapshot {
    return {
      sessionId: this.sessionId,
      mode: this.executing ? 'executing' : this.planning ? 'planning' : 'normal',
      todos: this.todos,
      awaitingConfirmation: this.awaitingConfirmation,
    };
  }

  private restrictTools(): void {
    this.toolsBeforePlanMode ??= this.pi.getActiveTools();
    this.pi.setActiveTools([
      ...new Set([
        ...this.toolsBeforePlanMode.filter((name) => !PLAN_DISABLED_TOOLS.has(name)),
        ...PLAN_TOOLS,
      ]),
    ]);
  }
  private restoreTools(): void {
    if (this.toolsBeforePlanMode) this.pi.setActiveTools(this.toolsBeforePlanMode);
    this.toolsBeforePlanMode = undefined;
  }
  private publish(): void {
    this.pi.appendEntry(CUSTOM_TYPE, {
      enabled: this.planning,
      executing: this.executing,
      todos: this.todos,
      toolsBeforePlanMode: this.toolsBeforePlanMode,
      awaitingConfirmation: this.awaitingConfirmation,
    } satisfies StoredState);
    this.service.publishState(this.snapshot());
  }
}

/** Web Plan 模式服务：按会话持有状态机，并向注册表转发状态快照。 */
export class PlanModeService {
  private readonly machines = new Map<string, PlanMachine>();
  private listener: ((state: PlanSnapshot) => void) | undefined;

  /** 生成"Web Plan 模式"内联扩展：每个会话注册一套生命周期钩子。 */
  buildExtension(): InlineExtension {
    return (pi: ExtensionAPI) => {
      const machine = new PlanMachine(pi, this);
      pi.on('session_start', (_event, ctx) => machine.attach(ctx as SessionContext));
      pi.on('tool_call', (event) => machine.onToolCall(event));
      pi.on('before_agent_start', () => machine.beforeAgentStart());
      pi.on('turn_end', (event) => machine.onTurnEnd(event));
      pi.on('agent_end', (event) => machine.onAgentEnd(event));
    };
  }

  /** 注册"状态快照更新"监听器（注册表用它发 SSE 事件）。 */
  setListener(listener: (state: PlanSnapshot) => void): void {
    this.listener = listener;
  }

  /** 状态快照（无活跃状态机时返回默认 normal）。 */
  state(sessionId: string): PlanSnapshot {
    return (
      this.machines.get(sessionId)?.snapshot() ?? {
        sessionId,
        mode: 'normal',
        todos: [],
        awaitingConfirmation: false,
      }
    );
  }

  /** 下发 Plan 命令：校验当前状态后委托给对应会话的状态机。 */
  command(
    sessionId: string,
    action: 'enable' | 'disable' | 'execute' | 'refine',
    message?: string,
  ): void {
    const current = this.state(sessionId);
    if (action === 'execute' && (!current.awaitingConfirmation || current.todos.length === 0)) {
      throw new ApiError(409, 'plan_not_ready', 'No generated plan is awaiting confirmation');
    }
    if (action === 'refine' && (!current.awaitingConfirmation || !message?.trim())) {
      throw new ApiError(
        422,
        'validation_error',
        'A refinement message is required for the current generated plan',
      );
    }
    const machine = this.machines.get(sessionId);
    if (!machine)
      throw new ApiError(409, 'plan_unavailable', 'Plan mode is unavailable for this session');
    if (action === 'enable') machine.enable();
    else if (action === 'disable') machine.disable();
    else if (action === 'execute') machine.execute();
    else machine.refine(message!.trim());
  }

  /** 状态机登记（attach 时调用）。 */
  attach(machine: PlanMachine, sessionId: string): void {
    this.machines.set(sessionId, machine);
  }

  /** 会话移除时清理其状态机。 */
  remove(sessionId: string): void {
    this.machines.delete(sessionId);
  }

  /** 状态快照更新转发给监听器。 */
  publishState(state: PlanSnapshot): void {
    this.listener?.(state);
  }

  dispose(): void {
    this.machines.clear();
  }
}
