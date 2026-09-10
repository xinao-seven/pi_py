// 会话分支树归一化。
//
// 中文说明：Node 后端返回**扁平节点**（带 depth），因为嵌套结构的深度等于会话条目数，
// 长会话会在 JSON 序列化时爆栈（见 docs/node-session-tree-flat.md）；Python 后端是
// 只读对照实现（已冻结），仍返回嵌套节点。两种形状在 API 层统一成扁平结构，
// 组件只面对一种形状，且全程不递归（几千条消息的会话上递归同样会爆栈）。
import type {
  LegacySessionTreeNode,
  SessionEntry,
  SessionTreeNode,
  SessionTreeInput,
} from '@/types';

/** 摘要长度上限，与 Node 后端保持一致（下拉只显示一行）。 */
const SUMMARY_LIMIT = 120;

/** 把后端返回的树（扁平或嵌套）归一化成扁平节点数组。 */
export function toSessionTreeNodes(
  raw: readonly SessionTreeInput[] | undefined | null,
): SessionTreeNode[] {
  if (!raw || raw.length === 0) return [];
  if (isFlatNode(raw[0])) return raw as SessionTreeNode[];
  // 嵌套契约：显式栈先序遍历拍平（递归实现会在长会话上爆栈）。
  const flat: SessionTreeNode[] = [];
  const stack: Array<{ node: LegacySessionTreeNode; depth: number }> = [];
  for (let index = raw.length - 1; index >= 0; index -= 1) {
    stack.push({ node: raw[index] as LegacySessionTreeNode, depth: 0 });
  }
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    flat.push(project(node.entry, depth, node.label ?? null, node.labelTimestamp ?? null));
    const children = node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index]!, depth: depth + 1 });
    }
  }
  return flat;
}

function isFlatNode(value: SessionTreeInput | undefined): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { depth?: unknown }).depth === 'number';
}

function project(
  entry: SessionEntry,
  depth: number,
  label: string | null,
  labelTimestamp: string | null,
): SessionTreeNode {
  const isMessage = entry.type === 'message';
  return {
    id: entry.id,
    parentId: entry.parentId ?? null,
    depth,
    type: entry.type,
    role: isMessage ? (entry.message?.role ?? null) : null,
    text: isMessage ? summarize(entry.message?.content) : '',
    label,
    labelTimestamp,
  };
}

/** 消息正文摘要：拼接 text/thinking 块，折叠空白后截断。 */
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
