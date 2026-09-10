/**
 * Plan 工具（M4）：把计划的产出与推进交给**工具调用**，而不是解析自然语言。
 *
 * 中文说明（P2 的根治）：旧实现要求模型在回答里写 `Plan:` 标题 + 列表，再用正则抠出来，
 * 模型漏写标题时「确认并执行」必然 409、面板永远停在「正在生成计划」；步骤完成靠
 * `[DONE:n]` 自证，漏写一次执行态就永不收敛。根因是**把状态机的迁移条件交给了模型的文风**。
 *
 * 现在：计划由 `submit_plan` 产出（结构化参数 + 服务端校验），步骤推进由 `complete_step`
 * 完成（必须带证据，且按 `verification` 声明校验），卡住用 `block_step` 明确上报。
 * 模型不需要记住任何标记语法，只需要调用工具。
 *
 * 这些工具**始终注册、也始终在 activeTools 里**（会话创建时由预设白名单并入，见
 * `agent-registry.ts` 的 `withInlineTools`）。原因有两个：
 * 1. 缓存：`tools` 数组与 system prompt 一起构成请求前缀，计划开始/结束时增删工具会让
 *    整个前缀缓存失效（见 docs/node-plan-cache-stability.md）；
 * 2. 语义：模型该不该走规划流程，由它自己用 `propose_plan` 征求用户同意来定，
 *    而不是靠「用户先按下按钮，工具才出现」。
 * 没计划时误调 `submit_plan` 不会造出计划：`PlanToolbox.requirePlan()` 会直接报错。
 *
 * 工具实现只依赖 `TaskService` + 一个可注入的 `exists`（产物校验），因此可以脱离
 * Pi 会话单测（见 test/services/plan-tools.test.ts）。
 */

import { Type, type Static } from 'typebox';
import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import type { TaskRecord, StepEvidence, StepVerification } from './platform/task-model.js';
import { evaluateStepEvidence } from './platform/step-verification.js';
import { derivePlanStatus, isActivePlanStatus } from './platform/plan-model.js';
import type { PlanStepInput, TaskService } from './task-service.js';

/** 标题归一化：与 TaskService.replacePlanSteps 的按标题复用进度保持一致。 */
function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** `propose_plan`：模型主动提议进入规划模式（用户同意后才开启）。 */
export const PROPOSE_PLAN_TOOL_NAME = 'propose_plan';

/**
 * 计划工具名。
 * 中文说明：`agent-registry.ts` 把它们并入 SDK 的 tools 白名单（白名单＝activeTools），
 * 所以这个数组的内容会直接影响请求里的工具数组——**增删任何一个都会让前缀缓存失效**，
 * 因此顺序与内容都保持稳定，不要在会话生命周期里动态增删。
 */
export const PLAN_TOOL_NAMES = [
  PROPOSE_PLAN_TOOL_NAME,
  'submit_plan',
  'update_plan',
  'complete_step',
  'block_step',
] as const;
export type PlanToolName = (typeof PLAN_TOOL_NAMES)[number];

/** 计划步骤数上限（防止模型一次提交几百步把面板与上下文撑爆）。 */
export const MAX_PLAN_STEPS = 50;

const VERIFICATION_SCHEMA = Type.Object({
  kind: Type.Union([Type.Literal('command'), Type.Literal('file'), Type.Literal('manual')]),
  command: Type.Optional(Type.String()),
  expectExitCode: Type.Optional(Type.Integer()),
  path: Type.Optional(Type.String()),
});

const STEP_SCHEMA = Type.Object({
  title: Type.String({ minLength: 1 }),
  details: Type.Optional(Type.String()),
  verification: Type.Optional(VERIFICATION_SCHEMA),
});

const SUBMIT_PLAN_SCHEMA = Type.Object({
  title: Type.String({ minLength: 1 }),
  steps: Type.Array(STEP_SCHEMA, { minItems: 1 }),
});

const PROPOSE_PLAN_SCHEMA = Type.Object({
  goal: Type.Optional(
    Type.String({
      maxLength: 200,
      description: '这次要解决的目标（一句话）；缺省时用你刚收到的那条用户消息。',
    }),
  ),
  reason: Type.Optional(
    Type.String({ maxLength: 500, description: '为什么值得先出计划再动手（给用户看的理由）。' }),
  ),
});

const UPDATE_PLAN_SCHEMA = Type.Object({
  revision: Type.Integer({ minimum: 1 }),
  title: Type.Optional(Type.String()),
  steps: Type.Optional(Type.Array(STEP_SCHEMA, { minItems: 1 })),
});

