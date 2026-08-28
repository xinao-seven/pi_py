// parseSseFrame 纯函数单测：SSE 帧解析是 fetch+ReadableStream 手写解析的核心。
import { describe, expect, it } from 'vitest';

import { parseSseFrame } from '@/composables/useAgentSession';

describe('parseSseFrame', () => {
  it('parses id and data from a frame', () => {
    expect(parseSseFrame('id: 3\ndata: {"type":"agent_start"}')).toEqual({
      id: 3,
      data: '{"type":"agent_start"}',
    });
  });

  it('joins multi-line data blocks', () => {
    expect(parseSseFrame('data: {"line":1}\ndata: {"line":2}')).toEqual({
      data: '{"line":1}\n{"line":2}',
    });
  });

  it('ignores heartbeat comment frames', () => {
    expect(parseSseFrame(': heartbeat')).toEqual({});
  });

  it('tolerates CRLF line endings', () => {
    expect(parseSseFrame('id: 5\r\ndata: {"a":1}')).toEqual({ id: 5, data: '{"a":1}' });
  });

  it('drops non-numeric ids', () => {
    expect(parseSseFrame('id: abc\ndata: x')).toEqual({ data: 'x' });
  });

  it('returns empty frame when no data line present', () => {
    expect(parseSseFrame('event: foo')).toEqual({});
  });
});
