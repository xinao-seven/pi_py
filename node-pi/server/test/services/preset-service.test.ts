import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BUILTIN_PRESET_ID,
  PresetService,
  type PresetInput,
} from '../../src/services/preset-service.js';

describe('PresetService', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  function service(): { presets: PresetService; agentDir: string } {
    const agentDir = join(tmpdir(), 'pi-node-presets-test');
    temporaryDirectories.push(agentDir);
    return { presets: new PresetService(agentDir), agentDir };
  }

  function input(overrides: Partial<PresetInput> = {}): PresetInput {
    return {
      name: '激进',
      systemPrompt: 'You are a minimal coding agent.',
      toolNames: ['read', 'edit'],
      compaction: { enabled: true, keepRecentTokens: 8000, reserveTokens: 16384 },
      provider: '',
      modelId: '',
      thinkingLevel: 'high',
      mcpServers: null,
      ...overrides,
    };
  }

  it('lists the built-in coding-agent preset first with SDK default compaction', async () => {
    const { presets } = service();
    const list = await presets.list();

    expect(list[0]).toMatchObject({
      id: BUILTIN_PRESET_ID,
      builtin: true,
      name: 'Coding Agent（默认）',
      systemPrompt: '',
      toolNames: ['read', 'bash', 'edit', 'write'],
      compaction: { enabled: true, keepRecentTokens: 20000, reserveTokens: 16384 },
      provider: '',
      modelId: '',
      thinkingLevel: '',
      mcpServers: null,
    });
  });

  it('creates a custom preset that persists across service instances', async () => {
    const { presets, agentDir } = service();
    const created = await presets.create(input());
    expect(created.builtin).toBe(false);
    expect(created.id).toBeTruthy();

    const list = await presets.list();
    expect(list.map((item) => item.id)).toEqual([BUILTIN_PRESET_ID, created.id]);
    expect(list[1]).toMatchObject({
      name: '激进',
      systemPrompt: 'You are a minimal coding agent.',
      toolNames: ['read', 'edit'],
      compaction: { enabled: true, keepRecentTokens: 8000, reserveTokens: 16384 },
      thinkingLevel: 'high',
      builtin: false,
    });

    // 重启后（新实例）仍能从磁盘恢复。
    const restarted = new PresetService(agentDir);
    await expect(restarted.list()).resolves.toEqual(list);
  });

  it('updates a custom preset', async () => {
    const { presets } = service();
    const created = await presets.create(input());

    const updated = await presets.update(created.id, input({ name: '保守', thinkingLevel: 'low' }));

    expect(updated).toMatchObject({ id: created.id, name: '保守', thinkingLevel: 'low' });
    await expect(presets.list()).resolves.toMatchObject([
      { id: BUILTIN_PRESET_ID },
      { id: created.id, name: '保守', thinkingLevel: 'low' },
    ]);
  });

  it('rejects updates and deletes of the built-in preset', async () => {
    const { presets } = service();
    await expect(presets.update(BUILTIN_PRESET_ID, input())).rejects.toMatchObject({
      code: 'builtin_preset',
      statusCode: 400,
    });
    await expect(presets.delete(BUILTIN_PRESET_ID)).rejects.toMatchObject({
      code: 'builtin_preset',
      statusCode: 400,
    });
  });

  it('deletes a custom preset and rejects unknown ids', async () => {
    const { presets } = service();
    const created = await presets.create(input());
    await presets.delete(created.id);
    await expect(presets.list()).resolves.toHaveLength(1); // 只剩内置
    await expect(presets.delete('nope')).rejects.toMatchObject({
      code: 'preset_not_found',
      statusCode: 404,
    });
  });

  it('rejects invalid preset input with 422', async () => {
    const { presets } = service();
    const cases: unknown[] = [
      input({ name: '   ' }), // 空名称
      input({ compaction: { enabled: true, keepRecentTokens: -1, reserveTokens: 16384 } }),
      input({
        compaction: {
          enabled: 'yes' as unknown as boolean,
          keepRecentTokens: 8000,
          reserveTokens: 16384,
        },
      }),
      input({ provider: 'anthropic', modelId: '' }), // provider 与 modelId 不成对
      input({ thinkingLevel: 'turbo' }), // 非法思考等级
      input({ toolNames: ['read', 42] as unknown as string[] }),
      input({ mcpServers: 'web-search' as unknown as string[] }), // 必须是 null 或数组
      input({ mcpServers: [42] as unknown as string[] }),
    ];
    for (const bad of cases) {
      await expect(presets.create(bad)).rejects.toMatchObject({ code: 'validation_error' });
    }
  });

  it('normalizes, persists and round-trips the mcpServers whitelist', async () => {
    const { presets, agentDir } = service();
    // 缺省 → null（全部）；数组去重；空数组保持禁用语义。
    const all = await presets.create(input({ name: '全部' }));
    const custom = await presets.create(input({ name: '自选', mcpServers: ['b', 'a', 'b'] }));
    const none = await presets.create(input({ name: '禁用', mcpServers: [] }));

    expect(all.mcpServers).toBeNull();
    expect(custom.mcpServers).toEqual(['b', 'a']);
    expect(none.mcpServers).toEqual([]);

    // 重启后（新实例）从磁盘恢复时保留原值。
    const restarted = await new PresetService(agentDir).list();
    expect(restarted.find((preset) => preset.id === custom.id)?.mcpServers).toEqual(['b', 'a']);
    expect(restarted.find((preset) => preset.id === none.id)?.mcpServers).toEqual([]);
  });
});
