/**
 * 「会话信息」快照：把当前会话**会发给模型的东西**抽成一份只读的结构化快照。
 *
 * 中文说明：
 * - 数据全部来自 SDK 会话对象本尊（`systemPrompt` getter、`getAllTools()`、`resourceLoader`），
 *   所以**不需要任何钩子、不落库、不碰 agent loop**，第一次发消息前就能看；
 * - 为什么不走 `before_provider_request` 的 payload：那条路只在真的发出请求时才有值，而且拿到的是
 *   provider 格式化后的对象；本文件要回答的是「当前会话现在会发什么」——用途不同。
 *   （请求形状的指纹观测在 P1 已另有实现，见 `observability/prompt-shape.ts`。）
 * - 三个来源都是**可选**的：假会话、老实现、或 SDK 改 API 时一律降级为空（`safe()` 吞异常），
 *   绝不让面板把请求打挂。
 */

/** 工具来源分类（面板按它分组）。 */
export type ToolSourceKind =
  | 'builtin' // SDK 内置工具（read / bash / edit / write …）
  | 'sdk' // 通过 createAgentSession 直接注入的 SDK 工具
  | 'inline' // 内联扩展注册的工具（本项目的计划工具 / ask_user / subagent / 审批 / MCP）
  | 'extension' // 用户级或工作区的文件扩展
  | 'mcp' // MCP server 提供的工具（mcp__<server>__<tool>）
  | 'package' // pi 包提供的扩展
  | 'other';

/** 工具参数（面板展示用）。 */
export interface PromptToolParam {
  name: string;
  required: boolean;
}

/** 一个注册到会话里的工具（含「当前是否激活」）。 */
export interface PromptToolInfo {
  name: string;
  description: string;
  params: PromptToolParam[];
  source: ToolSourceKind;
  /** 来源路径/标记：内联扩展是 `<inline>`，文件扩展与包是真实路径。 */
  sourcePath?: string;
  /** 是否在**当前激活**的工具集里——未激活＝注册了但这一次不会发给模型。 */
  active: boolean;
  /** MCP 工具的归属（由注册表用 mcpService 解析，拿不到时缺省）。 */
  mcp?: { server: string; tool: string };
  /** 工具自带的提示词指南（会被拼进系统提示词的 guidelines 段）。 */
  promptGuidelines: string[];
}

export interface PromptSkillInfo {
  name: string;
  description: string;
  /** SKILL.md 的路径。 */
  location: string;
  /** 标记「不注入提示词、只能显式调用」的 skill（SDK 的 disableModelInvocation）。 */
  disableModelInvocation: boolean;
}

export interface PromptTemplateInfo {
  name: string;
  description: string;
  /** 参数提示（`/name <arg>` 的形式）。 */
  argumentHint?: string;
  path?: string;
}

export interface PromptContextFileInfo {
  path: string;
  chars: number;
}

/** 概览计数（面板顶部 chips）。 */
export interface PromptSnapshotOverview {
  systemPromptChars: number;
  /** 系统提示词过大被截断（只影响展示，不影响实际发出的内容）。 */
  systemPromptTruncated: boolean;
  toolsRegistered: number;
  toolsActive: number;
  mcpTools: number;
  skills: number;
  promptTemplates: number;
  contextFiles: number;
}

/** 会话信息快照（REST 直接返回这个结构）。 */
export interface PromptSnapshot {
  sessionId: string;
  cwd: string;
  /** 快照生成时刻（面板显示「读取于 …」）。 */
  capturedAt: string;
  model: { provider?: string; modelId?: string } | null;
  thinkingLevel?: string;
  overview: PromptSnapshotOverview;
  systemPrompt: {
    /** 组装完成的系统提示词全文（含 skills 段、工具指南、上下文文件）。 */
    text: string;
    /** 自定义系统提示词的来源文件（SDK 的 getSystemPromptSource）。 */
    source?: string;
    /** 额外追加的提示词段数（内容已并入 text）。 */
    appendedPrompts: number;
  };
  tools: PromptToolInfo[];
  skills: PromptSkillInfo[];
  promptTemplates: PromptTemplateInfo[];
  contextFiles: PromptContextFileInfo[];
  /** 资源加载诊断（坏掉的 SKILL.md、无法解析的模板等），最多 MAX_DIAGNOSTICS 条。 */
  diagnostics: string[];
}

