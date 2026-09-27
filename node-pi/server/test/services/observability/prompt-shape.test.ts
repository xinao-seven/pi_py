import { describe, expect, it } from 'vitest';

import {
  collectInjections,
  promptShapeOf,
} from '../../../src/services/observability/prompt-shape.js';

describe('promptShapeOf', () => {
  it('extracts message count, sorted tool names and the system digest', () => {
    const shape = promptShapeOf({
      messages: [{ role: 'user' }, { role: 'assistant' }],
      tools: [{ name: 'write' }, { name: 'bash' }, 'read'],
      system: 'you are pi',
    });

    expect(shape).toMatchObject({
      messages: 2,
      tools: ['bash', 'read', 'write'],
      toolsFingerprint: 'bash|read|write',
      systemChars: 10,
    });
    expect(shape?.systemDigest).toHaveLength(12);
  });

  it('reads OpenAI-style `function` wrappers and de-duplicates tool names', () => {
    const shape = promptShapeOf({
      messages: [],
      tools: [{ function: { name: 'grep' } }, { name: 'grep' }],
    });

    expect(shape?.tools).toEqual(['grep']);
  });

  it('is stable for identical payloads and changes when the tool set changes', () => {
    const first = promptShapeOf({ messages: [{}], tools: [{ name: 'read' }], system: 's' });
    const same = promptShapeOf({ messages: [{}, {}], tools: [{ name: 'read' }], system: 's' });
    const changed = promptShapeOf({ messages: [{}], tools: [{ name: 'read' }, { name: 'edit' }] });

    // 消息条数变化不算「形状变化」（每轮都会涨），工具集与系统提示词才算。
    expect(same?.toolsFingerprint).toBe(first?.toolsFingerprint);
    expect(same?.systemDigest).toBe(first?.systemDigest);
    expect(changed?.toolsFingerprint).not.toBe(first?.toolsFingerprint);
  });

  it('returns undefined for unrecognized payloads instead of throwing', () => {
    expect(promptShapeOf(undefined)).toBeUndefined();
    expect(promptShapeOf('nope')).toBeUndefined();
    expect(promptShapeOf({ tools: [] })).toBeUndefined();
    expect(promptShapeOf({ messages: 'nope' })).toBeUndefined();
  });

  it('handles a payload without tools or system text', () => {
    expect(promptShapeOf({ messages: [] })).toEqual({
      messages: 0,
      tools: [],
      toolsFingerprint: '',
      systemChars: 0,
    });
  });
});

describe('collectInjections', () => {
  it('picks the last occurrence of each customType (SDK keeps only the last one)', () => {
    const injections = collectInjections([
      { role: 'user', content: 'hi' },
      { customType: 'web-plan-context', content: 'old plan' },
      { customType: 'task-resume', content: 'resume' },
      { customType: 'web-plan-context', content: 'new plan' },
    ]);

    // 顺序按「生效位置」（最后一次出现的位置）：plan 的最新一条在最后，所以排在后面。
    expect(injections.map((item) => item.customType)).toEqual(['task-resume', 'web-plan-context']);
    expect(injections[1].chars).toBe('new plan'.length);
    expect(injections[0].digest).toHaveLength(12);
    expect(injections[0].digest).not.toBe(injections[1].digest);
  });

  it('keeps digests stable so unchanged injections can be de-bounced', () => {
    const one = collectInjections([{ customType: 'task-resume', content: 'same' }]);
    const two = collectInjections([
      { role: 'user', content: 'x' },
      { customType: 'task-resume', content: 'same' },
    ]);

    expect(one[0].digest).toBe(two[0].digest);
  });

  it('redacts secret-shaped content before digesting', () => {
    const secret = collectInjections([{ customType: 'x', content: 'key sk-abcdefghijkl' }]);
    const redacted = collectInjections([{ customType: 'x', content: 'key [redacted]' }]);

    expect(secret[0].digest).toBe(redacted[0].digest);
  });

  it('supports block content, limits results and ignores junk input', () => {
    const injections = collectInjections(
      [
        { customType: 'a', content: [{ text: 'aaaa' }] },
        { customType: 'b', content: 'b' },
        { customType: 'c', content: 'c' },
      ],
      2,
    );

    expect(injections.map((item) => item.customType)).toEqual(['b', 'c']);
    expect(collectInjections([{ customType: 'a', content: [{ text: 'aaaa' }] }])[0].chars).toBe(4);
    expect(collectInjections(undefined)).toEqual([]);
    expect(collectInjections([{ content: 'no customType' }])).toEqual([]);
    expect(collectInjections([{ customType: 'a', content: 'x' }], 0)).toEqual([]);
  });
});
