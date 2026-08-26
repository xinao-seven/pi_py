/**
 * MCP 工具的纯辅助函数：命名序列化/解析、JSON Schema → TypeBox、结果映射、环境变量插值。
 *
 * 中文说明：这些函数不持有任何状态、不依赖 MCP 连接，便于单元测试。
 * MCP 工具的 Pi 工具名为 `mcp__<server>__<tool>`，前缀 `mcp__` 避开内置工具
 * （read/bash/edit/write），server 与 tool 名做清洗防止非法字符/歧义。
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type AgentToolResult,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { CallToolResult, Tool as MCPTool } from '@modelcontextprotocol/sdk/types.js';
import { Type, type TSchema } from 'typebox';

import type { McpServerConfig } from './mcp-config.js';

/** MCP 工具整体输出上限：行数与字节数，任一先到即截断（对齐 Pi 默认 2000 行 / 50KB）。 */
const MAX_OUTPUT_LINES = DEFAULT_MAX_LINES;
const MAX_OUTPUT_BYTES = DEFAULT_MAX_BYTES;

/** 环境变量插值：`$VAR` → process.env[VAR]，未定义时原样保留。 */
export function interpolateEnv(value: string): string {
  return value.replace(/\$(\w+)/g, (match, name: string) => process.env[name] ?? match);
}

/** 对整个 map 做环境变量插值（stdio env / http headers）。 */
export function interpolateEnvMap(
  map: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) out[key] = interpolateEnv(value);
  return out;
}

/** 配置指纹：配置对象变了就重连（sync 时用于跳过未变化的连接）。 */
export function fingerprintOf(config: McpServerConfig): string {
  return JSON.stringify(config);
}

