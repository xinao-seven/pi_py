/**
 * 向用户提问的交互通道（QuestionBroker + `ask_user` 工具）。
 *
 * 中文说明：这是与「危险命令审批」并列的**第二条人机交互通道**，语义也刻意保持一致：
 * 工具调用挂起 → SSE 推给前端 → 用户在弹窗里回答 → 结算挂起的 Promise → 模型在同一次
 * 工具调用里拿到结构化答案并继续。这样模型不需要「问完就结束本轮、等用户再发一条消息」
 * 这种猜测式协作（旧实现就是这样：答案只能靠用户在聊天框里自由文本回复，模型还得猜哪句是回答）。
 *
 * 关键设计：
 * - **挂起而不是结束轮次**：工具 execute 返回 Promise，turn 保持存活；用户回答后模型继续。
 * - **一次可以问多个问题**：批量提交，前端一个弹窗填完一起发回；每题可单选/多选/自由输入。
 * - **一定有时间上限**：超时按「未回答」结算（不是错误），模型据此按假设推进或停下说明，
 *   不会把会话永久挂住（会话 abort / 关闭同样会结算）。
 * - **唯一真相源**：挂起队列在本类里；`PlanView` 不再镜像「待回答问题」，
 *   会话状态快照（`pendingQuestion`）与 SSE 事件都从这里取。
 */

import { randomUUID } from 'node:crypto';

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';

import { ApiError } from '../errors.js';

/** `ask_user` 工具名（注册表把它并入预设白名单，见 withInlineTools）。 */
export const ASK_USER_TOOL_NAME = 'ask_user';

/** 上限：一次提问最多几题、每题多少选项（防止把弹窗塞爆）。 */
export const MAX_QUESTIONS = 8;
export const MAX_OPTIONS = 12;
const LIMITS = { question: 500, option: 120, details: 500, id: 40 };

/** 一个问题。 */
export interface QuestionSpec {
  id: string;
  question: string;
  /** 可选项；为空表示只允许自由输入。 */
  options?: string[];
  /** 是否多选（默认单选）。 */
  multiSelect?: boolean;
  /** 是否允许自由输入（默认 true；即使给了选项也允许「其他」）。 */
  allowFreeText?: boolean;
  /** 补充说明（显示在题干下方）。 */
  details?: string;
}

/** 用户对某一题的回答。 */
export interface QuestionAnswer {
  id: string;
  /** 选中的选项（多选时为多个；自由输入时为空）。 */
  selected: string[];
  /** 自由输入的文本。 */
  text?: string;
  /** 用户明确跳过了这一题。 */
  skipped?: boolean;
}

/** 一次提问的挂起状态（SSE `question_pending` 与会话状态快照共用的载荷）。 */
export interface PendingQuestion {
  sessionId: string;
  /** 本次提问的 id：前端回答时原样带回。 */
  questionId: string;
  toolCallId: string;
  questions: QuestionSpec[];
  createdAt: string;
}

/** 结算原因：区分用户提交、用户取消、超时、中止与会话清理。 */
export type QuestionReason = 'user' | 'cancelled' | 'timeout' | 'abort' | 'session' | 'disposed';

/** 一次提问的结果（工具据此如实汇报给模型）。 */
export interface QuestionOutcome {
  answered: boolean;
  reason: QuestionReason;
  answers: QuestionAnswer[];
}

export interface UserQuestionOptions {
  /**
   * 用户未回答时的等待上限（毫秒），默认 10 分钟。
   * 中文说明：比审批的 30 秒长得多——回答问题要读上下文、可能要查代码；
   * 但必须有上限，否则用户走开后会话会永久挂着（超时按「未回答」结算而不是报错）。
   */
  timeoutMs?: number;
  idFactory?: () => string;
  now?: () => Date;
}

/** 一个正在等待回答的挂起项（内部用）。 */
interface Waiter {
  pending: PendingQuestion;
  timer: NodeJS.Timeout;
  settle(reason: QuestionReason, answers?: QuestionAnswer[]): void;
}

