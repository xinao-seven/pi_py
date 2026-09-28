/**
 * Session branch tree flattening.
 *
 * 中文说明：会话树是「一条消息一个节点」的链表结构——一条 2400 条目的会话，
 * 嵌套深度就是 2400 层。Fastify 用 `JSON.stringify` 序列化响应，而它是递归的：
 * 实测深度超过约 2300 层就抛 `RangeError: Maximum call stack size exceeded`
 * （即 GET /api/sessions/:id 在长会话上必报 500，见 docs/node-session-tree-flat.md）。
 *
 * 因此详情接口不再返回嵌套的 `children`，而是返回**扁平节点 + depth**：
 * - 序列化深度从 O(条目数) 降到常数级，长会话不再爆栈；
 * - 顺手丢掉重复的正文（树里只需要一行标签，正文在 context.messages 里），
 *   长会话的详情响应体因此小一个量级。
 * 前端按 depth 缩进渲染，分支信息（父子关系、兄弟顺序）完全保留。
 */

/** 节点摘要的最大长度：分支下拉只显示一行标签（前端还会再截到 72 字符）。 */
const SUMMARY_LIMIT = 120;

/** 扁平化后的分支树节点（GET /api/sessions/:id 的 tree 元素）。 */
export interface FlatSessionTreeNode {
  id: string;
  parentId: string | null;
  /** 在树中的层级（根为 0），由服务端算好，前端不再递归推导。 */
  depth: number;
  type: string;
  /** 仅 message 条目有角色（user/assistant/toolResult...）。 */
  role: string | null;
  /** message 条目的正文摘要（已折叠空白并截断），其他条目为空串。 */
  text: string;
  /** 用户标记（label 条目解析结果）。 */
  label: string | null;
  labelTimestamp: string | null;
}

/** SDK 嵌套节点的最小结构（只取本服务用到的字段，避免依赖 SDK 内部类型）。 */
interface RawTreeNode {
  entry?: {
    id?: unknown;
    parentId?: unknown;
    type?: unknown;
    message?: { role?: unknown; content?: unknown };
  };
  children?: unknown;
  label?: unknown;
  labelTimestamp?: unknown;
}

/**
 * Flatten a nested session tree into pre-order nodes carrying their depth.
 *
 * 中文说明：用显式栈做先序遍历（`children` 逆序入栈），出栈顺序与递归实现完全一致：
 * 父节点先于子节点、兄弟保持 `getTree()` 的时间升序。全程不递归，深树安全。
 */
export function flattenSessionTree(roots: readonly unknown[]): FlatSessionTreeNode[] {
  const flat: FlatSessionTreeNode[] = [];
  const stack: Array<{ node: RawTreeNode; depth: number }> = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    stack.push({ node: asNode(roots[index]), depth: 0 });
  }
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (isEntryNode(node)) flat.push(project(node, depth));
    // 即使节点本身无效（缺 entry）也继续遍历它的 children，避免整棵子树丢失。
    const children = Array.isArray(node.children) ? node.children : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: asNode(children[index]), depth: depth + 1 });
    }
  }
  return flat;
}

function asNode(value: unknown): RawTreeNode {
  return typeof value === 'object' && value !== null ? (value as RawTreeNode) : {};
}

function isEntryNode(node: RawTreeNode): boolean {
  return typeof node.entry?.id === 'string';
}

function project(node: RawTreeNode, depth: number): FlatSessionTreeNode {
  const entry = node.entry!;
  const type = typeof entry.type === 'string' ? entry.type : 'unknown';
  const isMessage = type === 'message';
  return {
    id: entry.id as string,
    parentId: typeof entry.parentId === 'string' ? entry.parentId : null,
    depth,
    type,
    role: isMessage && typeof entry.message?.role === 'string' ? entry.message.role : null,
    text: isMessage ? summarize(entry.message?.content) : '',
    label: typeof node.label === 'string' ? node.label : null,
    labelTimestamp: typeof node.labelTimestamp === 'string' ? node.labelTimestamp : null,
  };
}

/** 消息摘要：拼接 text/thinking 块（与前端原有的 label 规则一致），折叠空白后截断。 */
function summarize(content: unknown): string {
  const text = typeof content === 'string' ? content : blocksText(content);
  return text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_LIMIT);
}

function blocksText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const record = block as { text?: unknown; thinking?: unknown };
      const value = record.text ?? record.thinking;
      return typeof value === 'string' ? value : '';
    })
    .filter(Boolean)
    .join(' ');
}