const COMPLETE_STEP_SCHEMA = Type.Object({
  stepId: Type.String({ minLength: 1 }),
  evidence: Type.Object({
    summary: Type.Optional(Type.String()),
    commands: Type.Optional(
      Type.Array(
        Type.Object({
          command: Type.String(),
          exitCode: Type.Union([Type.Integer(), Type.Null()]),
        }),
      ),
    ),
    files: Type.Optional(Type.Array(Type.String())),
  }),
});

const BLOCK_STEP_SCHEMA = Type.Object({
  stepId: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
});

type SubmitPlanParams = Static<typeof SUBMIT_PLAN_SCHEMA>;
/** `propose_plan` 的参数（由会话层实现，见 `ProposePlanHandler`）。 */
export type ProposePlanParams = Static<typeof PROPOSE_PLAN_SCHEMA>;
type UpdatePlanParams = Static<typeof UPDATE_PLAN_SCHEMA>;
type CompleteStepParams = Static<typeof COMPLETE_STEP_SCHEMA>;
type BlockStepParams = Static<typeof BLOCK_STEP_SCHEMA>;

export interface PlanToolboxOptions {
  tasks: TaskService;
  sessionId: string;
  /** 产物存在性检查（测试注入；默认走 fs）。 */
  exists?: (path: string) => boolean;
}

/** 工具用例层：把参数变成任务写入，并把领域错误翻译成模型能照做的错误信息。 */
export class PlanToolbox {
  private planTaskId: string | undefined;
  private onChanged: ((task: TaskRecord) => void) | undefined;

  constructor(private readonly options: PlanToolboxOptions) {}

  /**
   * 注册「已写入」回调（Plan 会话用它立即广播新视图）。
   * 中文说明：不依赖外部「任务变更 → 刷新计划视图」的桥接——工具是计划状态的主要写入者，
   * 让它自己触发广播，计划面板才不会在工具调用后停在旧状态。
   */
  setOnChanged(listener: (task: TaskRecord) => void): void {
    this.onChanged = listener;
  }

  /** 写入后广播（回调失败不影响工具结果）。 */
  private changed(task: TaskRecord): TaskRecord {
    try {
      this.onChanged?.(task);
    } catch {
      // 广播是增量能力，失败降级为不推送。
    }
    return task;
  }

  /** 绑定当前会话正在处理的计划（会话 attach 或 startPlanning 时设置）。 */
  bind(taskId: string | undefined): void {
    this.planTaskId = taskId;
  }

  get boundTaskId(): string | undefined {
    return this.planTaskId;
  }

  /** 读取当前计划（每次都从库里读，避免拿着过期副本判断状态）。 */
  current(): TaskRecord | undefined {
    return this.planTaskId === undefined ? undefined : this.options.tasks.get(this.planTaskId);
  }

  /** 提交/重交计划：替换步骤并进入 `proposed`（等待用户确认）。 */
  submitPlan(params: SubmitPlanParams): TaskRecord {
    const task = this.requirePlan();
    const status = derivePlanStatus(task);
    if (status === 'executing' || status === 'completed' || status === 'abandoned') {
      throw new Error(
        `计划当前状态是 ${status}，不能用 submit_plan 整体替换；` +
          (status === 'executing'
            ? '执行中要调整请用 update_plan（带 revision）。'
            : '请让用户先开一个新计划。'),
      );
    }
    const steps = this.normalizeSteps(params.steps);
    let next = this.options.tasks.replacePlanSteps(task.id, steps);
    if (params.title.trim() && params.title.trim() !== next.title) {
      next = this.options.tasks.update(task.id, {
        title: params.title.trim(),
        ifRevision: next.revision,
      });
    }
    return this.changed(this.options.tasks.setPlanState(task.id, { status: 'proposed' }));
  }