/** 工具参数（TypeBox 推断）。 */
const QUESTION_SCHEMA = Type.Object({
  id: Type.Optional(Type.String()),
  question: Type.String({ minLength: 1 }),
  options: Type.Optional(Type.Array(Type.String())),
  multiSelect: Type.Optional(Type.Boolean()),
  allowFreeText: Type.Optional(Type.Boolean()),
  details: Type.Optional(Type.String()),
});
const ASK_USER_SCHEMA = Type.Object({
  questions: Type.Array(QUESTION_SCHEMA, { minItems: 1, maxItems: MAX_QUESTIONS }),
});
type AskUserParams = Static<typeof ASK_USER_SCHEMA>;

/** 把工具参数规整成问题列表（补 id、去重、校验上限）。 */
export function normalizeQuestions(
  input: readonly {
    id?: string;
    question: string;
    options?: string[];
    multiSelect?: boolean;
    allowFreeText?: boolean;
    details?: string;
  }[],
): QuestionSpec[] {
  if (input.length === 0) throw new Error('至少要问一个问题');
  if (input.length > MAX_QUESTIONS)
    throw new Error(`一次最多问 ${MAX_QUESTIONS} 个问题（收到 ${input.length} 个）`);
  const used = new Set<string>();
  return input.map((item, index) => {
    const question = item.question.trim();
    if (!question) throw new Error(`第 ${index + 1} 个问题为空`);
    if (question.length > LIMITS.question)
      throw new Error(`第 ${index + 1} 个问题过长（上限 ${LIMITS.question} 字）`);
    const base = (item.id?.trim() || `q${index + 1}`).slice(0, LIMITS.id);
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    const options = (item.options ?? [])
      .map((option) => option.trim())
      .filter((option) => option.length > 0);
    if (options.length > MAX_OPTIONS)
      throw new Error(`第 ${index + 1} 个问题选项过多（上限 ${MAX_OPTIONS} 个）`);
    for (const option of options) {
      if (option.length > LIMITS.option)
        throw new Error(`第 ${index + 1} 个问题的选项过长（上限 ${LIMITS.option} 字）`);
    }
    return {
      id,
      question,
      ...(options.length === 0 ? {} : { options }),
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
      // 默认允许自由输入：选项永远可能不全，逼用户在预设项里选是最讨厌的交互。
      ...(item.allowFreeText === false ? { allowFreeText: false } : {}),
      ...(item.details === undefined || item.details.trim() === ''
        ? {}
        : { details: item.details.trim() }),
    };
  });
}

/**
 * 把回答渲染成模型可读的文本。
 * 中文说明：即使答案来自选项，也把选项文本原样写出（而不是只给 id）——
 * 模型看到的是语义完整的句子，不需要回头查自己上一次问了什么。
 */
export function renderAnswers(pending: PendingQuestion, outcome: QuestionOutcome): string {
  if (!outcome.answered) {
    const why =
      outcome.reason === 'timeout'
        ? '用户在规定时间内没有回答（可能不在电脑前）'
        : outcome.reason === 'cancelled'
          ? '用户选择暂不回答，让你自己决定'
          : '提问被中止（会话被停止或关闭）';
    return [
      `[用户未回答] ${why}。`,
      '请按最合理的假设继续推进，并在回复里**明确写出你采用的假设**；',
      '如果确实无法在假设下继续（例如缺少必须由用户提供的信息），请停下并说明需要什么，不要反复追问。',
    ].join('\n');
  }
  const lines = ['[用户回答]'];
  pending.questions.forEach((spec, index) => {
    const answer = outcome.answers.find((item) => item.id === spec.id);
    lines.push(`${index + 1}. ${spec.question}`);
    if (answer === undefined || answer.skipped === true) {
      lines.push('   → （用户跳过，未回答）');
      return;
    }
    const parts: string[] = [];
    if (answer.selected.length > 0) parts.push(`选中：${answer.selected.join('、')}`);
    if (answer.text && answer.text.trim().length > 0) parts.push(`补充：${answer.text.trim()}`);
    lines.push(`   → ${parts.length > 0 ? parts.join('；') : '（空回答）'}`);
  });
  return lines.join('\n');
}