/** SDK 侧 `getAllTools()` 的元素形状（只取展示需要的字段）。 */
export interface PiRegisteredTool {
  name?: string;
  description?: string;
  parameters?: unknown;
  promptGuidelines?: unknown;
  sourceInfo?: { path?: string; source?: string; scope?: string; origin?: string };
}

/** SDK 侧 `resourceLoader` 的形状（skills / 提示词模板 / 上下文文件）。 */
export interface PiPromptResourceLoader {
  getSkills?(): {
    skills?: Array<{
      name?: string;
      description?: string;
      filePath?: string;
      disableModelInvocation?: boolean;
      sourceInfo?: { path?: string };
    }>;
    diagnostics?: unknown[];
  };
  getPrompts?(): {
    prompts?: Array<{
      name?: string;
      description?: string;
      argumentHint?: string;
      filePath?: string;
      sourceInfo?: { path?: string };
    }>;
    diagnostics?: unknown[];
  };
  getAgentsFiles?(): { agentsFiles?: Array<{ path?: string; content?: string }> };
  getAppendSystemPrompt?(): string[];
  getSystemPromptSource?(): { path?: string } | undefined;
}

/**
 * 快照需要的只读来源（**SDK 会话对象本尊就满足**）。
 * 中文说明：`systemPrompt` 与 `resourceLoader` 在 SDK 里是 getter（不是方法），
 * 所以这里声明成可选只读属性/方法；假会话实现其中任意子集即可，缺的部分留空。
 */
export interface PromptSourceSession {
  systemPrompt?: string;
  getAllTools?(): PiRegisteredTool[];
  resourceLoader?: PiPromptResourceLoader;
  getActiveToolNames?(): string[];
}

/** 由注册表提供的上下文（它才知道工作区、当前模型与会话 id）。 */
export interface PromptSnapshotContext {
  sessionId: string;
  cwd: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  /** MCP 工具名 → server/tool（注册表注入 mcpService.resolveTool，拿不到时退回名字拆解）。 */
  resolveMcpTool?: (toolName: string) => { server: string; tool: string } | undefined;
  /** 注入时钟（测试用）。 */
  now?: () => Date;
}

/** 系统提示词展示上限（正常只有几 KB；超限截断并标记，避免极端配置撑爆响应）。 */
export const MAX_SYSTEM_PROMPT_CHARS = 200_000;
const MAX_DESCRIPTION_CHARS = 600;
const MAX_GUIDELINE_CHARS = 300;
const MAX_GUIDELINES = 10;
const MAX_ITEMS = 200;
const MAX_DIAGNOSTICS = 20;

/** 取一个字符串字段并截断（非字符串返回空串）。 */
function textOf(value: unknown, max = MAX_DESCRIPTION_CHARS): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 任何来源读取失败都降级成兜底值——面板不该因为一个坏掉的 SKILL.md 就报错。 */
function safe<T>(read: () => T, fallback: T): T {
  try {
    return read() ?? fallback;
  } catch {
    return fallback;
  }
}

/** 工具来源分类：MCP 看名字前缀，其余看 SDK 的 sourceInfo.source。 */
export function classifyToolSource(
  name: string,
  sourceInfo: PiRegisteredTool['sourceInfo'],
): ToolSourceKind {
  if (name.startsWith('mcp__')) return 'mcp';
  switch (sourceInfo?.source) {
    case 'builtin':
      return 'builtin';
    case 'sdk':
      return 'sdk';
    case 'inline':
      return 'inline';
    case 'local':
      return 'extension';
    case 'package':
      return 'package';
    default:
      // 有路径但来源不认识（例如包名）：仍按「扩展/包」展示，路径会一并给出。
      return sourceInfo?.path ? 'package' : 'other';
  }
}