  /** 修订计划（标题/步骤）；`revision` 不匹配时把当前版本回给模型让它重读。 */
  updatePlan(params: UpdatePlanParams): TaskRecord {
    const task = this.requirePlan();
    const status = derivePlanStatus(task);
    if (!isActivePlanStatus(status)) throw new Error(`计划已经 ${status}，无法再修改。`);
    // 执行中允许调整**还没开始**的步骤（M4 的明确需求），但已经开始/已完成的步骤必须原样保留：
    // 整体替换会按标题复用进度，所以只要标题还在就不会丢证据；真正危险的是删掉或改名，
    // 那会静默丢掉已完成的工作。这里把这条不变量讲清楚，而不是一刀切禁止修改计划。
    if (params.steps !== undefined) {
      const protectedSteps = task.steps.filter((step) => step.status !== 'pending');
      const nextTitles = new Set(params.steps.map((step) => normalizeTitle(step.title)));
      const lost = protectedSteps.filter((step) => !nextTitles.has(normalizeTitle(step.title)));
      if (lost.length > 0) {
        throw new Error(
          `不能删除或重命名已经开始/已完成的步骤：${lost
            .map((step) => `[${step.id}] ${step.title}（${step.status}）`)
            .join('、')}。` +
            '请保留这些步骤的标题不变，只调整还没开始的部分（或让用户在面板上操作）。',
        );
      }
    }
    if (task.revision !== params.revision) {
      throw new Error(
        `revision 不匹配：计划当前 revision=${task.revision}（你传的是 ${params.revision}）。` +
          '请以当前 revision 重发，或先读取最新计划。',
      );
    }
    let next = task;
    if (params.title !== undefined && params.title.trim() && params.title.trim() !== task.title) {
      next = this.options.tasks.update(task.id, {
        title: params.title.trim(),
        ifRevision: task.revision,
      });
    }
    if (params.steps !== undefined) {
      next = this.options.tasks.replacePlanSteps(task.id, this.normalizeSteps(params.steps));
      if (derivePlanStatus(next) === 'drafting') {
        next = this.options.tasks.setPlanState(task.id, { status: 'proposed' });
      }
    }
    return this.changed(next);
  }

  /** 完成一步：校验证据 → 写状态；证据不符则抛错（模型据此补齐后重试）。 */
  completeStep(
    params: CompleteStepParams,
    toolCallId: string,
    cwd?: string,
  ): {
    task: TaskRecord;
    detail: string;
  } {
    const task = this.requirePlan();
    const status = derivePlanStatus(task);
    if (status !== 'executing') {
      throw new Error(
        `计划当前状态是 ${status}，还不能上报步骤完成：` +
          '只有用户确认执行（plan_execute）之后才允许推进步骤。',
      );
    }
    const step = task.steps.find((item) => item.id === params.stepId);
    if (step === undefined) {
      throw new Error(
        `找不到步骤 ${params.stepId}。当前步骤：${task.steps
          .map((item) => `${item.id}(${item.title})`)
          .join('、')}`,
      );
    }
    const evidence = this.toEvidence(params.evidence, toolCallId);
    const effectiveCwd = cwd ?? task.cwd;
    const check = evaluateStepEvidence(step.verification, evidence, {
      ...(effectiveCwd === undefined ? {} : { cwd: effectiveCwd }),
      ...(this.options.exists === undefined ? {} : { exists: this.options.exists }),
    });
    if (!check.ok) throw new Error(`证据不足，暂不能标记完成：${check.detail}`);
    const saved = this.changed(
      this.options.tasks.completeStepWithEvidence(task.id, step.id, {
        ...evidence,
        summary: evidence.summary ?? check.detail,
      }),
    );
    return { task: saved, detail: check.detail };
  }

  /** 阻塞一步并说明原因（计划随之进入 paused，向用户求助）。 */
  blockStep(params: BlockStepParams): TaskRecord {
    const task = this.requirePlan();
    const step = task.steps.find((item) => item.id === params.stepId);
    if (step === undefined) throw new Error(`找不到步骤 ${params.stepId}`);
    return this.changed(
      this.options.tasks.updateStep(task.id, step.id, {
        status: 'blocked',
        blockedReason: params.reason,
        ifRevision: task.revision,
      }),
    );
  }

  private requirePlan(): TaskRecord {
    const task = this.current();
    if (task === undefined) {
      throw new Error(
        '当前会话没有进行中的计划。如果任务较大或方向不明，先调用 propose_plan 征求用户是否先规划；' +
          '小任务直接完成（或用文字回答）即可，不要调用 submit_plan 造计划。',
      );
    }
    return task;
  }

  private normalizeSteps(steps: readonly SubmitPlanParams['steps'][number][]): PlanStepInput[] {
    if (steps.length === 0) throw new Error('计划至少要有一个步骤');
    if (steps.length > MAX_PLAN_STEPS) {
      throw new Error(`计划步骤过多（${steps.length}），请拆成不超过 ${MAX_PLAN_STEPS} 步`);
    }
    const titles = new Set<string>();
    return steps.map((step, index) => {
      const title = step.title.trim();
      if (!title) throw new Error(`第 ${index + 1} 步缺少标题`);
      const key = title.toLowerCase();
      if (titles.has(key)) throw new Error(`第 ${index + 1} 步与前面的步骤标题重复：「${title}」`);
      titles.add(key);
      const verification = step.verification as StepVerification | undefined;
      if (verification !== undefined) {
        if (verification.kind === 'file' && !verification.path)
          throw new Error(`第 ${index + 1} 步声明 kind=file 但没有给 path`);
        if (verification.kind === 'command' && !verification.command)
          throw new Error(`第 ${index + 1} 步声明 kind=command 但没有给 command`);
      }
      return {
        title,
        ...(step.details === undefined ? {} : { details: step.details }),
        ...(verification === undefined ? {} : { verification }),
      };
    });
  }

