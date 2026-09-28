/**
 * tool-output-limit 的单元测试：单次工具结果写入上下文的文本预算。
 * 中文说明：SDK 的 50KB 截断太宽松（实测 read 单次带 1 万多 token 进上下文且永久驻留）。
 * 这里验证：未超限不动（undefined = 零改写）、head/tail 两个方向、UTF-8 边界、
 * 图片块保留、多块合并计量，以及扩展工厂把钩子注册到 `tool_result` 上。
 */
import { describe, expect, it } from 'vitest';

import {
  TOOL_OUTPUT_MAX_BYTES,
  buildToolOutputLimitExtension,
  limitToolResultContent,
} from '../../../src/services/agent/tool-output-limit.js';

import type { ImageContent, TextContent } from '@earendil-works/pi-ai';

const KB = 1024;

function textOf(block: TextContent | ImageContent): string {
  return block.type === 'text' ? block.text : '';
}

describe('limitToolResultContent', () => {
  it('returns undefined (untouched) when the result is within budget', () => {
    const content = [{ type: 'text', text: 'small output' }] as TextContent[];
    expect(limitToolResultContent(content, 'read')).toBeUndefined();
  });

  it('keeps the head for read and appends a marker', () => {
    const original = 'x'.repeat(30 * KB);
    const limited = limitToolResultContent([{ type: 'text', text: original }], 'read');
    expect(limited).toBeDefined();
    const out = limited![0] as TextContent;
    // 保留的是开头，且总文本量贴近预算（预算 + 说明）。
    expect(out.text.startsWith('x')).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES + 400);
    expect(out.text).toContain('输出已截断');
    expect(out.text).toContain('offset/limit');
  });

  it('keeps the tail for bash (errors live at the end)', () => {
    const original = `${'x'.repeat(30 * KB)}ALL TESTS FAILED`;
    const limited = limitToolResultContent([{ type: 'text', text: original }], 'bash');
    const out = limited![0] as TextContent;
    expect(out.text.endsWith('ALL TESTS FAILED') || out.text.includes('ALL TESTS FAILED')).toBe(
      true,
    );
    expect(out.text).toContain('保留末尾');
  });

  it('cuts on UTF-8 character boundaries (no replacement chars for CJK)', () => {
    // 预算 12288 字节：前置 1 个 ASCII 后再排汉字，切点会落在某个 3 字节汉字的中间，
    // 实现必须回退到字符起点（否则出现 U+FFFD 乱码）。
    const original = `a${'汉'.repeat(10_000)}`;
    const limited = limitToolResultContent([{ type: 'text', text: original }], 'read');
    const out = limited![0] as TextContent;
    expect(out.text).not.toContain('\uFFFD');
    expect(out.text.startsWith('a汉')).toBe(true);
    expect(out.text.length).toBeGreaterThan(0);
  });

  it('passes image blocks through and only budgets text', () => {
    const image = { type: 'image', data: 'base64data', mimeType: 'image/png' } as ImageContent;
    const limited = limitToolResultContent(
      [image, { type: 'text', text: 'y'.repeat(30 * KB) }],
      'read',
    );
    expect(limited).toBeDefined();
    expect(limited![0]).toBe(image); // 同一引用：图片原样保留
  });

  it('budgets the combined size of multiple text blocks', () => {
    const limited = limitToolResultContent(
      [
        { type: 'text', text: 'a'.repeat(8 * KB) },
        { type: 'text', text: 'b'.repeat(8 * KB) },
      ],
      'read',
    );
    expect(limited).toBeDefined();
    const total = limited!.reduce((sum, block) => sum + textOf(block).length, 0);
    // 两个块合并计量：第一块完整保留，第二块截到剩余预算；总量 ≈ 预算 + 说明。
    expect(total).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES + 400);
    expect(textOf(limited![0])).toBe('a'.repeat(8 * KB));
    expect(textOf(limited!.at(-1)!)).toContain('输出已截断');
  });

  it('still truncates oversized error results', () => {
    const limited = limitToolResultContent([{ type: 'text', text: 'e'.repeat(30 * KB) }], 'bash');
    expect(limited).toBeDefined();
  });
});

describe('buildToolOutputLimitExtension', () => {
  it('registers a tool_result handler and rewrites only oversized results', () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const pi = {
      on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
    };
    buildToolOutputLimitExtension()(pi as never);
    const handler = handlers.get('tool_result') as (event: {
      toolName: string;
      content: TextContent[];
    }) => { content: TextContent[] } | undefined;

    expect(handler).toBeDefined();
    expect(
      handler({ toolName: 'read', content: [{ type: 'text', text: 'tiny' }] }),
    ).toBeUndefined();

    const rewritten = handler({
      toolName: 'read',
      content: [{ type: 'text', text: 'z'.repeat(30 * KB) }],
    });
    expect(rewritten?.content[0]).toMatchObject({ type: 'text' });
    expect((rewritten!.content[0] as TextContent).text).toContain('输出已截断');
  });
});
