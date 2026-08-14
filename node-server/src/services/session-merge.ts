/**
 * 会话合并（Merge）摘要生成。
 *
 * 中文说明：把"源会话"中"目标会话还没有的条目"整理成一份有界、可审计的
 * 文本摘要，追加进目标会话。这样模型可以"看到"另一个分支的关键内容，
 * 又不会把两个会话的完整历史直接拼接导致上下文爆炸。
 *
 * 边界控制：
 * - 最多展开 MAX_ITEMS 条（30 条），更多条目只统计数量不展开；
 * - 每条内容截断到 MAX_ITEM_CHARS（700 字符）；
 * - 整个摘要截断到 MAX_SUMMARY_CHARS（16000 字符）。
 */

const MAX_ITEMS = 30;
const MAX_ITEM_CHARS = 700;
const MAX_SUMMARY_CHARS = 16_000;

/** 会话条目（SessionManager.getEntries() 返回的原始对象，字段都不确定，宽松定义）。 */
interface Entry {
  id?: unknown;
  type?: unknown;      // "message" | "custom_message" | "compaction" | "branch_summary" ...
  message?: unknown;   // type === "message" 时的消息对象
  content?: unknown;   // type === "custom_message" 时的内容
  summary?: unknown;   // type === "compaction" / "branch_summary" 时的摘要文本
}

/**
 * 可合并会话的门面接口：路由层通过它读取源/目标会话的条目，
 * 并把生成的摘要作为 custom_message 追加进目标会话。
 */
export interface MergeableSessionManager {
  getEntries(): Entry[];
  getSessionName(): string | undefined;
  appendCustomMessageEntry(type: string, content: string, display: boolean, details?: unknown): string;
}

/** 合并摘要的产物：正文 + 统计信息。 */
export interface MergeSummary {
  content: string;
  sourceUniqueEntryCount: number; // 源会话里"目标会话没有"的条目总数
  summarizedItemCount: number;    // 实际被展开进摘要的条数
}

/**
 * 生成合并摘要。
 * @param source 源会话（要被读取内容的会话）
 * @param target 目标会话（摘要会追加到它）
 * @param sourceId 源会话 id（用作标签兜底）
 * @returns 无内容可合并时返回 undefined
 */
export function createMergeSummary(source: MergeableSessionManager, target: MergeableSessionManager, sourceId: string): MergeSummary | undefined {
  // 目标会话已有的条目 id 集合：用于判定"哪些源条目是目标没有的"。
  const targetIds = new Set(target.getEntries().map((entry) => entry.id).filter((id): id is string => typeof id === "string"));
  // 只取"源有目标无"的条目，且必须是带 id 的（无 id 的条目无法去重，跳过）。
  const unique = source.getEntries().filter((entry) => typeof entry.id === "string" && !targetIds.has(entry.id));
  // 把可描述的条目转成文本，最多取 MAX_ITEMS 条。
  const items = unique.map(describe).filter((item): item is string => item !== undefined).slice(0, MAX_ITEMS);
  if (items.length === 0) return undefined; // 没有任何可合并内容
  const omitted = unique.length - items.length; // 超出上限未展开的条数
  // 摘要标题：优先用源会话名，其次第一条用户消息，最后用会话 id。
  const label = source.getSessionName() || firstUserText(source.getEntries()) || sourceId;
  const lines = [
    "[Merged session summary]",
    "",
    `Source session: ${label}`,
    `Merged at: ${new Date().toISOString()}`,
    "",
    "The following is an auditable, bounded summary imported from another session:",
    "",
    ...items.map((item, index) => `${index + 1}. ${item}`),
    ...(omitted > 0 ? ["", `${omitted} additional source entries were not expanded.`] : []),
  ];
  return { content: truncate(lines.join("\n"), MAX_SUMMARY_CHARS, false), sourceUniqueEntryCount: unique.length, summarizedItemCount: items.length };
}

/**
 * 把摘要作为一条 custom_message 追加进目标会话，并返回新条目的 id。
 * 中文说明：details 里带上来源会话 id 与统计信息，前端可以展示"从哪里合并了什么"。
 */
export function appendMergeSummary(target: MergeableSessionManager, sourceId: string, summary: MergeSummary): string {
  return target.appendCustomMessageEntry("session_merge_summary", summary.content, true, {
    sourceSessionId: sourceId,
    sourceUniqueEntryCount: summary.sourceUniqueEntryCount,
    summarizedItemCount: summary.summarizedItemCount,
  });
}

/**
 * 把一条会话条目描述成一行可读文本；无法描述的（工具结果、空内容等）返回 undefined。
 */
function describe(entry: Entry): string | undefined {
  if (entry.type === "message" && object(entry.message)) {
    const role = entry.message.role;
    if (role === "toolResult") return undefined; // 工具执行结果噪音大，不并入摘要
    const text = contentText(entry.message.content);
    if (role === "user" && text) return `User: ${truncate(text, MAX_ITEM_CHARS)}`;
    if (role === "assistant" && text) return `Assistant: ${truncate(text, MAX_ITEM_CHARS)}`;
    // 助手消息里只有工具调用（无文本）时，描述成"调用过哪些工具"。
    if (role === "assistant" && Array.isArray(entry.message.content)) {
      const tools = entry.message.content
        .filter(object)
        .filter((block) => block.type === "toolCall" && typeof block.name === "string")
        .map((block) => block.name);
      return tools.length ? `Assistant tool calls: ${[...new Set(tools)].sort().join(", ")}` : undefined;
    }
    return undefined;
  }
  if (entry.type === "custom_message") {
    const text = contentText(entry.content);
    return text ? `Custom message: ${truncate(text, MAX_ITEM_CHARS)}` : undefined;
  }
  // 压缩/分支摘要条目：直接引用其自带的摘要文本。
  if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string") {
    return `${entry.type === "compaction" ? "Compaction" : "Branch"} summary: ${truncate(entry.summary, MAX_ITEM_CHARS)}`;
  }
  return undefined;
}

/** 取会话的第一条用户文本（用于给无名称的源会话起标签）。 */
function firstUserText(entries: Entry[]): string | undefined {
  for (const entry of entries) {
    if (entry.type === "message" && object(entry.message) && entry.message.role === "user") {
      const text = contentText(entry.message.content);
      if (text) return truncate(text, 80);
    }
  }
  return undefined;
}

/** 从消息 content（可能是字符串或内容块数组）里提取纯文本。 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(object)
    .filter((block): block is Record<string, string> => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

/** 类型守卫：非 null 的普通对象。 */
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** 截断工具：默认把连续空白压缩成单个空格（normalize），超限加省略号。 */
function truncate(value: string, limit: number, normalize = true): string {
  const text = normalize ? value.replace(/\s+/g, " ").trim() : value.trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 3).trimEnd()}...`;
}
