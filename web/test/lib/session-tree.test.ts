import { describe, expect, it } from 'vitest';

import { toSessionTreeNodes } from '@/lib/session-tree';
import type { LegacySessionTreeNode, SessionTreeNode } from '@/types';

/** 造一条 length 层深的嵌套链（迭代构造，避免测试自身爆栈）。 */
function nestedChain(length: number): LegacySessionTreeNode[] {
  let child: LegacySessionTreeNode | null = null;
  for (let index = length - 1; index >= 0; index -= 1) {
    child = {
      entry: {
        type: 'message',
        id: `n${index}`,
        parentId: index === 0 ? null : `n${index - 1}`,
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: index % 2 === 0 ? 'user' : 'assistant', content: `第 ${index} 条` },
      },
      children: child === null ? [] : [child],
    };
  }
  return [child!];
}

describe('toSessionTreeNodes', () => {
  it('扁平节点原样返回（Node 后端契约）', () => {
    const flat: SessionTreeNode[] = [
      {
        id: 'a',
        parentId: null,
        depth: 0,
        type: 'message',
        role: 'user',
        text: '你好',
        label: null,
        labelTimestamp: null,
      },
    ];
    expect(toSessionTreeNodes(flat)).toBe(flat);
  });

  it('嵌套节点拍平并带出 depth（Python 后端契约）', () => {
    const [root] = nestedChain(3);
    const nodes = toSessionTreeNodes([root]);
    expect(nodes.map((node) => [node.id, node.depth])).toEqual([
      ['n0', 0],
      ['n1', 1],
      ['n2', 2],
    ]);
    expect(nodes[2]?.role).toBe('user');
    expect(nodes[2]?.text).toBe('第 2 条');
  });

  it('超长嵌套树不会爆栈（回归：GET 详情曾 RangeError）', () => {
    const [root] = nestedChain(5000);
    const nodes = toSessionTreeNodes([root]);
    expect(nodes).toHaveLength(5000);
    expect(nodes.at(-1)?.depth).toBe(4999);
    expect(() => JSON.stringify(nodes)).not.toThrow();
  });

  it('空输入返回空数组', () => {
    expect(toSessionTreeNodes(undefined)).toEqual([]);
    expect(toSessionTreeNodes([])).toEqual([]);
  });
});