/** 名称清洗：非单词字符统一转 `_`、连续下划线折叠、去掉首尾下划线。 */
function sanitizeName(value: string): string {
  return value
    .replace(/[^\w]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** 序列化 Pi 工具名：mcp__<server>__<tool>。 */
export function serializeMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeName(serverName)}__${sanitizeName(toolName)}`;
}

/**
 * 从 Pi 工具名解析 server/tool（尽力而为）。
 * 注意：清洗是 lossy 的，工具名可能无法精确还原，因此权威映射以 McpService
 * 维护的 toolIndex 为准，此解析只作回退。
 */
export function parseMcpToolName(fullName: string): { server: string; tool: string } | undefined {
  const parts = fullName.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') return undefined;
  return { server: parts[1], tool: parts.slice(2).join('__') };
}

/**
 * MCP input_schema（JSON Schema）→ TypeBox TSchema。
 * 覆盖常见子集：object/string/number/integer/boolean/array/null；未知结构
 * （oneOf/anyOf/allOf 等）回退 `Type.Unsafe` 宽松放行，避免误拒 MCP 调用。
 */
export function jsonSchemaToTypeBox(schema: Record<string, unknown> | undefined): TSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    return Type.Unsafe<unknown>({});
  const type = schema.type;
  switch (type) {
    case 'object':
      return objectToTypeBox(schema);
    case 'string': {
      const enums = Array.isArray(schema.enum)
        ? schema.enum.filter((v) => typeof v === 'string')
        : [];
      return enums.length ? Type.Union(enums.map((value) => Type.Literal(value))) : Type.String();
    }
    case 'number':
      return Type.Number();
    case 'integer':
      return Type.Integer();
    case 'boolean':
      return Type.Boolean();
    case 'array': {
      const items = schema.items;
      return Type.Array(
        items && typeof items === 'object'
          ? jsonSchemaToTypeBox(items as Record<string, unknown>)
          : Type.Unknown(),
      );
    }
    case 'null':
      return Type.Null();
    default:
      return Type.Unsafe<unknown>({ ...schema });
  }
}

function objectToTypeBox(schema: Record<string, unknown>): TSchema {
  const rawProperties =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name) => typeof name === 'string')
      : [],
  );
  const props: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(rawProperties)) {
    const sub = jsonSchemaToTypeBox(value);
    props[key] = required.has(key) ? sub : Type.Optional(sub);
  }
  return Type.Object(props, {
    additionalProperties: schema.additionalProperties !== false,
  });
}

/**
 * MCP callTool 结果 → Pi AgentToolResult。
 * - 失败（isError）按 Pi 的惯例抛 Error（与 bash 工具一致），由 agent-core 标记为错误结果；
 * - 文本输出用 truncateTail 截断（2000 行 / 50KB），防止超长结果撑爆上下文，并在末尾附截断说明。
 */
export function mcpResultToPi(result: CallToolResult): AgentToolResult<unknown> {
  const content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  > = [];
  const textParts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text') textParts.push(block.text);
    else if (block.type === 'image')
      content.push({
        type: 'image',
        data: block.data,
        mimeType: block.mimeType,
      });
    else if (block.type === 'resource') textParts.push(JSON.stringify(block.resource));
  }
  if (result.isError === true) {
    const message =
      textParts.join('\n').trim() ||
      (result.structuredContent !== undefined
        ? JSON.stringify(result.structuredContent)
        : 'MCP tool returned an error');
    throw new Error(message);
  }
  let text = textParts.join('\n');
  if (!text && result.structuredContent !== undefined)
    text = JSON.stringify(result.structuredContent);
  const truncated = truncateText(text);
  content.unshift({
    type: 'text',
    text: truncated.text + (truncated.marker ?? ''),
  });
  return { content, details: {} };
}

/** 对整体文本输出做行数/字节数截断，截断时附说明标记（对齐 bash 的 [Truncated: ...] 文案）。 */
function truncateText(text: string): { text: string; marker?: string } {
  const result = truncateTail(text, {
    maxLines: MAX_OUTPUT_LINES,
    maxBytes: MAX_OUTPUT_BYTES,
  });
  if (!result.truncated) return { text };
  const detail =
    result.truncatedBy === 'lines'
      ? `showing ${result.outputLines} of ${result.totalLines} lines`
      : `${result.outputLines} lines shown (${formatSize(result.maxBytes)} limit)`;
  return { text: result.content, marker: `\n[Truncated: ${detail}]` };
}

/** 由单个 MCP 工具构造 Pi 的 ToolDefinition；execute 委托给调用方提供的 callTool。 */
export function buildMcpToolDefinition(options: {
  name: string;
  serverName: string;
  toolName: string;
  tool: MCPTool;
  callTool: (
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<unknown>>;
}): ToolDefinition {
  return {
    name: options.name,
    label: `${options.toolName} (${options.serverName})`,
    // 追加截断说明，让模型知道超长输出会被截断。
    description: `${options.tool.description ?? `MCP tool ${options.serverName}:${options.toolName}`} Output is truncated to the last ${MAX_OUTPUT_LINES} lines or ${Math.round(MAX_OUTPUT_BYTES / 1024)}KB.`,
    // 一行 snippet：让工具出现在系统提示词的 "Available tools" 区。
    // 自定义工具若不设 promptSnippet 不会枚举在提示词里（虽仍以 API tool definitions 传给模型），
    // 加了它对模型发现工具和人肉排查都有帮助。
    promptSnippet: snippetOf(options.tool.description, options.serverName, options.toolName),
    parameters: jsonSchemaToTypeBox(options.tool.inputSchema as unknown as Record<string, unknown>),
    async execute(_toolCallId, params, signal) {
      return options.callTool((params ?? {}) as Record<string, unknown>, signal ?? undefined);
    },
  };
}

/** 从 MCP 工具描述取第一行作为 promptSnippet，并标注来源 server。 */
function snippetOf(description: string | undefined, serverName: string, toolName: string): string {
  const line = (description ?? toolName).split(/\r?\n/)[0].trim();
  const head = line.length > 80 ? `${line.slice(0, 77)}…` : line;
  return head ? `${head} (MCP server: ${serverName})` : toolName;
}
