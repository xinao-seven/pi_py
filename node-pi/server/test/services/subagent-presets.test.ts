import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverSubagentPresets,
  findProjectAgentsDir,
  isReadOnlyPreset,
  loadPresetsFromDir,
} from '../../src/services/subagent-presets.js';

const tempDirs: string[] = [];

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writePreset(dir: string, fileName: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), content, 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('子 agent 预设发现', () => {
  it('reads frontmatter and body from *.md', () => {
    const agentDir = makeTemp('pi-agent-');
    writePreset(
      join(agentDir, 'agents'),
      'scout.md',
      [
        '---',
        'name: scout',
        'description: 快速侦察',
        'tools: read, grep, find, ls, bash',
        'model: claude-haiku-4-5',
        '---',
        '',
        '你是侦察兵。',
      ].join('\n'),
    );
    const presets = loadPresetsFromDir(join(agentDir, 'agents'), 'user');
    expect(presets).toHaveLength(1);
    expect(presets[0]).toMatchObject({
      name: 'scout',
      description: '快速侦察',
      tools: ['read', 'grep', 'find', 'ls', 'bash'],
      model: 'claude-haiku-4-5',
      source: 'user',
    });
    expect(presets[0].systemPrompt.trim()).toBe('你是侦察兵。');
  });

  it('skips files without name or description and non-markdown files', () => {
    const dir = join(makeTemp('pi-agent-'), 'agents');
    writePreset(dir, 'no-name.md', '---\ndescription: x\n---\nbody');
    writePreset(dir, 'no-description.md', '---\nname: x\n---\nbody');
    writePreset(dir, 'readme.txt', 'not markdown');
    writePreset(dir, 'worker.md', '---\nname: worker\ndescription: 干活\n---\nbody');
    expect(loadPresetsFromDir(dir, 'user').map((preset) => preset.name)).toEqual(['worker']);
  });

  it('returns no tools / no model when the frontmatter omits them', () => {
    const dir = join(makeTemp('pi-agent-'), 'agents');
    writePreset(dir, 'worker.md', '---\nname: worker\ndescription: 全能力\n---\nbody');
    const [preset] = loadPresetsFromDir(dir, 'user');
    expect(preset.tools).toBeUndefined();
    expect(preset.model).toBeUndefined();
  });

  it('merges user and project presets, project winning on同名', () => {
    const agentDir = makeTemp('pi-agent-');
    const cwd = makeTemp('pi-cwd-');
    writePreset(
      join(agentDir, 'agents'),
      'scout.md',
      '---\nname: scout\ndescription: 用户级\n---\nu',
    );
    writePreset(
      join(agentDir, 'agents'),
      'planner.md',
      '---\nname: planner\ndescription: 用户级\n---\np',
    );
    writePreset(
      join(cwd, '.pi', 'agents'),
      'scout.md',
      '---\nname: scout\ndescription: 项目级\n---\nw',
    );

    const presets = discoverSubagentPresets({ agentDir, cwd });
    expect(presets.map((preset) => preset.name)).toEqual(['planner', 'scout']);
    expect(presets.find((preset) => preset.name === 'scout')).toMatchObject({
      description: '项目级',
      source: 'project',
    });
  });

  it('finds the nearest project agents directory by walking up', () => {
    const root = makeTemp('pi-root-');
    const nested = join(root, 'packages', 'web', 'src');
    mkdirSync(nested, { recursive: true });
    writePreset(
      join(root, '.pi', 'agents'),
      'scout.md',
      '---\nname: scout\ndescription: d\n---\nb',
    );
    expect(findProjectAgentsDir(nested)).toBe(join(root, '.pi', 'agents'));
    expect(findProjectAgentsDir(root)).toBe(join(root, '.pi', 'agents'));
  });

  it('returns an empty list when there is no agents directory', () => {
    const agentDir = makeTemp('pi-agent-');
    const cwd = makeTemp('pi-cwd-');
    expect(discoverSubagentPresets({ agentDir, cwd })).toEqual([]);
    expect(findProjectAgentsDir(cwd)).toBeUndefined();
  });

  it('classifies read-only presets (for Plan mode gating)', () => {
    expect(isReadOnlyPreset({ tools: ['read', 'grep', 'find', 'ls'] } as never)).toBe(true);
    expect(isReadOnlyPreset({ tools: ['read', 'bash'] } as never)).toBe(false);
    // 没有 tools 字段 = 全部工具，当然不是只读
    expect(isReadOnlyPreset({} as never)).toBe(false);
    expect(isReadOnlyPreset({ tools: [] } as never)).toBe(false);
  });
});