/**
 * 提问中枢：维护挂起队列 + 回答超时，并以内联扩展注册 `ask_user` 工具。
 * 中文说明：不依赖 Fastify/SSE，便于单测；扩展闭包直接引用本实例，
 * `ask()` 的 Promise 在回答/取消/超时/中止/会话关闭时结算。
 */
export class QuestionBroker {
  private readonly waiting = new Map<string, Waiter>();
  private onPending: ((pending: PendingQuestion) => void) | undefined;
  private onResolved: ((sessionId: string, questionId: string) => void) | undefined;

  constructor(private readonly options: UserQuestionOptions = {}) {}

  /** 生成「向用户提问」内联扩展：注册 `ask_user` 工具并保证它在本会话可用。 */
  buildExtension(): InlineExtension {
    // 工具定义的 execute 是普通函数（不是箭头函数），这里的 this 会指向工具自身，
    // 因此先把 broker 抓出来再闭包引用。
    const broker = this;
    return (pi: ExtensionAPI) => {
      pi.registerTool({
        name: ASK_USER_TOOL_NAME,
        label: '向用户提问',
        description:
          '向用户提问并等待回答（一次可以问多个问题）。每题可给选项（默认单选，可设 multiSelect 多选），' +
          '用户也可以自由输入。可用于澄清需求、选择方案、确认风险偏好等；' +
          '回答会作为本工具的返回值给你，不需要结束本轮等用户再发消息。' +
          '信息不足且无法从代码/文档推断时用它，不要靠猜。',
        promptSnippet: '向用户提问（可多题、选项、自由输入）',
        promptGuidelines: [
          '需要用户拍板（方案选择、需求歧义、风险取舍）时用 ask_user，把相关问题一次问完，不要连环追问。',
          '能自己从代码或文档查到的答案不要问用户；问题要具体、可回答。',
          '用户可能不回答（超时或选择让你自己决定），此时按最合理的假设继续，并写明假设。',
        ],
        parameters: ASK_USER_SCHEMA,
        async execute(_toolCallId, params: AskUserParams, signal, _onUpdate, ctx) {
          const questions = normalizeQuestions(params.questions);
          const { pending, outcome } = await broker.ask({
            sessionId: ctx.sessionManager.getSessionId(),
            toolCallId: _toolCallId,
            questions,
            ...(signal === undefined ? {} : { signal }),
          });
          return {
            content: [{ type: 'text' as const, text: renderAnswers(pending, outcome) }],
            details: {
              questionId: pending?.questionId ?? null,
              answered: outcome.answered,
              reason: outcome.reason,
              answers: outcome.answers,
            },
          };
        },
      });
      // 提问是通用交互能力，不属于 Plan：会话一开始就可用，之后也不会被计划工具回收。
      pi.on('session_start', () => {
        const active = pi.getActiveTools();
        if (!active.includes(ASK_USER_TOOL_NAME)) {
          pi.setActiveTools([...active, ASK_USER_TOOL_NAME]);
        }
      });
    };
  }

