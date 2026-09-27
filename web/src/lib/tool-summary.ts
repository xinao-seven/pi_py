/**
 * 工具调用的折叠摘要（纯函数）。
 *
 * 中文说明：工具调用块折叠起来时只显示工具名，长会话里根本看不出「这一次到底在干什么」——
 * `bash` 要看命令、`read` 要看文件。这里把每个工具最有辨识度的**一个字符串参数**提出来，
 * 压成单行给 `<summary>` 用；展开后的「参数」区照旧显示完整 JSON，所以这里丢不了信息。
 *
 * 三条约定：
 * - **不认识就返回空串**（MCP 工具、未来新增工具都退回只有工具名，绝不瞎猜参数名）；
 * - 只做展示，不做语义解析（不判断命令危不危险、不解析路径）；
 * - 值不是非空字符串就当没有（数字/对象/数组一律不显示，避免出现 `[object Object]`）。
 */

/** 工具名 → 折叠时优先展示的参数名（按顺序取第一个有值的）。 */
const COLLAPSED_ARG_KEYS: Readonly<Record<string, readonly string[]>> = {
  // 执行类：命令本身是唯一身份。
  bash: ['command'],
  // 文件类：路径是唯一身份（edit 的 oldText/newText 是正文，不适合放摘要）。
  read: ['path'],
  write: ['path'],
  edit: ['path'],
  ls: ['path'],
  // 搜索类：模式是唯一身份。
  grep: ['pattern'],
  find: ['pattern'],
};

/**
 * 取工具调用的折叠摘要；拿不到就返回空串（调用方据此不渲染这一行）。
 * 中文说明：换行/连续空白压成单个空格——summary 是单行布局，多行命令（heredoc 等）
 * 不压会撑破行高；过长时的省略交给 CSS 的 `text-overflow: ellipsis`（同一份文本也用作
 * `title`，所以不在 JS 里截断，避免出现「省略号后面的内容反而拿不到」）。
 */
export function toolCallSummary(name: string | undefined, args: unknown): string {
  if (typeof name !== 'string') return '';
  const keys = COLLAPSED_ARG_KEYS[name];
  if (keys === undefined || args === null || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const oneLine = value.replace(/\s+/g, ' ').trim();
    if (oneLine !== '') return oneLine;
  }
  return '';
}
