/**
 * 工具结果体积上限：把单次工具调用写进上下文的文本量收紧到平台预算内。
 *
 * 中文说明：SDK 内置工具的截断上限是 2000 行 / 50KB（模块级常量，不可配置），实测
 * read 单次可带 1 万多 token 进上下文并**永久留在会话里**——每一轮的缓存重读都跟着
 * 变大。SDK 的 `tool_result` 扩展钩子允许改写工具结果（`agent.afterToolCall` 的返回值
 * 会替换真正进上下文与 JSONL 的内容），本模块用它做一个平台级预算：
 *
 * - 只收文本块（text），图片块原样保留（截图会破坏视觉任务）；
 * - 预算按 **全部文本块的字节总和** 计（多块结果合并计算）；
 * - `bash` 保留**末尾**（报错/测试摘要通常在尾部，与 SDK 的 tail 截断方向一致），
 *   其余工具保留**开头**（与 read 的 head + offset 分页语义一致）；
 * - 截断时追加一条说明，告诉模型用更精确的参数（offset/limit、grep、head/tail）重取；
 * - 切块按字节测量并对齐 UTF-8 字符边界（不产生半个字符的乱码）。
 *
 * 这是平台策略而非预设能力：**全能力关闭的「极简」会话不注册本扩展**（保持原版行为，
 * 接线见 agent-registry 的 loader），其余会话一律生效（含 MCP / 计划 / 子会话工具）。
 */

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';

/** 单次工具结果允许写入上下文的文本预算（字节）。 */
export const TOOL_OUTPUT_MAX_BYTES = 12 * 1024;

/** 文本内容块的形状（与 SDK 的 TextContent 结构一致，便于测试里手工构造）。 */
type TextBlock = { type: 'text'; text: string };

/** 截断方向：head = 保留开头（read/grep 等），tail = 保留末尾（bash）。 */
type KeepSide = 'head' | 'tail';

/** bash 的输出以尾部为准（报错与测试摘要通常在最后）。 */
const TAIL_KEEPING_TOOLS = new Set(['bash']);

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

/** 保留开头 maxBytes 字节，末尾对齐到完整字符。 */
function sliceUtf8Head(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  // 末字节落在多字节序列的续字节上（0b10xxxxxx）时回退到字符起点。
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf-8');
}

/** 保留末尾 maxBytes 字节，起点对齐到完整字符。 */
function sliceUtf8Tail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  // 起点落在续字节上时前移到字符起点（最多 3 字节，UTF-8 最长 4 字节）。
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf-8');
}

/** 把字节换算成给模型看的可读大小（与 SDK 的 formatSize 同风格）。 */
function formatBytes(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

/**
 * 对一组内容块施加文本预算。
 * 中文说明：未超限返回 undefined（调用方原样放行，不触发结果改写）；超限返回新的
 * 内容块数组——图片块原样保留，文本块按 keep 方向截到预算内并追加截断说明。
 */
export function limitToolResultContent(
  content: readonly (TextContent | ImageContent)[],
  toolName: string,
  maxBytes: number = TOOL_OUTPUT_MAX_BYTES,
): (TextContent | ImageContent)[] | undefined {
  const total = content.reduce(
    (sum, block) => (block.type === 'text' ? sum + byteLength(block.text) : sum),
    0,
  );
  if (total <= maxBytes) return undefined;
  const keep: KeepSide = TAIL_KEEPING_TOOLS.has(toolName) ? 'tail' : 'head';
  const blocks: (TextContent | ImageContent)[] = [];
  let remaining = maxBytes;
  for (const block of content) {
    if (block.type !== 'text') {
      blocks.push(block);
      continue;
    }
    const size = byteLength(block.text);
    if (size <= remaining) {
      blocks.push(block);
      remaining -= size;
      continue;
    }
    const kept =
      keep === 'head' ? sliceUtf8Head(block.text, remaining) : sliceUtf8Tail(block.text, remaining);
    if (kept !== '') blocks.push({ type: 'text', text: kept });
    remaining = 0;
  }
  const marker =
    keep === 'head'
      ? `\n\n[输出已截断：保留前 ${formatBytes(maxBytes)} / 共 ${formatBytes(total)}。` +
        '需要其余部分请用更精确的参数分次获取（read 用 offset/limit，命令输出用 grep / head / tail）。]'
      : `\n\n[输出已截断：保留末尾 ${formatBytes(maxBytes)} / 共 ${formatBytes(total)}，前半部分省略。` +
        '需要开头部分请缩小命令输出范围（head、重定向到文件后分段读）。]';
  // 说明追加到最后一个文本块上（从后往前找，避免依赖 ES2023 的 findLastIndex）。
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index] as TextBlock;
    if (block.type === 'text') {
      blocks[index] = { type: 'text', text: block.text + marker };
      return blocks;
    }
  }
  return undefined;
}

/**
 * 构建工具结果预算扩展。
 * 中文说明：注册在 `tool_result` 钩子上，SDK 在工具执行完、结果进上下文之前调用；
 * 未超限时返回 undefined，SDK 视为「未修改」，零开销放行。
 */
export function buildToolOutputLimitExtension(
  maxBytes: number = TOOL_OUTPUT_MAX_BYTES,
): InlineExtension {
  return (pi) => {
    pi.on('tool_result', (event) => {
      const content = limitToolResultContent(event.content, event.toolName, maxBytes);
      return content === undefined ? undefined : { content };
    });
  };
}