  /**
   * 提问并等待用户回答。
   * 同一会话已有挂起提问时直接报错（前端只有一个弹窗，叠两个会让人不知所措）。
   */
  async ask(input: {
    sessionId: string;
    toolCallId: string;
    questions: QuestionSpec[];
    signal?: AbortSignal;
  }): Promise<{ pending: PendingQuestion; outcome: QuestionOutcome }> {
    const existing = this.pendingForSession(input.sessionId);
    if (existing !== undefined) {
      throw new Error(
        `已经有一个待回答的问题（${existing.questionId}）：请等用户回答后再提问，不要连环追问。`,
      );
    }
    const pending: PendingQuestion = {
      sessionId: input.sessionId,
      questionId: this.options.idFactory?.() ?? randomUUID(),
      toolCallId: input.toolCallId,
      questions: input.questions,
      createdAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    const key = this.key(pending.sessionId, pending.questionId);
    if (input.signal?.aborted === true) {
      return { pending, outcome: { answered: false, reason: 'abort', answers: [] } };
    }
    const outcome = await new Promise<QuestionOutcome>((resolve) => {
      let settled = false;
      const settle = (reason: QuestionReason, answers: QuestionAnswer[] = []): void => {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        input.signal?.removeEventListener('abort', abort);
        this.waiting.delete(key);
        this.onResolved?.(pending.sessionId, pending.questionId);
        resolve({ answered: reason === 'user', reason, answers });
      };
      const abort = (): void => settle('abort');
      const timer = setTimeout(
        () => settle('timeout'),
        this.options.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS,
      );
      // 不因等待回答而拖住进程退出（生产里 HTTP server 自己会保持运行）。
      timer.unref?.();
      const waiter: Waiter = { pending, timer, settle };
      this.waiting.set(key, waiter);
      input.signal?.addEventListener('abort', abort, { once: true });
      this.onPending?.(pending);
    });
    return { pending, outcome };
  }

  /** 注册「有新提问」监听器（注册表用它发 SSE `question_pending`）。 */
  setPendingListener(listener: (pending: PendingQuestion) => void): void {
    this.onPending = listener;
  }

  /** 注册「提问已结算」监听器（注册表用它发 SSE `question_resolved`）。 */
  setResolvedListener(listener: (sessionId: string, questionId: string) => void): void {
    this.onResolved = listener;
  }

  /**
   * 用户提交回答（`answer_question` 命令的底层实现）。
   * `cancelled: true` 表示用户选择「不回答，让 AI 自己决定」。
   */
  answer(
    sessionId: string,
    questionId: string,
    payload: { answers?: QuestionAnswer[]; cancelled?: boolean },
  ): void {
    const waiter = this.waiting.get(this.key(sessionId, questionId));
    if (waiter === undefined) {
      throw new ApiError(404, 'question_not_found', 'The question is no longer pending');
    }
    if (payload.cancelled === true) {
      waiter.settle('cancelled');
      return;
    }
    const incoming = payload.answers ?? [];
    const known = new Set(waiter.pending.questions.map((spec) => spec.id));
    for (const [index, answer] of incoming.entries()) {
      if (typeof answer.id !== 'string' || !known.has(answer.id)) {
        throw new ApiError(
          422,
          'validation_error',
          `answers[${index}].id must be one of: ${[...known].join(', ')}`,
        );
      }
      if (
        !Array.isArray(answer.selected) ||
        answer.selected.some((item) => typeof item !== 'string')
      ) {
        throw new ApiError(
          422,
          'validation_error',
          `answers[${index}].selected must be a string[]`,
        );
      }
    }
    // 没提到的题按「跳过」补齐，前端因此可以只提交用户真正填了的题。
    const answers: QuestionAnswer[] = waiter.pending.questions.map((spec) => {
      const found = incoming.find((item) => item.id === spec.id);
      if (found === undefined) return { id: spec.id, selected: [], skipped: true };
      const text = typeof found.text === 'string' ? found.text.trim() : '';
      return {
        id: spec.id,
        selected: found.selected,
        ...(text.length === 0 ? {} : { text }),
        ...(found.selected.length === 0 && text.length === 0 ? { skipped: true } : {}),
      };
    });
    waiter.settle('user', answers);
  }

  /** 会话关闭/删除时，把该会话所有挂起提问按「会话结束」结算。 */
  cancelSession(sessionId: string): void {
    for (const [key, waiter] of [...this.waiting]) {
      if (key.startsWith(`${sessionId}:`)) waiter.settle('session');
    }
  }

  /** 查询某会话当前挂起的提问（供状态快照展示 `pendingQuestion`）。 */
  pendingForSession(sessionId: string): PendingQuestion | undefined {
    for (const [key, waiter] of this.waiting) {
      if (key.startsWith(`${sessionId}:`)) return waiter.pending;
    }
    return undefined;
  }

  /** 服务关闭：把所有挂起提问按「已关闭」结算，不留下永远挂着的工具调用。 */
  dispose(): void {
    for (const [, waiter] of [...this.waiting]) waiter.settle('disposed');
  }

  private key(sessionId: string, questionId: string): string {
    return `${sessionId}:${questionId}`;
  }
}

/** 默认等待上限：10 分钟（用户可能正在读代码/思考，但也不能无限等）。 */
export const DEFAULT_QUESTION_TIMEOUT_MS = 10 * 60_000;