/** 从 JSON Schema / TypeBox schema 里取参数名（只认 object.properties）。 */
export function toolParamsOf(parameters: unknown): PromptToolParam[] {
  if (parameters === null || typeof parameters !== 'object') return [];
  const properties = (parameters as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== 'object') return [];
  const required = new Set(
    ((parameters as { required?: unknown }).required as unknown[] | undefined)?.filter(
      (item): item is string => typeof item === 'string',
    ) ?? [],
  );
  return Object.keys(properties as Record<string, unknown>).map((name) => ({
    name,
    required: required.has(name),
  }));
}

/** 把一个 SDK 工具定义转成快照条目。 */
function toToolInfo(
  tool: PiRegisteredTool,
  activeNames: ReadonlySet<string>,
  resolveMcpTool: McpToolResolver,
): PromptToolInfo | undefined {
  const name = typeof tool.name === 'string' ? tool.name : '';
  if (name === '') return undefined;
  const source = classifyToolSource(name, tool.sourceInfo);
  const mcp = source === 'mcp' ? resolveMcpTool(name) : undefined;
  const guidelines = Array.isArray(tool.promptGuidelines)
    ? tool.promptGuidelines
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .slice(0, MAX_GUIDELINES)
        .map((item) => textOf(item, MAX_GUIDELINE_CHARS))
    : [];
  return {
    name,
    description: textOf(tool.description),
    params: toolParamsOf(tool.parameters),
    source,
    ...(tool.sourceInfo?.path === undefined ? {} : { sourcePath: tool.sourceInfo.path }),
    active: activeNames.has(name),
    ...(mcp === undefined ? {} : { mcp }),
    promptGuidelines: guidelines,
  };
}

type McpToolResolver = (toolName: string) => { server: string; tool: string } | undefined;

/** 诊断项 → 一行文案（SDK 的 diagnostic 形状不固定，这里只认 message/path）。 */
function diagnosticText(item: unknown): string | undefined {
  if (item === null || typeof item !== 'object') return undefined;
  const record = item as { message?: unknown; path?: unknown; type?: unknown };
  const message = typeof record.message === 'string' ? record.message : undefined;
  if (message === undefined) return undefined;
  const path = typeof record.path === 'string' ? `（${record.path}）` : '';
  return textOf(`${message}${path}`, MAX_GUIDELINE_CHARS);
}

/**
 * 组装快照。
 * 中文说明：全程只读、无副作用、不缓存——面板是「点开才算」，每次都取当前真实状态
 * （中途 `set_tools` 或开关计划之后，看到的就是最新的一套）。
 */
