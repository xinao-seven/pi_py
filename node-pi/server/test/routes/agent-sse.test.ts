import { describe, expect, it } from 'vitest';

import { createSseWriter, MAX_SSE_PENDING_BYTES, type SseSink } from '../../src/routes/agent.js';
import type { StreamEvent } from '../../src/services/agent-registry.js';

/** 假 sink：把写出的帧记下来，并模拟 Node Writable 的 writableLength。 */
function makeSink(writableLength = 0): SseSink & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    writableLength,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };
}

function event(id: number): StreamEvent {
  return { id, payload: { type: 'agent_end', error: '' } };
}

/**
 * SSE 写缓冲上限：`reply.raw.write()` 不看返回值，客户端卡住时数据会积在服务端内存里
 * （现场见过常驻 1.2GB 的 server 进程）。超限必须立刻停写并让调用方断开连接。
 */
describe('createSseWriter', () => {
  it('writes id/data frames while the pending buffer is under the cap', () => {
    const sink = makeSink();
    const writer = createSseWriter(sink);

    writer.push(event(7));

    expect(sink.writes).toEqual([`id: 7\ndata: ${JSON.stringify(event(7).payload)}\n\n`]);
    expect(writer.dropped).toBe(false);
  });

  it('stops writing as soon as the pending buffer exceeds the cap', () => {
    const sink = makeSink(MAX_SSE_PENDING_BYTES + 1);
    const writer = createSseWriter(sink);

    writer.push(event(1));
    writer.push(event(2));

    expect(sink.writes).toEqual([]);
    expect(writer.dropped).toBe(true);
  });

  it('still writes when the pending buffer is exactly at the cap', () => {
    const sink = makeSink(MAX_SSE_PENDING_BYTES);
    const writer = createSseWriter(sink);

    writer.push(event(1));

    expect(sink.writes).toHaveLength(1);
    expect(writer.dropped).toBe(false);
  });
});
