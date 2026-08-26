/**
 * Web Plan 模式扩展。
 *
 * Agent 侧只负责：规划期工具锁定、Plan/DONE 文本解析和 Session JSONL 恢复。
 * services/plan-mode-service.ts 只负责将 Web REST/SSE 命令桥接到下方事件通道；此文件
 * 不引入 pi-agent-core 或 pi-ai，避免扩展需要未声明的间接依赖。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PLAN_CHANNEL_SET = 'pi:plan-mode:set';
const PLAN_CHANNEL_STATE = 'pi:plan-mode:state';
const PLAN_TOOLS = ['read', 'bash', 'grep', 'find', 'ls', 'questionnaire'];
const PLAN_DISABLED_TOOLS = new Set(['edit', 'write']);
// MCP 工具统一前缀（与 src/services/mcp/mcp-tools.ts 的命名约定一致）。
// 规划期无法证明 MCP 工具只读，保守全部拦截。
const MCP_TOOL_PREFIX = 'mcp__';
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

export default function planModeExtension(pi: ExtensionAPI): void {
  let sessionId = '';
  let planning = false;
  let executing = false;
  let awaitingConfirmation = false;
  let todos: Todo[] = [];
  let toolsBeforePlanMode: string[] | undefined;
  const publish = () => {
    pi.appendEntry('web-plan-mode', {
      enabled: planning,
      executing,
      todos,
      toolsBeforePlanMode,
      awaitingConfirmation,
    } satisfies StoredState);
    if (sessionId)
      pi.events.emit(PLAN_CHANNEL_STATE, {
        sessionId,
        mode: executing ? 'executing' : planning ? 'planning' : 'normal',
        todos,
        awaitingConfirmation,
      });
  };
  const restrictTools = () => {
    toolsBeforePlanMode ??= pi.getActiveTools();
    pi.setActiveTools([
      ...new Set([
        ...toolsBeforePlanMode.filter((name) => !PLAN_DISABLED_TOOLS.has(name)),
        ...PLAN_TOOLS,
      ]),
    ]);
  };
  const restoreTools = () => {
    if (toolsBeforePlanMode) pi.setActiveTools(toolsBeforePlanMode);
    toolsBeforePlanMode = undefined;
  };
  pi.events.on(PLAN_CHANNEL_SET, (value) => {
    const command = value as { sessionId?: string; action?: string; message?: string };
    if (!sessionId || command.sessionId !== sessionId) return;
    if (command.action === 'enable') {
      planning = true;
      executing = false;
      awaitingConfirmation = false;
      todos = [];
      restrictTools();
      publish();
      return;
    }
    if (command.action === 'disable') {
      planning = false;
      executing = false;
      awaitingConfirmation = false;
      todos = [];
      restoreTools();
      publish();
      return;
    }
    if (command.action === 'refine' && planning && awaitingConfirmation && command.message) {
      awaitingConfirmation = false;
      publish();
      pi.sendUserMessage(command.message, { deliverAs: 'followUp' });
      return;
    }
    if (command.action === 'execute' && awaitingConfirmation && todos.length) {
      planning = false;
      executing = true;
      awaitingConfirmation = false;
      restoreTools();
      publish();
      const remaining = todos
        .filter((todo) => !todo.completed)
        .map((todo) => `${todo.step}. ${todo.text}`)
        .join('\n');
      pi.sendMessage(
        {
          customType: 'web-plan-execute',
          content: `[EXECUTING PLAN]\n\nRemaining steps:\n${remaining}\n\nExecute in order. Only write [DONE:n] after a completed, verified step.`,
          display: false,
        },
        { triggerTurn: true, deliverAs: 'followUp' },
      );
    }
  });
  pi.on('session_start', (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    const entry = ctx.sessionManager
      .getEntries()
      .filter(
        (item: { type: string; customType?: string }) =>
          item.type === 'custom' && item.customType === 'web-plan-mode',
      )
      .pop() as { data?: StoredState } | undefined;
    if (entry?.data) {
      planning = entry.data.enabled;
      executing = entry.data.executing;
      todos = entry.data.todos ?? [];
      toolsBeforePlanMode = entry.data.toolsBeforePlanMode;
      awaitingConfirmation = entry.data.awaitingConfirmation === true;
    }
    if (planning) restrictTools();
    else if (executing) restoreTools();
    pi.events.emit(PLAN_CHANNEL_STATE, {
      sessionId,
      mode: executing ? 'executing' : planning ? 'planning' : 'normal',
      todos,
      awaitingConfirmation,
    });
  });
  pi.on('tool_call', (event) => {
    if (!planning) return undefined;
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
  });
  pi.on('before_agent_start', () => {
    if (planning)
      return {
        message: {
          customType: 'web-plan-context',
          display: false,
          content:
            '[PLAN MODE ACTIVE]\nYou are in read-only planning mode. Discuss and inspect first, then present a detailed numbered plan under a `Plan:` header. Do not make changes.',
        },
      };
    if (executing && todos.length)
      return {
        message: {
          customType: 'web-plan-execution-context',
          display: false,
          content: `[EXECUTING PLAN]\nComplete remaining steps in order and write [DONE:n] only after verification.\n${todos
            .filter((todo) => !todo.completed)
            .map((todo) => `${todo.step}. ${todo.text}`)
            .join('\n')}`,
        },
      };
  });
  pi.on('turn_end', (event) => {
    if (executing && isAssistant(event.message) && markDone(assistantText(event.message), todos))
      publish();
  });
  pi.on('agent_end', (event) => {
    if (executing && todos.length && todos.every((todo) => todo.completed)) {
      executing = false;
      todos = [];
      publish();
      return;
    }
    if (!planning) return;
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
      todos = proposal;
      awaitingConfirmation = true;
      publish();
    }
  });
}
