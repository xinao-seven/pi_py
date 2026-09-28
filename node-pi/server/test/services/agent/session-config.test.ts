/**
 * 会话预设配置的落盘/读回（`services/session-config.ts`）。
 *
 * 中文说明：这里是「极简会话重开之后还是极简」的地基——写出去的形状必须能被
 * 严格地读回来，认不出来的形状必须安全地退回「没有配置」。两个方向都测：
 * 正常 round-trip + 各种坏数据（手工改过、旧版本、未来版本、未知键）。
 */
import { describe, expect, it } from 'vitest';

import {
  SESSION_CONFIG_CUSTOM_TYPE,
  findSessionConfig,
  parseSessionConfig,
  sessionConfigOf,
} from '../../../src/services/agent/session-config.js';

const MINIMAL_EXTENSIONS = {
  approval: false,
  planMode: false,
  questions: false,
  subagents: false,
  tasks: false,
  observability: false,
  fileExtensions: false,
} as const;

/** 造一条 custom 条目（形状与 SDK 的 CustomEntry 一致）。 */
function customEntry(data: unknown, customType = SESSION_CONFIG_CUSTOM_TYPE): unknown {
  return { type: 'custom', customType, data };
}

describe('sessionConfigOf / parseSessionConfig', () => {
  it('只落盘显式给了的字段：极简配置 round-trip 后能力位与 MCP 禁用仍在', () => {
    const config = sessionConfigOf({
      extensions: { ...MINIMAL_EXTENSIONS },
      mcpServers: [],
    });

    expect(config).toEqual({ extensions: { ...MINIMAL_EXTENSIONS }, mcpServers: [] });
    expect(parseSessionConfig(config)).toEqual(config);
  });

  it('toolNames 缺省（不限制白名单）不落盘；给了就落盘并去重', () => {
    expect(sessionConfigOf({})).toEqual({});
    expect(sessionConfigOf({ toolNames: ['read', 'read', 'bash'] })).toEqual({
      toolNames: ['read', 'bash'],
    });
  });

  it('空串系统提示词不落盘（空串 = SDK 默认发现，不是“空提示词”）', () => {
    expect(sessionConfigOf({ systemPrompt: '' })).toEqual({});
    expect(sessionConfigOf({ systemPrompt: 'You are terse.' })).toEqual({
      systemPrompt: 'You are terse.',
    });
  });

  it('压缩策略原样落盘', () => {
    const compaction = { enabled: true, keepRecentTokens: 8000, reserveTokens: 16384 };
    expect(sessionConfigOf({ compaction })).toEqual({ compaction });
  });

  it('MCP 白名单：[] 有意义（禁用）必须落盘，去重后原样读回', () => {
    expect(sessionConfigOf({ mcpServers: [] }).mcpServers).toEqual([]);
    expect(sessionConfigOf({ mcpServers: ['web-search', 'web-search'] }).mcpServers).toEqual([
      'web-search',
    ]);
    // 不传 = 全部 server：不落盘，读回也是 undefined。
    expect(sessionConfigOf({}).mcpServers).toBeUndefined();
  });

  it('忽略未来版本新增的未知键（向前兼容），已知键照常解析', () => {
    const parsed = parseSessionConfig({
      extensions: { planMode: false, futureFlag: true },
      toolNames: ['read'],
      somethingNew: { nested: 1 },
    });
    expect(parsed).toEqual({
      extensions: { planMode: false },
      toolNames: ['read'],
    });
  });

  it('形状不认识就整份作废（回退全开，而不是半信半疑套一半）', () => {
    const broken: unknown[] = [
      'not-an-object',
      null,
      ['extensions'],
      { extensions: 'all' },
      { extensions: { planMode: 'yes' } },
      { toolNames: 'read' },
      { toolNames: ['read', 42] },
      { systemPrompt: 42 },
      { compaction: { enabled: true, keepRecentTokens: 8000 } },
      { compaction: { enabled: true, keepRecentTokens: 0, reserveTokens: 16384 } },
      { mcpServers: 'web-search' },
      { mcpServers: ['web-search', 7] },
    ];
    for (const value of broken) {
      expect(parseSessionConfig(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('空对象是合法配置（= 全部缺省）', () => {
    expect(parseSessionConfig({})).toEqual({});
  });
});

describe('findSessionConfig', () => {
  it('没有配置条目（CLI 建的旧会话）→ undefined', () => {
    expect(findSessionConfig([])).toBeUndefined();
    expect(findSessionConfig([{ type: 'message', message: { role: 'user' } }])).toBeUndefined();
  });

  it('只看 type: "custom"：同名的 custom_message（注入上下文）不算配置', () => {
    const entries = [
      { type: 'custom_message', customType: SESSION_CONFIG_CUSTOM_TYPE, content: '注入文本' },
    ];
    expect(findSessionConfig(entries)).toBeUndefined();
  });

  it('最后一条生效（若将来支持中途改能力位就靠这条口径）', () => {
    const entries = [
      customEntry({ extensions: { planMode: false } }),
      { type: 'message', message: { role: 'user' } },
      customEntry({ extensions: { planMode: true }, toolNames: ['read'] }),
    ];
    expect(findSessionConfig(entries)).toEqual({
      extensions: { planMode: true },
      toolNames: ['read'],
    });
  });

  it('别的扩展的 customType 不认（不抢官方 plan-mode 的状态）', () => {
    expect(findSessionConfig([customEntry({ plan: 'draft' }, 'plan-mode')])).toBeUndefined();
  });

  it('最新一条坏了就当作没有配置（不拿更旧的配置猜）', () => {
    const entries = [
      customEntry({ extensions: { planMode: false } }),
      customEntry({ extensions: 'broken' }),
    ];
    expect(findSessionConfig(entries)).toBeUndefined();
  });
});