  private toEvidence(input: CompleteStepParams['evidence'], toolCallId: string): StepEvidence {
    const commands = (input.commands ?? []).map((item) => ({
      command: item.command,
      exitCode: item.exitCode ?? null,
    }));
    return {
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      toolCallIds: toolCallId ? [toolCallId] : [],
      filesTouched: (input.files ?? []).map((file) => file),
      ...(commands.length === 0 ? {} : { commands }),
    };
  }
}

/** 把执行结果包成 Pi 的工具结果（模型可读的文本 + 结构化 details）。 */
function textResult(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details };
}

/** 计划视图摘要（工具返回给模型的计划现状，避免模型凭记忆操作）。 */
function summarize(task: TaskRecord): string {
  const done = task.steps.filter((step) => step.status === 'completed').length;
  const lines = task.steps.map(
    (step) =>
      `- [${step.id}] ${step.title}（${step.status}）${verificationNote(step.verification)}`,
  );
  return [
    `计划「${task.title}」状态=${derivePlanStatus(task)} revision=${task.revision} 进度=${done}/${task.steps.length}`,
    ...lines,
  ].join('\n');
}

function verificationNote(verification: StepVerification | undefined): string {
  if (verification === undefined) return '';
  if (verification.kind === 'file') return ` 需产物：${verification.path ?? '(未声明)'}`;
  if (verification.kind === 'command')
    return ` 需命令：${verification.command ?? '(未声明)'}（退出码 ${verification.expectExitCode ?? 0}）`;
  return ' 需人工确认说明';
}

/**
 * 构造五个计划工具。
 * `execute` 里的异常按 Pi 惯例抛出即被标记为 isError，模型看得到原因并据此调整——
 * 这是「服务端校验」真正生效的地方。
 */
