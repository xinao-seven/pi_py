const MAX_ITEMS = 30;
const MAX_ITEM_CHARS = 700;
const MAX_SUMMARY_CHARS = 16_000;

interface Entry {
  id?: unknown;
  type?: unknown;
  message?: unknown;
  content?: unknown;
  summary?: unknown;
}

export interface MergeableSessionManager {
  getEntries(): Entry[];
  getSessionName(): string | undefined;
  appendCustomMessageEntry(type: string, content: string, display: boolean, details?: unknown): string;
}

export interface MergeSummary {
  content: string;
  sourceUniqueEntryCount: number;
  summarizedItemCount: number;
}

export function createMergeSummary(source: MergeableSessionManager, target: MergeableSessionManager, sourceId: string): MergeSummary | undefined {
  const targetIds = new Set(target.getEntries().map((entry) => entry.id).filter((id): id is string => typeof id === "string"));
  const unique = source.getEntries().filter((entry) => typeof entry.id === "string" && !targetIds.has(entry.id));
  const items = unique.map(describe).filter((item): item is string => item !== undefined).slice(0, MAX_ITEMS);
  if (items.length === 0) return undefined;
  const omitted = unique.length - items.length;
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

export function appendMergeSummary(target: MergeableSessionManager, sourceId: string, summary: MergeSummary): string {
  return target.appendCustomMessageEntry("session_merge_summary", summary.content, true, {
    sourceSessionId: sourceId,
    sourceUniqueEntryCount: summary.sourceUniqueEntryCount,
    summarizedItemCount: summary.summarizedItemCount,
  });
}

function describe(entry: Entry): string | undefined {
  if (entry.type === "message" && object(entry.message)) {
    const role = entry.message.role;
    if (role === "toolResult") return undefined;
    const text = contentText(entry.message.content);
    if (role === "user" && text) return `User: ${truncate(text, MAX_ITEM_CHARS)}`;
    if (role === "assistant" && text) return `Assistant: ${truncate(text, MAX_ITEM_CHARS)}`;
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
  if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string") {
    return `${entry.type === "compaction" ? "Compaction" : "Branch"} summary: ${truncate(entry.summary, MAX_ITEM_CHARS)}`;
  }
  return undefined;
}

function firstUserText(entries: Entry[]): string | undefined {
  for (const entry of entries) {
    if (entry.type === "message" && object(entry.message) && entry.message.role === "user") {
      const text = contentText(entry.message.content);
      if (text) return truncate(text, 80);
    }
  }
  return undefined;
}

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

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function truncate(value: string, limit: number, normalize = true): string {
  const text = normalize ? value.replace(/\s+/g, " ").trim() : value.trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 3).trimEnd()}...`;
}
