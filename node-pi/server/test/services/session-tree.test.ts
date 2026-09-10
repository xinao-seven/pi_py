import { describe, expect, it } from 'vitest';

import { flattenSessionTree } from '../../src/services/session-tree.js';

/** 造一条 length 层深的嵌套会话树（迭代构造，避免测试自身爆栈）。 */
function deepChain(length: number): unknown[] {
  let child: Record<string, unknown> | null = null;
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

describe('flattenSessionTree', () => {
  it('把超长会话树拍平，不再撑爆 JSON 序列化（回归：GET /api/sessions/:id 曾 RangeError）', () => {
    const flat = flattenSessionTree(deepChain(5000));
    expect(flat).toHaveLength(5000);
    expect(flat[0]).toMatchObject({ id: 'n0', depth: 0, parentId: null });
    expect(flat.at(-1)).toMatchObject({ id: 'n4999', depth: 4999, parentId: 'n4998' });
    // 嵌套结构在这里会抛 RangeError: Maximum call stack size exceeded
    expect(() => JSON.stringify(flat)).not.toThrow();
  });

  it('保持先序顺序与深度（分支场景）', () => {
    // root → (a → a1) 与 b 两个分支；getTree() 已按时间排好兄弟顺序
    const tree = [
      {
        entry: {
          type: 'message',
          id: 'root',
          parentId: null,
          message: { role: 'user', content: '根' },
        },
        children: [
          {
            entry: {
              type: 'message',
              id: 'a',
              parentId: 'root',
              message: { role: 'assistant', content: 'A' },
            },
            children: [
              {
                entry: {
                  type: 'message',
                  id: 'a1',
                  parentId: 'a',
                  message: { role: 'user', content: 'A1' },
                },
                children: [],
              },
            ],
          },
          {
            entry: {
              type: 'message',
              id: 'b',
              parentId: 'root',
              message: { role: 'user', content: 'B' },
            },
            children: [],
          },
        ],
      },
    ];
    expect(flattenSessionTree(tree).map((node) => [node.id, node.depth])).toEqual([
      ['root', 0],
      ['a', 1],
      ['a1', 2],
      ['b', 1],
    ]);
  });

  it('摘要折叠空白并截断到 120 字符，非消息条目没有 role/text', () => {
    const [node, compaction] = flattenSessionTree([
      {
        entry: {
          type: 'message',
          id: 'm1',
          parentId: null,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `${'a\n\n b '.repeat(50)}尾` }],
          },
        },
        children: [],
      },
      {
        entry: { type: 'compaction', id: 'c1', parentId: null },
        children: [],
        label: '压缩点',
        labelTimestamp: '2026-01-01T00:00:02Z',
      },
    ]);
    expect(node!.text).toHaveLength(120);
    expect(node!.text).not.toContain('\n');
    expect(node!.role).toBe('assistant');
    expect(compaction).toMatchObject({
      type: 'compaction',
      role: null,
      text: '',
      label: '压缩点',
      labelTimestamp: '2026-01-01T00:00:02Z',
    });
  });

  it('缺 entry 的坏节点被跳过，但其 children 仍然保留', () => {
    const flat = flattenSessionTree([
      {
        children: [
          {
            entry: {
              type: 'message',
              id: 'ok',
              parentId: null,
              message: { role: 'user', content: 'x' },
            },
            children: [],
          },
        ],
      },
    ]);
    expect(flat.map((node) => node.id)).toEqual(['ok']);
  });
});