export function buildPlanTools(toolbox: PlanToolbox): ToolDefinition[] {
  // defineTool 保留每个工具的参数类型推断（直接用对象字面量会被 ToolDefinition 的默认泛型吞成 unknown）。
  return [
    defineTool({
      name: 'submit_plan',
      label: '提交计划',
      description:
        '提交（或重交）一份结构化执行计划：先调研，然后用本工具给出标题与步骤。' +
        '步骤尽量可独立验证：能验证的步骤请写 verification（file 产物 / command 命令 + 期望退出码 / manual 人工确认）。' +
        '提交后计划进入「待确认」，等用户确认再执行；在用户确认前不要改动工作区。' +
        '本会话还没有计划时不要直接用它——先用 propose_plan 征求用户同意。',
      promptSnippet: '提交结构化执行计划（规划期的主产物）',
      promptGuidelines: [
        '规划期不要用文字罗列计划就结束：调研完成后必须调用 submit_plan 提交结构化计划。',
        '步骤标题要具体、可验证、一步一件事；需要产物校验的步骤请声明 verification。',
        '需要用户决策时用 ask_user 提问（一次问完，不要连环追问），不要自己假设。',
      ],
      parameters: SUBMIT_PLAN_SCHEMA,
      async execute(_toolCallId, params) {
        const task = toolbox.submitPlan(params);
        return textResult(`计划已提交，等待用户确认。\n${summarize(task)}`, {
          planId: task.id,
          taskId: task.id,
          status: derivePlanStatus(task),
          revision: task.revision,
        });
      },
    }),
    defineTool({
      name: 'update_plan',
      label: '修订计划',
      description:
        '按用户意见修订计划（标题/步骤）。必须带上当前 revision；不匹配时会得到最新的 revision，' +
        '请以最新值重发。执行中如果已有步骤完成，不要整体替换步骤。',
      promptSnippet: '按用户意见修订计划',
      parameters: UPDATE_PLAN_SCHEMA,
      async execute(_toolCallId, params) {
        const task = toolbox.updatePlan(params);
        return textResult(`计划已更新。\n${summarize(task)}`, {
          planId: task.id,
          taskId: task.id,
          status: derivePlanStatus(task),
          revision: task.revision,
        });
      },
    }),
    defineTool({
      name: 'complete_step',
      label: '上报步骤完成',
      description:
        '上报某一步骤完成，必须带证据：做了什么（summary）、跑过什么命令与退出码（commands）、' +
        '改了哪些文件（files）。若该步声明了 verification，服务端会校验证据，不通过会返回错误，' +
        '请补齐（例如真的跑一遍验证命令、或先把产物做出来）后重新上报。不要在没有证据时调用。',
      promptSnippet: '上报步骤完成（带证据，服务端校验）',
      promptGuidelines: [
        '每完成一步就立刻调用 complete_step，不要攒到最后一次性上报。',
        'commands 里必须是实际执行过的命令与真实退出码；没有验证过的步骤不要声称完成。',
      ],
      parameters: COMPLETE_STEP_SCHEMA,
      async execute(toolCallId, params, _signal, _onUpdate, ctx) {
        const { task, detail } = toolbox.completeStep(params, toolCallId, ctx?.cwd);
        const remaining = task.steps.filter((step) => step.status !== 'completed');
        return textResult(
          `步骤已标记完成：${detail}\n${summarize(task)}` +
            (remaining.length === 0
              ? '\n所有步骤已完成，计划结束。'
              : `\n剩余 ${remaining.length} 步，请继续推进下一步：${remaining[0].id} ${remaining[0].title}`),
          {
            planId: task.id,
            taskId: task.id,
            status: derivePlanStatus(task),
            revision: task.revision,
            stepId: params.stepId,
          },
        );
      },
    }),
    defineTool({
      name: 'block_step',
      label: '上报步骤阻塞',
      description:
        '某一步无法继续时使用（缺少信息、外部依赖不可用、需要用户决策等），必须写清原因。' +
        '计划会进入暂停状态并把原因显示给用户，然后停下等用户处理，不要自行绕路或伪造完成。',
      promptSnippet: '上报步骤阻塞（计划暂停，等用户处理）',
      parameters: BLOCK_STEP_SCHEMA,
      async execute(_toolCallId, params) {
        const task = toolbox.blockStep(params);
        return textResult(
          `已上报阻塞：${params.reason}\n${summarize(task)}\n请停下等待用户处理。`,
          {
            planId: task.id,
            taskId: task.id,
            status: derivePlanStatus(task),
            revision: task.revision,
            stepId: params.stepId,
          },
        );
      },
    }),
  ];
}

/**
 * `propose_plan` 的落地实现：由 Plan 会话注入。
 * 中文说明：这一个工具需要「向用户提问」+「开启规划」两件事，都不属于纯任务写入的
 * `PlanToolbox`，因此留在 model-facing 文案同文件、实现放在 `plan-mode-service.ts`。
 * 返回的是已经面向模型的文本 + 结构化 details，服务层不需要再包一层。
 */
export type ProposePlanHandler = (
  params: ProposePlanParams,
  context: { toolCallId: string; signal?: AbortSignal },
) => Promise<AgentToolResult<unknown>>;

/**
 * 构造 `propose_plan`：模型主动提议「先规划」，但**只有用户同意才真的开启**。
 * 中文说明：这是「模型自己决定要不要规划」与「只有用户能确认执行」之间的桥——
 * 提议权给模型，决定权仍在用户手里；用户同意后才进入只读规划期。
 */
export function buildProposePlanTool(propose: ProposePlanHandler): ToolDefinition {
  return defineTool({
    name: PROPOSE_PLAN_TOOL_NAME,
    label: '提议进入规划模式',
    description:
      '向用户提议进入规划模式（只读调研 → 产出结构化计划 → 用户确认后再执行）。' +
      '用户在弹窗里选「先规划」后，服务端会开启规划，并把本轮变成只读：下一步请调研，' +
      '然后调用 submit_plan；若用户选「直接做」或超时未答，就当没有这回事，继续直接完成任务。' +
      '适合任务较大、方向不明、改错代价高的情况；小改动或指令已经明确时不要用，直接做。',
    promptSnippet: '向用户提议进入规划模式（用户点头才开启）',
    promptGuidelines: [
      '拿不准要不要规划时用 propose_plan 问用户，不要自己对着一句话的任务开工，也不要先调 submit_plan。',
      '一次只提议一件事；用户拒绝或没答就继续直接做，不要反复提议。',
      '已经在规划/执行中时不要调用它（直接 submit_plan / update_plan / complete_step）。',
    ],
    parameters: PROPOSE_PLAN_SCHEMA,
    async execute(toolCallId, params, signal) {
      return propose(params, {
        toolCallId,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  });
}
