/**
 * compaction-policy 的单元测试：压缩触发点按模型 contextWindow 换算的纯函数行为。
 * 中文说明：背景是「1M 标称窗口 + SDK 缺省 reserve=16K ⇒ 实际永不压缩」的实测问题
 * （会话滚到 30-40 万 token）。策略：触发点 ≤200K、keepRecent 缺省 48K、
 * enabled=false 原样放行、keepRecent 病态配置夹到触发点内。
 */
import { describe, expect, it } from 'vitest';

import {
  COMPACTION_TRIGGER_TOKENS,
  PLATFORM_COMPACTION_DEFAULTS,
  resolveCompactionSettings,
} from '../../../src/services/agent/compaction-policy.js';

const MILLION = 1_000_000;

describe('resolveCompactionSettings', () => {
  it('caps the trigger point at 200K for a 1M-window model', () => {
    const resolved = resolveCompactionSettings(
      { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      MILLION,
    );
    // 触发点 = 1M - 800K = 200K（= COMPACTION_TRIGGER_TOKENS）。
    expect(resolved).toEqual({ enabled: true, reserveTokens: 800_000, keepRecentTokens: 20_000 });
    expect(MILLION - resolved.reserveTokens).toBe(COMPACTION_TRIGGER_TOKENS);
  });

  it('raises keepRecentTokens to the platform default when not configured', () => {
    const resolved = resolveCompactionSettings(PLATFORM_COMPACTION_DEFAULTS, MILLION);
    expect(resolved.reserveTokens).toBe(800_000);
    expect(resolved.keepRecentTokens).toBe(48_000);
  });

  it('keeps a more aggressive explicit reserve than the floor', () => {
    // 显式 reserve=900K（触发点 100K）比平台下限更激进：保留配置值。
    const resolved = resolveCompactionSettings(
      { enabled: true, reserveTokens: 900_000, keepRecentTokens: 20_000 },
      MILLION,
    );
    expect(resolved.reserveTokens).toBe(900_000);
  });

  it('leaves small-window models alone (floor does not apply)', () => {
    for (const contextWindow of [128_000, 200_000]) {
      const resolved = resolveCompactionSettings(
        { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
        contextWindow,
      );
      expect(resolved.reserveTokens).toBe(16_384);
      expect(resolved.keepRecentTokens).toBe(20_000);
    }
  });

  it('clamps a pathological keepRecentTokens below the trigger point', () => {
    // keep 250K > 触发点 200K：压缩会永远触发又压不掉多少 —— 夹到 触发点 - 16K。
    const resolved = resolveCompactionSettings(
      { enabled: true, reserveTokens: 16_384, keepRecentTokens: 250_000 },
      MILLION,
    );
    expect(resolved.keepRecentTokens).toBe(COMPACTION_TRIGGER_TOKENS - 16_384);
  });

  it('respects an explicit opt-out (enabled: false)', () => {
    const resolved = resolveCompactionSettings(
      { enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      MILLION,
    );
    // 不做任何窗口换算：关掉就是关掉。
    expect(resolved).toEqual({ enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 });
  });

  it('fills in defaults for missing fields and skips the floor without a context window', () => {
    const resolved = resolveCompactionSettings({ enabled: true }, undefined);
    expect(resolved).toEqual({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 48_000 });
  });
});