export function buildPromptSnapshot(
  session: PromptSourceSession,
  context: PromptSnapshotContext,
): PromptSnapshot {
  const loader = session.resourceLoader;
  const activeNames = new Set(
    safe(() => session.getActiveToolNames?.() ?? [], [] as string[]).filter(
      (name): name is string => typeof name === 'string',
    ),
  );
  const resolveMcpTool: McpToolResolver = (toolName) => {
    const resolved = context.resolveMcpTool?.(toolName);
    if (resolved !== undefined) return resolved;
    // 回退：按 `mcp__<server>__<tool>` 拆名字（与 mcp-tools.parseMcpToolName 同规则）。
    const parts = toolName.split('__');
    return parts.length >= 3 && parts[0] === 'mcp'
      ? { server: parts[1], tool: parts.slice(2).join('__') }
      : undefined;
  };

  const rawTools = safe(() => session.getAllTools?.() ?? [], [] as PiRegisteredTool[]);
  // 计数用**完整**列表，输出才截断：否则工具一多，面板上的数字会静默变少。
  const allTools = rawTools
    .map((tool) => toToolInfo(tool, activeNames, resolveMcpTool))
    .filter((tool): tool is PromptToolInfo => tool !== undefined);
  const tools = allTools
    // 激活的排在前面，其次按名字，方便在长列表里看「真正会发出去的那些」。
    .sort(
      (left, right) =>
        Number(right.active) - Number(left.active) || left.name.localeCompare(right.name),
    )
    .slice(0, MAX_ITEMS);

  const skillsResult = safe(() => loader?.getSkills?.(), undefined);
  const allSkills = (skillsResult?.skills ?? [])
    .map((skill) => ({
      name: textOf(skill.name, 120),
      description: textOf(skill.description),
      location: textOf(skill.filePath ?? skill.sourceInfo?.path, 400),
      disableModelInvocation: skill.disableModelInvocation === true,
    }))
    .filter((skill) => skill.name !== '');
  const skills = allSkills.slice(0, MAX_ITEMS);

  const promptsResult = safe(() => loader?.getPrompts?.(), undefined);
  const allTemplates = (promptsResult?.prompts ?? [])
    .map((template) => ({
      name: textOf(template.name, 120),
      description: textOf(template.description),
      ...(template.argumentHint === undefined
        ? {}
        : { argumentHint: textOf(template.argumentHint, 120) }),
      ...(template.filePath === undefined && template.sourceInfo?.path === undefined
        ? {}
        : { path: textOf(template.filePath ?? template.sourceInfo?.path, 400) }),
    }))
    .filter((template) => template.name !== '');
  const promptTemplates = allTemplates.slice(0, MAX_ITEMS);

  const agentsFiles = safe(() => loader?.getAgentsFiles?.()?.agentsFiles ?? [], []);
  const allContextFiles: PromptContextFileInfo[] = agentsFiles
    .map((file) => ({
      path: textOf(file.path, 400),
      chars: typeof file.content === 'string' ? file.content.length : 0,
    }))
    .filter((file) => file.path !== '');
  const contextFiles = allContextFiles.slice(0, MAX_ITEMS);

  const rawSystemPrompt = typeof session.systemPrompt === 'string' ? session.systemPrompt : '';
  const systemPromptTruncated = rawSystemPrompt.length > MAX_SYSTEM_PROMPT_CHARS;
  const systemPromptSource = safe(() => loader?.getSystemPromptSource?.()?.path, undefined);
  const appendedPrompts = safe(() => loader?.getAppendSystemPrompt?.()?.length ?? 0, 0);

  const diagnostics = [...(skillsResult?.diagnostics ?? []), ...(promptsResult?.diagnostics ?? [])]
    .map(diagnosticText)
    .filter((item): item is string => item !== undefined)
    .slice(0, MAX_DIAGNOSTICS);

  return {
    sessionId: context.sessionId,
    cwd: context.cwd,
    capturedAt: (context.now?.() ?? new Date()).toISOString(),
    model:
      context.provider === undefined && context.model === undefined
        ? null
        : {
            ...(context.provider === undefined ? {} : { provider: context.provider }),
            ...(context.model === undefined ? {} : { modelId: context.model }),
          },
    ...(context.thinkingLevel === undefined ? {} : { thinkingLevel: context.thinkingLevel }),
    overview: {
      systemPromptChars: rawSystemPrompt.length,
      systemPromptTruncated,
      toolsRegistered: allTools.length,
      toolsActive: allTools.filter((tool) => tool.active).length,
      mcpTools: allTools.filter((tool) => tool.source === 'mcp').length,
      skills: allSkills.length,
      promptTemplates: allTemplates.length,
      contextFiles: allContextFiles.length,
    },
    systemPrompt: {
      text: systemPromptTruncated
        ? `${rawSystemPrompt.slice(0, MAX_SYSTEM_PROMPT_CHARS)}…`
        : rawSystemPrompt,
      ...(systemPromptSource === undefined ? {} : { source: systemPromptSource }),
      appendedPrompts,
    },
    tools,
    skills,
    promptTemplates,
    contextFiles,
    diagnostics,
  };
}
